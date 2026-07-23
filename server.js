/* =========================================================================
 * Lumio Studio — server
 *
 * StreamYard-style architecture:
 *
 *   host + guests (browsers) ⇄ WebRTC mesh (media never touches the server)
 *            ⇅ /ws  — signaling, roster/stage control, chat, viewer counts
 *
 *   host browser composites everyone on a canvas + Web Audio mixer, then:
 *   program feed ──WebM over /stream WS──▶ FFmpeg ──▶ HLS  (watch page, ∞ viewers)
 *                                                └──▶ RTMP(S) (YouTube / Facebook / custom)
 * ========================================================================= */

'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const express = require('express');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const HLS_ROOT = process.env.HLS_DIR || path.join(__dirname, '.hls');

const MAX_PARTICIPANTS = 10;   // host + guests connected to the studio mesh
const CHAT_HISTORY = 200;
const ROOM_TTL_MS = 12 * 60 * 60 * 1000; // idle rooms are collected after 12h

/* Destinations must be plain rtmp:// or rtmps:// URLs — nothing else ever
 * reaches the ffmpeg command line. */
const RTMP_RE = /^rtmps?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?\/[^\s"'|\\\[\]]+$/;
const ROOM_ID_RE = /^[a-z0-9]{10}$/;

fs.mkdirSync(HLS_ROOT, { recursive: true });

/* ------------------------------- rooms ------------------------------- */

/** @type {Map<string, Room>} */
const rooms = new Map();

function createRoom(title) {
  const id = crypto.randomBytes(8).toString('base64url').replace(/[^a-z0-9]/gi, '').toLowerCase().padEnd(10, '0').slice(0, 10);
  const room = {
    id,
    hostKey: crypto.randomBytes(16).toString('base64url'),
    title: String(title || 'Lumio broadcast').slice(0, 120),
    createdAt: Date.now(),
    lastActive: Date.now(),
    peers: new Map(),     // peerId -> { ws, role, name, onStage, camStreamId, screenStreamId }
    viewers: new Set(),   // ws
    chat: [],
    live: false,
    ffmpeg: null,
    mediaWs: null,
  };
  rooms.set(id, room);
  return room;
}

function touch(room) { room.lastActive = Date.now(); }

function roomHlsDir(room) { return path.join(HLS_ROOT, room.id); }

function publicRoster(room) {
  return [...room.peers.entries()].map(([peerId, p]) => ({
    peerId,
    role: p.role,
    name: p.name,
    onStage: p.onStage,
    camStreamId: p.camStreamId || null,
    screenStreamId: p.screenStreamId || null,
  }));
}

function sendTo(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function broadcastPeers(room, obj, exceptId = null) {
  for (const [peerId, p] of room.peers) {
    if (peerId !== exceptId) sendTo(p.ws, obj);
  }
}

function broadcastViewers(room, obj) {
  for (const ws of room.viewers) sendTo(ws, obj);
}

function broadcastAll(room, obj, exceptId = null) {
  broadcastPeers(room, obj, exceptId);
  broadcastViewers(room, obj);
}

function broadcastViewerCount(room) {
  const obj = { type: 'viewers', count: room.viewers.size };
  broadcastAll(room, obj);
}

function roomStatus(room) {
  return {
    type: 'status',
    live: room.live,
    title: room.title,
    viewers: room.viewers.size,
    participants: room.peers.size,
  };
}

/* Every 30 min, drop rooms nobody has touched in ROOM_TTL_MS. */
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    const empty = room.peers.size === 0 && room.viewers.size === 0 && !room.live;
    if (empty && now - room.lastActive > ROOM_TTL_MS) {
      rooms.delete(id);
      fs.rm(roomHlsDir(room), { recursive: true, force: true }, () => {});
    }
  }
}, 30 * 60 * 1000).unref();

/* ------------------------------- HTTP ------------------------------- */

const app = express();
app.use(express.json({ limit: '16kb' }));

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, ffmpeg: ffmpegAvailable(), rooms: rooms.size });
});

app.post('/api/rooms', (req, res) => {
  const room = createRoom(req.body && req.body.title);
  res.json({ id: room.id, hostKey: room.hostKey, title: room.title });
});

app.get('/api/rooms/:id', (req, res) => {
  const room = rooms.get(String(req.params.id));
  if (!room) return res.status(404).json({ exists: false });
  res.json({
    exists: true,
    id: room.id,
    title: room.title,
    live: room.live,
    viewers: room.viewers.size,
    participants: room.peers.size,
  });
});

/* HLS: playlists must never be cached; segments are immutable. */
app.use('/hls', (req, res, next) => {
  if (req.path.endsWith('.m3u8')) {
    res.set('Cache-Control', 'no-store');
    res.type('application/vnd.apple.mpegurl');
  } else if (req.path.endsWith('.ts')) {
    res.set('Cache-Control', 'public, max-age=60');
    res.type('video/mp2t');
  }
  next();
}, express.static(HLS_ROOT));

app.use(express.static(path.join(__dirname, 'public')));

/* Pretty routes → pages (room id validated client-side too). */
const page = f => (_req, res) => res.sendFile(path.join(__dirname, 'public', f));
app.get('/studio/:id', page('studio.html'));
app.get('/guest/:id', page('guest.html'));
app.get('/watch/:id', page('watch.html'));

function ffmpegAvailable() {
  try {
    return spawnSync(FFMPEG, ['-version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

/* --------------------------- FFmpeg relay --------------------------- */

function buildFfmpegArgs(room, rtmpUrls) {
  const dir = roomHlsDir(room);
  const args = [
    '-hide_banner', '-loglevel', 'warning',
    // WebM (VP8/VP9/H.264 + Opus) arrives on stdin as a live stream.
    '-i', 'pipe:0',
    '-map', '0:v:0', '-map', '0:a?',
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
    '-pix_fmt', 'yuv420p', '-profile:v', 'main',
    '-b:v', '3500k', '-maxrate', '4000k', '-bufsize', '8000k',
    '-g', '60', '-keyint_min', '60', '-r', '30',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2',
    '-flags', '+global_header',
  ];

  const hlsOpts = [
    'f=hls',
    'hls_time=2',
    'hls_list_size=6',
    'hls_flags=delete_segments+independent_segments',
    `hls_segment_filename=${path.join(dir, 'seg_%05d.ts')}`,
  ].join(':');
  const hlsOut = path.join(dir, 'live.m3u8');

  if (rtmpUrls.length === 0) {
    // Webinar-only: HLS is the single output.
    args.push('-f', 'hls',
      '-hls_time', '2', '-hls_list_size', '6',
      '-hls_flags', 'delete_segments+independent_segments',
      '-hls_segment_filename', path.join(dir, 'seg_%05d.ts'),
      hlsOut);
  } else {
    const tee = [
      `[${hlsOpts}]${hlsOut}`,
      ...rtmpUrls.map(u => `[f=flv:onfail=ignore]${u}`),
    ].join('|');
    args.push('-f', 'tee', tee);
  }
  return args;
}

function stopBroadcast(room, notify = true) {
  const proc = room.ffmpeg;
  room.ffmpeg = null;
  room.mediaWs = null;
  const wasLive = room.live;
  room.live = false;
  if (proc) {
    try { proc.stdin.end(); } catch { /* already closed */ }
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } }, 5000);
  }
  if (wasLive && notify) broadcastAll(room, { type: 'live', live: false });
  // Keep the last HLS segments around briefly so late viewers see the tail,
  // then clean up.
  setTimeout(() => {
    if (!room.live) fs.rm(roomHlsDir(room), { recursive: true, force: true }, () => {});
  }, 60 * 1000).unref();
}

/* --------------------------- WebSockets ---------------------------- */

const server = http.createServer(app);

const signalWss = new WebSocketServer({ noServer: true }); // /ws
const mediaWss = new WebSocketServer({ noServer: true });  // /stream

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://x');
  if (pathname === '/ws') {
    signalWss.handleUpgrade(req, socket, head, ws => signalWss.emit('connection', ws, req));
  } else if (pathname === '/stream') {
    mediaWss.handleUpgrade(req, socket, head, ws => mediaWss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

/* ---- /ws : signaling + roster + chat, for hosts, guests and viewers ---- */

signalWss.on('connection', ws => {
  let room = null;
  let peerId = null;
  let role = null; // 'host' | 'guest' | 'viewer'

  const fail = message => { sendTo(ws, { type: 'error', message }); ws.close(); };

  ws.on('message', data => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (typeof msg !== 'object' || !msg) return;

    /* ---------- join ---------- */
    if (msg.type === 'join' && !room) {
      const r = rooms.get(String(msg.room || ''));
      if (!r) return fail('This broadcast does not exist (or has ended).');
      role = msg.role === 'host' ? 'host' : msg.role === 'guest' ? 'guest' : 'viewer';

      if (role === 'host' && msg.hostKey !== r.hostKey) return fail('Invalid host key for this studio.');
      if (role !== 'viewer' && r.peers.size >= MAX_PARTICIPANTS) {
        return fail(`Studio is full (max ${MAX_PARTICIPANTS} participants).`);
      }

      room = r;
      touch(room);

      if (role === 'viewer') {
        room.viewers.add(ws);
        sendTo(ws, {
          type: 'joined', role, title: room.title, live: room.live,
          viewers: room.viewers.size, chat: room.chat.slice(-50),
        });
        broadcastViewerCount(room);
        return;
      }

      peerId = crypto.randomBytes(6).toString('base64url');
      const name = String(msg.name || (role === 'host' ? 'Host' : 'Guest')).slice(0, 40).trim() || 'Guest';
      room.peers.set(peerId, {
        ws, role, name,
        onStage: role === 'host', // host is always on stage; guests start backstage
        camStreamId: typeof msg.camStreamId === 'string' ? msg.camStreamId.slice(0, 80) : null,
        screenStreamId: null,
      });

      sendTo(ws, {
        type: 'joined', role, peerId, title: room.title, live: room.live,
        viewers: room.viewers.size,
        roster: publicRoster(room),
        chat: room.chat.slice(-50),
      });
      broadcastPeers(room, { type: 'peer-joined', peer: publicRoster(room).find(p => p.peerId === peerId) }, peerId);
      broadcastViewers(room, roomStatus(room));
      return;
    }

    if (!room) return;
    touch(room);

    /* ---------- chat (everyone) ---------- */
    if (msg.type === 'chat') {
      const p = peerId ? room.peers.get(peerId) : null;
      const name = p ? p.name : String(msg.name || 'Viewer').slice(0, 40).trim() || 'Viewer';
      const text = String(msg.text || '').slice(0, 500).trim();
      if (!text) return;
      const entry = { type: 'chat', from: role, name, text, ts: Date.now() };
      room.chat.push(entry);
      if (room.chat.length > CHAT_HISTORY) room.chat.splice(0, room.chat.length - CHAT_HISTORY);
      broadcastAll(room, entry);
      return;
    }

    /* ---------- participant messages ---------- */
    if (!peerId) return;

    if (msg.type === 'rtc' && typeof msg.to === 'string') {
      const target = room.peers.get(msg.to);
      if (target) sendTo(target.ws, { type: 'rtc', from: peerId, data: msg.data });
      return;
    }

    if (msg.type === 'media') {
      // Announce which MediaStream ids carry cam vs screen so receivers can
      // tell the tracks apart.
      const p = room.peers.get(peerId);
      if (!p) return;
      if ('camStreamId' in msg) p.camStreamId = typeof msg.camStreamId === 'string' ? msg.camStreamId.slice(0, 80) : null;
      if ('screenStreamId' in msg) p.screenStreamId = typeof msg.screenStreamId === 'string' ? msg.screenStreamId.slice(0, 80) : null;
      broadcastPeers(room, {
        type: 'peer-media', peerId,
        camStreamId: p.camStreamId, screenStreamId: p.screenStreamId,
      }, peerId);
      return;
    }

    if (msg.type === 'rename') {
      const p = room.peers.get(peerId);
      if (!p) return;
      p.name = String(msg.name || '').slice(0, 40).trim() || p.name;
      broadcastPeers(room, { type: 'peer-renamed', peerId, name: p.name });
      return;
    }

    /* ---------- host-only controls ---------- */
    if (role !== 'host') return;

    if (msg.type === 'stage' && typeof msg.peerId === 'string') {
      const p = room.peers.get(msg.peerId);
      if (!p) return;
      p.onStage = !!msg.onStage;
      broadcastPeers(room, { type: 'stage', peerId: msg.peerId, onStage: p.onStage });
      return;
    }

    if (msg.type === 'kick' && typeof msg.peerId === 'string') {
      const p = room.peers.get(msg.peerId);
      if (p && p.role !== 'host') {
        sendTo(p.ws, { type: 'kicked' });
        p.ws.close();
      }
      return;
    }

    if (msg.type === 'title') {
      room.title = String(msg.title || '').slice(0, 120) || room.title;
      broadcastAll(room, { type: 'title', title: room.title });
      return;
    }
  });

  ws.on('close', () => {
    if (!room) return;
    touch(room);
    if (role === 'viewer') {
      room.viewers.delete(ws);
      broadcastViewerCount(room);
      return;
    }
    if (peerId && room.peers.has(peerId)) {
      room.peers.delete(peerId);
      broadcastPeers(room, { type: 'peer-left', peerId });
      broadcastViewers(room, roomStatus(room));
      // Host leaving stops the broadcast — the program feed is gone.
      if (role === 'host' && room.live) stopBroadcast(room);
    }
  });

  ws.on('error', () => { /* handled by close */ });
});

/* ---- /stream : host program feed → FFmpeg → HLS + RTMP ---- */

mediaWss.on('connection', ws => {
  let room = null;
  let logTail = [];

  const send = obj => sendTo(ws, obj);

  const stop = () => { if (room && room.mediaWs === ws) stopBroadcast(room); };

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      if (room && room.ffmpeg && room.mediaWs === ws && room.ffmpeg.stdin.writable) {
        room.ffmpeg.stdin.write(data);
      }
      return;
    }

    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.type === 'start') {
      const r = rooms.get(String(msg.room || ''));
      if (!r) return send({ type: 'error', message: 'Unknown broadcast room.' });
      if (msg.hostKey !== r.hostKey) return send({ type: 'error', message: 'Only the host can start the broadcast.' });
      if (r.ffmpeg) return send({ type: 'error', message: 'This broadcast is already live.' });
      if (!ffmpegAvailable()) {
        return send({ type: 'error', message: 'FFmpeg is not installed on the server. Install ffmpeg and restart.' });
      }

      const rtmpUrls = (Array.isArray(msg.destinations) ? msg.destinations : [])
        .map(d => String(d).trim())
        .filter(d => RTMP_RE.test(d));

      room = r;
      touch(room);
      logTail = [];

      const dir = roomHlsDir(room);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });

      const ffmpeg = spawn(FFMPEG, buildFfmpegArgs(room, rtmpUrls), {
        stdio: ['pipe', 'ignore', 'pipe'],
      });
      room.ffmpeg = ffmpeg;
      room.mediaWs = ws;

      ffmpeg.stdin.on('error', () => { /* EPIPE when ffmpeg dies first */ });

      ffmpeg.stderr.on('data', chunk => {
        const line = chunk.toString().trim();
        if (!line) return;
        logTail = logTail.concat(line.split('\n')).slice(-30);
        send({ type: 'log', message: line });
      });

      ffmpeg.on('close', code => {
        const expected = room && room.ffmpeg === null;
        if (room && room.ffmpeg === ffmpeg) stopBroadcast(room);
        send({ type: 'ended', code, expected, log: logTail.slice(-10).join('\n') });
      });

      ffmpeg.on('error', err => {
        if (room) stopBroadcast(room, false);
        send({ type: 'error', message: `Failed to launch FFmpeg: ${err.message}` });
      });

      room.live = true;
      console.log(`[stream] ${room.id} live → HLS + ${rtmpUrls.length} RTMP destination(s)`);
      send({ type: 'started', destinations: rtmpUrls.length, hls: `/hls/${room.id}/live.m3u8` });
      broadcastAll(room, { type: 'live', live: true });
      return;
    }

    if (msg.type === 'stop') stop();
  });

  ws.on('close', stop);
  ws.on('error', stop);
});

/* ------------------------------- boot ------------------------------- */

server.listen(PORT, () => {
  console.log(`Lumio Studio running at http://localhost:${PORT}`);
  if (!ffmpegAvailable()) {
    console.warn('⚠ FFmpeg not found — install it (e.g. `apt install ffmpeg`) or set FFMPEG_PATH. ' +
      'The studio and guest mesh work without it; going live requires it.');
  }
});

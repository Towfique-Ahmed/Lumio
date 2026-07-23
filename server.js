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

/* Load .env (KEY=VALUE lines) before anything reads process.env. */
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* no .env — use real environment */ }

const express = require('express');
const { WebSocketServer } = require('ws');
const platforms = require('./lib/platforms');

const PORT = process.env.PORT || 3000;
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const HLS_ROOT = process.env.HLS_DIR || path.join(__dirname, '.hls');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '.data');
const BROADCAST_FILE = path.join(DATA_DIR, 'broadcasts.json');

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

function runtimeDefaults() {
  return {
    lastActive: Date.now(),
    peers: new Map(),     // peerId -> { ws, role, name, onStage, camStreamId, screenStreamId }
    viewers: new Set(),   // ws
    chat: [],
    live: false,
    preparing: false,
    ffmpeg: null,
    mediaWs: null,
    liveCleanups: [],
  };
}

/* Broadcast records survive restarts, StreamYard-dashboard style. Only the
 * durable fields are persisted; live state is runtime-only. */
function persistRooms() {
  const out = {};
  for (const [id, r] of rooms) {
    out[id] = {
      id, hostKey: r.hostKey, title: r.title, description: r.description || '',
      owner: r.owner || null, createdAt: r.createdAt,
    };
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(BROADCAST_FILE, JSON.stringify(out, null, 2), { mode: 0o600 });
}

function loadRooms() {
  try {
    const raw = JSON.parse(fs.readFileSync(BROADCAST_FILE, 'utf8'));
    for (const rec of Object.values(raw)) {
      rooms.set(rec.id, Object.assign({}, rec, runtimeDefaults()));
    }
    if (rooms.size) console.log(`[boot] restored ${rooms.size} broadcast(s)`);
  } catch { /* first run */ }
}
loadRooms();

function createRoom(title, description, owner) {
  const id = crypto.randomBytes(8).toString('base64url').replace(/[^a-z0-9]/gi, '').toLowerCase().padEnd(10, '0').slice(0, 10);
  const room = Object.assign({
    id,
    hostKey: crypto.randomBytes(16).toString('base64url'),
    title: String(title || 'Untitled broadcast').slice(0, 120),
    description: String(description || '').slice(0, 2000),
    owner: typeof owner === 'string' ? owner.slice(0, 64) : null,
    createdAt: Date.now(),
  }, runtimeDefaults());
  rooms.set(id, room);
  persistRooms();
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

/* Broadcast records are durable (dashboard); just sweep stale HLS output. */
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    const empty = room.peers.size === 0 && room.viewers.size === 0 && !room.live;
    if (empty && now - room.lastActive > ROOM_TTL_MS) {
      fs.rm(roomHlsDir(room), { recursive: true, force: true }, () => {});
    }
  }
}, 30 * 60 * 1000).unref();

/* ------------------------------- HTTP ------------------------------- */

const app = express();
app.set('trust proxy', true); // respect X-Forwarded-Proto behind nginx/hosting proxies
app.use(express.json({ limit: '16kb' }));

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, ffmpeg: ffmpegAvailable(), rooms: rooms.size });
});

/* ------------------------- OAuth destinations ------------------------- */

/* Which platform integrations have API credentials configured. Connect
 * buttons are always shown — unconfigured ones open the in-app setup wizard. */
app.get('/api/config', (_req, res) => {
  res.json({ youtube: platforms.configured.youtube, facebook: platforms.configured.facebook });
});

/* In-app setup wizard target: store API credentials pasted in the studio.
 * Open only while a platform is unconfigured (first-run); after that,
 * changes require ADMIN_KEY or editing .env on the server. */
app.post('/api/setup/:platform', (req, res) => {
  const p = req.params.platform;
  if (p !== 'youtube' && p !== 'facebook') return res.status(404).json({ error: 'Unknown platform.' });

  const { clientId, clientSecret, adminKey } = req.body || {};
  const adminOk = process.env.ADMIN_KEY && adminKey === process.env.ADMIN_KEY;
  if (platforms.configured[p] && !adminOk) {
    return res.status(403).json({ error: 'Already configured — change credentials in .env on the server (or pass ADMIN_KEY).' });
  }
  const id = String(clientId || '').trim();
  const secret = String(clientSecret || '').trim();
  if (!id || !secret) return res.status(400).json({ error: 'Both the client ID and the client secret are required.' });

  platforms.setCredentials(p, id, secret);
  console.log(`[setup] ${p} API credentials configured via in-app wizard`);
  res.json({ ok: true });
});

/* Short-lived CSRF states for the OAuth dance. */
const oauthStates = new Map(); // state -> expiry
setInterval(() => {
  const now = Date.now();
  for (const [s, exp] of oauthStates) if (exp < now) oauthStates.delete(s);
}, 60_000).unref();

function baseUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  let proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  // Public hosts are always HTTPS in practice (Google/Meta refuse plain-http
  // redirect URIs) — if a proxy hid the original scheme, assume https so the
  // redirect_uri matches what the operator registered.
  if (proto === 'http' && !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(String(host))) proto = 'https';
  return `${proto}://${host}`;
}

const redirectUri = (req, p) => `${baseUrl(req)}/auth/${p}/callback`;

app.get('/auth/:platform', (req, res) => {
  const p = req.params.platform;
  if (!platforms.configured[p]) return res.status(404).send('This platform is not configured on the server.');
  const state = crypto.randomBytes(16).toString('base64url');
  oauthStates.set(state, Date.now() + 10 * 60 * 1000);
  const uri = redirectUri(req, p);
  // If the platform reports redirect_uri_mismatch, this log line is the URI
  // that must be registered in the Google/Meta console, character for character.
  console.log(`[auth] ${p} start — redirect_uri: ${uri}`);
  const url = p === 'youtube'
    ? platforms.youtubeAuthUrl(uri, state)
    : platforms.facebookAuthUrl(uri, state);
  res.redirect(url);
});

/* The popup lands here; we hand the connection's public view to the studio
 * window via postMessage and close. Tokens never leave the server. */
app.get('/auth/:platform/callback', async (req, res) => {
  const p = req.params.platform;
  const finish = payload => {
    const json = JSON.stringify({ type: 'lumio-auth', ...payload }).replace(/</g, '\\u003c');
    res.send(`<!DOCTYPE html><meta charset="utf-8"><body style="background:#0b0716;color:#f3f0ff;font-family:sans-serif;display:grid;place-items:center;height:100vh">
<p>${payload.error ? 'Connection failed — you can close this window.' : 'Connected! You can close this window.'}</p>
<script>
  if (window.opener) window.opener.postMessage(${json}, location.origin);
  setTimeout(() => window.close(), ${payload.error ? 4000 : 800});
</script>`);
  };

  try {
    if (!platforms.configured[p]) throw new Error('Platform not configured.');
    if (!oauthStates.delete(String(req.query.state || ''))) throw new Error('Invalid or expired auth state — try again.');
    if (req.query.error) throw new Error(String(req.query.error_description || req.query.error));
    const code = String(req.query.code || '');
    if (!code) throw new Error('Missing authorization code.');

    const conn = p === 'youtube'
      ? await platforms.youtubeExchangeCode(code, redirectUri(req, 'youtube'))
      : await platforms.facebookExchangeCode(code, redirectUri(req, 'facebook'));

    console.log(`[auth] connected ${p}: ${conn.name}`);
    finish({ platform: p, connection: platforms.publicView(conn) });
  } catch (e) {
    console.warn(`[auth] ${p} failed: ${e.message}`);
    finish({ platform: p, error: e.message });
  }
});

app.get('/api/connections/:id', (req, res) => {
  const conn = platforms.getConnection(req.params.id);
  if (!conn) return res.status(404).json({ exists: false });
  res.json({ exists: true, connection: platforms.publicView(conn) });
});

app.delete('/api/connections/:id', (req, res) => {
  res.json({ deleted: platforms.deleteConnection(req.params.id) });
});

app.post('/api/rooms', (req, res) => {
  const b = req.body || {};
  const room = createRoom(b.title, b.description, b.owner);
  res.json({ id: room.id, hostKey: room.hostKey, title: room.title });
});

/* Dashboard: list/delete this browser's broadcasts (matched by owner token). */
app.get('/api/broadcasts', (req, res) => {
  const owner = String(req.query.owner || '');
  if (!owner) return res.json({ broadcasts: [] });
  const list = [...rooms.values()]
    .filter(r => r.owner === owner)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(r => ({
      id: r.id, title: r.title, description: r.description || '',
      live: r.live, createdAt: r.createdAt,
      participants: r.peers.size, viewers: r.viewers.size,
    }));
  res.json({ broadcasts: list });
});

app.delete('/api/broadcasts/:id', (req, res) => {
  const room = rooms.get(String(req.params.id));
  if (!room) return res.status(404).json({ error: 'Not found.' });
  if (!room.owner || room.owner !== String(req.query.owner || '')) {
    return res.status(403).json({ error: 'Not your broadcast.' });
  }
  if (room.live) return res.status(409).json({ error: 'Broadcast is live — end it first.' });
  for (const p of room.peers.values()) { try { p.ws.close(); } catch { /* ok */ } }
  for (const v of room.viewers) { try { v.close(); } catch { /* ok */ } }
  rooms.delete(room.id);
  persistRooms();
  fs.rm(roomHlsDir(room), { recursive: true, force: true }, () => {});
  res.json({ ok: true });
});

app.get('/api/rooms/:id', (req, res) => {
  const room = rooms.get(String(req.params.id));
  if (!room) return res.status(404).json({ exists: false });
  res.json({
    exists: true,
    id: room.id,
    title: room.title,
    description: room.description || '',
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
app.get('/dashboard', page('dashboard.html'));
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

/** Turn the studio's destination list into concrete RTMP URLs.
 *  OAuth destinations are prepared through the platform APIs right now —
 *  this is the "click Go Live and YouTube/Facebook just happen" step. */
async function resolveDestinations(list) {
  const urls = [], outputs = [], cleanups = [], failures = [];

  for (const d of Array.isArray(list) ? list : []) {
    // Legacy / manual entries: plain RTMP(S) URLs.
    if (typeof d === 'string' || (d && d.kind === 'rtmp')) {
      const url = String(typeof d === 'string' ? d : d.url).trim();
      if (RTMP_RE.test(url)) {
        urls.push(url);
        outputs.push({ platform: (d && d.label) || 'rtmp', watchUrl: null });
      } else {
        failures.push({ label: (d && d.label) || 'RTMP', error: 'Invalid RTMP URL.' });
      }
      continue;
    }
    if (!d || typeof d !== 'object') continue;

    const conn = platforms.getConnection(d.connId);
    try {
      if (d.kind === 'youtube') {
        if (!conn || conn.platform !== 'youtube') throw new Error('YouTube connection not found — reconnect the channel.');
        const prep = await platforms.youtubePrepare(conn, { title: d.title, privacy: d.privacy });
        urls.push(prep.rtmpUrl);
        outputs.push({ platform: 'youtube', label: conn.name, watchUrl: prep.watchUrl });
        cleanups.push({ platform: 'youtube', connId: conn.id, broadcastId: prep.broadcastId });
      } else if (d.kind === 'facebook') {
        if (!conn || conn.platform !== 'facebook') throw new Error('Facebook connection not found — reconnect the account.');
        const prep = await platforms.facebookPrepare(conn, { id: d.targetId }, { title: d.title, description: d.description });
        urls.push(prep.rtmpUrl);
        outputs.push({ platform: 'facebook', label: conn.name, watchUrl: prep.watchUrl });
        cleanups.push({ platform: 'facebook', connId: conn.id, videoId: prep.videoId, targetId: prep.targetId });
      }
    } catch (e) {
      failures.push({ label: `${d.kind}${conn ? ` (${conn.name})` : ''}`, error: e.message });
    }
  }
  return { urls, outputs, cleanups, failures };
}

function runCleanups(cleanups) {
  for (const c of cleanups || []) {
    const conn = platforms.getConnection(c.connId);
    if (!conn) continue;
    if (c.platform === 'youtube') platforms.youtubeEnd(conn, c.broadcastId);
    if (c.platform === 'facebook') platforms.facebookEnd(conn, c.videoId, c.targetId);
  }
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
  runCleanups(room.liveCleanups);
  room.liveCleanups = [];
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
          viewers: room.viewers.size,
          chat: room.chat.filter(m => m.scope !== 'studio').slice(-50),
        });
        broadcastViewerCount(room);
        return;
      }

      peerId = crypto.randomBytes(6).toString('base64url');
      const name = String(msg.name || (role === 'host' ? 'Host' : 'Guest')).slice(0, 40).trim() || 'Guest';
      room.peers.set(peerId, {
        ws, role, name,
        // Everyone — including the host — starts off-stage and clicks
        // "Add to stage", exactly like StreamYard.
        onStage: false,
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

    /* ---------- chat ----------
     * Two scopes, like StreamYard: 'public' = Comments everyone sees
     * (viewers included); 'studio' = Private chat between host & guests. */
    if (msg.type === 'chat') {
      const p = peerId ? room.peers.get(peerId) : null;
      const name = p ? p.name : String(msg.name || 'Viewer').slice(0, 40).trim() || 'Viewer';
      const text = String(msg.text || '').slice(0, 500).trim();
      if (!text) return;
      const scope = msg.scope === 'studio' && role !== 'viewer' ? 'studio' : 'public';
      const entry = { type: 'chat', from: role, name, text, scope, ts: Date.now() };
      room.chat.push(entry);
      if (room.chat.length > CHAT_HISTORY) room.chat.splice(0, room.chat.length - CHAT_HISTORY);
      if (scope === 'studio') broadcastPeers(room, entry);
      else broadcastAll(room, entry);
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
      persistRooms();
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
      if (r.ffmpeg || r.preparing) return send({ type: 'error', message: 'This broadcast is already live.' });
      if (!ffmpegAvailable()) {
        return send({ type: 'error', message: 'FFmpeg is not installed on the server. Install ffmpeg and restart.' });
      }

      r.preparing = true;
      (async () => {
        // Prepare OAuth destinations (create YouTube broadcast, Facebook
        // live video) and collect every RTMP ingest to push to.
        const resolved = await resolveDestinations(msg.destinations);
        r.preparing = false;

        for (const f of resolved.failures) {
          send({ type: 'log', message: `✗ ${f.label}: ${f.error}` });
        }
        if (ws.readyState !== ws.OPEN) { runCleanups(resolved.cleanups); return; }

        room = r;
        touch(room);
        logTail = [];
        room.liveCleanups = resolved.cleanups;

        const dir = roomHlsDir(room);
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true });

        const ffmpeg = spawn(FFMPEG, buildFfmpegArgs(room, resolved.urls), {
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
        console.log(`[stream] ${room.id} live → HLS + ${resolved.urls.length} RTMP destination(s)`);
        send({
          type: 'started',
          destinations: resolved.urls.length,
          outputs: resolved.outputs,
          failures: resolved.failures,
          hls: `/hls/${room.id}/live.m3u8`,
        });
        broadcastAll(room, { type: 'live', live: true });
      })().catch(e => {
        r.preparing = false;
        send({ type: 'error', message: `Could not start the broadcast: ${e.message}` });
      });
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

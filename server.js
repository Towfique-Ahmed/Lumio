/* =========================================================================
 * Lumio Studio — server
 *
 * Two responsibilities, one process:
 *
 *  1. WebRTC signaling (WS /rtc) — a mesh signaling relay + room roster so
 *     the host and guests can see and hear each other in real time. The
 *     media itself flows peer-to-peer; only SDP/ICE and presence pass here.
 *
 *  2. Broadcast relay (WS /stream) — the host composites everyone onto a
 *     canvas, records it with MediaRecorder (WebM) and streams the chunks
 *     here. FFmpeg transcodes to H.264/AAC and pushes RTMP(S) to every
 *     enabled destination at once (YouTube / Facebook / custom) via tee.
 *
 *     host studio ─┬─ WebRTC mesh ─ guests
 *                  └─ canvas → WebM/WS → ffmpeg → rtmp(s) → YouTube/Facebook/…
 * ========================================================================= */

'use strict';

const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const express = require('express');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

/* Only plain rtmp:// / rtmps:// URLs ever reach the ffmpeg command line. */
const RTMP_RE = /^rtmps?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?\/[^\s"'|\\]+$/;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (_req, res) => res.json({ ok: true, ffmpeg: ffmpegAvailable() }));

function ffmpegAvailable() {
  try { return spawnSync(FFMPEG, ['-version'], { stdio: 'ignore' }).status === 0; }
  catch { return false; }
}

const server = http.createServer(app);

/* =========================================================================
 * 1. WebRTC signaling + rooms
 * ========================================================================= */

const sigWss = new WebSocketServer({ noServer: true });

/** room id -> { peers: Map<id,peer>, brand } */
const rooms = new Map();

function getRoom(id) {
  if (!rooms.has(id)) rooms.set(id, { peers: new Map(), brand: null });
  return rooms.get(id);
}

function rosterOf(room) {
  return [...room.peers.values()].map(p => ({
    id: p.id, name: p.name, role: p.role,
    onstage: p.onstage, mic: p.mic, cam: p.cam,
    camStreamId: p.camStreamId, screenStreamId: p.screenStreamId,
  }));
}

function sendTo(peer, obj) {
  if (peer.ws.readyState === peer.ws.OPEN) peer.ws.send(JSON.stringify(obj));
}

function broadcast(room, obj, exceptId) {
  for (const p of room.peers.values()) if (p.id !== exceptId) sendTo(p, obj);
}

function pushRoster(room) {
  broadcast(room, { type: 'roster', roster: rosterOf(room) });
}

sigWss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const roomId = (url.searchParams.get('room') || '').slice(0, 64) || 'main';
  const role = url.searchParams.get('role') === 'host' ? 'host' : 'guest';
  const name = (url.searchParams.get('name') || 'Guest').slice(0, 40);

  const room = getRoom(roomId);

  // First host onstage; guests start in the backstage (greenroom).
  const isFirstHost = role === 'host' && ![...room.peers.values()].some(p => p.role === 'host');
  const peer = {
    id: crypto.randomBytes(6).toString('hex'),
    ws, name, role,
    onstage: role === 'host',
    mic: true, cam: true,
    camStreamId: null, screenStreamId: null,
  };
  room.peers.set(peer.id, peer);

  // Tell the newcomer who it is and who is already here.
  sendTo(peer, {
    type: 'welcome',
    id: peer.id, role: peer.role, onstage: peer.onstage,
    roster: rosterOf(room).filter(p => p.id !== peer.id),
    brand: room.brand,
  });
  // Tell everyone else about the newcomer.
  broadcast(room, { type: 'join', peer: rosterOf(room).find(p => p.id === peer.id) }, peer.id);

  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.type) {
      case 'signal': { // relay SDP/ICE to a single peer
        const dst = room.peers.get(msg.to);
        if (dst) sendTo(dst, { type: 'signal', from: peer.id, data: msg.data });
        break;
      }
      case 'state': { // own mic/cam/stream-id state
        if (typeof msg.mic === 'boolean') peer.mic = msg.mic;
        if (typeof msg.cam === 'boolean') peer.cam = msg.cam;
        if ('camStreamId' in msg) peer.camStreamId = msg.camStreamId;
        if ('screenStreamId' in msg) peer.screenStreamId = msg.screenStreamId;
        pushRoster(room);
        break;
      }
      case 'stage': { // host moves a peer on/off stage
        if (peer.role !== 'host') break;
        const target = room.peers.get(msg.id);
        if (target) { target.onstage = !!msg.onstage; pushRoster(room); }
        break;
      }
      case 'kick': { // host removes a guest
        if (peer.role !== 'host') break;
        const target = room.peers.get(msg.id);
        if (target && target.role !== 'host') {
          sendTo(target, { type: 'kicked' });
          target.ws.close();
        }
        break;
      }
      case 'brand': { // host updates shared branding (for guest welcome page)
        if (peer.role !== 'host') break;
        room.brand = msg.brand || null;
        broadcast(room, { type: 'brand', brand: room.brand }, peer.id);
        break;
      }
      case 'chat': { // backstage chat for the whole room
        const text = String(msg.text || '').slice(0, 500);
        if (text) broadcast(room, { type: 'chat', from: peer.id, name: peer.name, text, ts: Date.now() });
        break;
      }
    }
  });

  const leave = () => {
    room.peers.delete(peer.id);
    if (room.peers.size === 0) rooms.delete(roomId);
    else broadcast(room, { type: 'leave', id: peer.id });
  };
  ws.on('close', leave);
  ws.on('error', leave);
});

/* =========================================================================
 * 2. Broadcast relay → FFmpeg → RTMP
 * ========================================================================= */

const streamWss = new WebSocketServer({ noServer: true });

function buildFfmpegArgs(destinations) {
  const args = [
    '-hide_banner', '-loglevel', 'warning',
    '-i', 'pipe:0',
    '-map', '0:v:0', '-map', '0:a?',
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
    '-pix_fmt', 'yuv420p', '-profile:v', 'main',
    '-b:v', '3500k', '-maxrate', '4000k', '-bufsize', '8000k',
    '-g', '60', '-keyint_min', '60', '-r', '30',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2',
    '-flags', '+global_header',
  ];
  if (destinations.length === 1) args.push('-f', 'flv', destinations[0]);
  else args.push('-f', 'tee', destinations.map(d => `[f=flv:onfail=ignore]${d}`).join('|'));
  return args;
}

streamWss.on('connection', ws => {
  let ffmpeg = null;
  let logTail = [];
  const send = obj => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); };

  const stopFfmpeg = () => {
    if (!ffmpeg) return;
    const proc = ffmpeg; ffmpeg = null;
    try { proc.stdin.end(); } catch { /* closed */ }
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } }, 5000);
  };

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      if (ffmpeg && ffmpeg.stdin.writable) ffmpeg.stdin.write(data);
      return;
    }
    let msg; try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.type === 'start') {
      if (ffmpeg) { send({ type: 'error', message: 'Stream already running.' }); return; }
      const destinations = (Array.isArray(msg.destinations) ? msg.destinations : [])
        .map(d => String(d).trim()).filter(d => RTMP_RE.test(d));
      if (!destinations.length) { send({ type: 'error', message: 'No valid RTMP/RTMPS destinations.' }); return; }
      if (!ffmpegAvailable()) { send({ type: 'error', message: 'FFmpeg is not installed on the server.' }); return; }

      logTail = [];
      ffmpeg = spawn(FFMPEG, buildFfmpegArgs(destinations), { stdio: ['pipe', 'ignore', 'pipe'] });
      ffmpeg.stdin.on('error', () => { /* EPIPE */ });
      ffmpeg.stderr.on('data', chunk => {
        const line = chunk.toString().trim();
        if (!line) return;
        logTail = logTail.concat(line.split('\n')).slice(-30);
        send({ type: 'log', message: line });
      });
      ffmpeg.on('close', code => {
        const wasRunning = ffmpeg !== null; ffmpeg = null;
        send({ type: 'ended', code, expected: !wasRunning, log: logTail.slice(-10).join('\n') });
      });
      ffmpeg.on('error', err => { ffmpeg = null; send({ type: 'error', message: `Failed to launch FFmpeg: ${err.message}` }); });

      console.log(`[stream] live → ${destinations.length} destination(s)`);
      send({ type: 'started', destinations: destinations.length });
      return;
    }
    if (msg.type === 'stop') stopFfmpeg();
  });

  ws.on('close', stopFfmpeg);
  ws.on('error', stopFfmpeg);
});

/* ---- route the two WS endpoints ---- */
server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://x');
  if (pathname === '/rtc') sigWss.handleUpgrade(req, socket, head, ws => sigWss.emit('connection', ws, req));
  else if (pathname === '/stream') streamWss.handleUpgrade(req, socket, head, ws => streamWss.emit('connection', ws, req));
  else socket.destroy();
});

server.listen(PORT, () => {
  console.log(`Lumio Studio running at http://localhost:${PORT}`);
  if (!ffmpegAvailable()) console.warn('⚠ FFmpeg not found — install it or set FFMPEG_PATH.');
});

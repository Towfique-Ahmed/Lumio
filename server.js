/* =========================================================================
 * Lumio Studio — streaming relay server
 *
 * The browser studio composes the program feed (canvas + Web Audio),
 * encodes it with MediaRecorder (WebM) and ships the chunks here over a
 * WebSocket. This server pipes them into FFmpeg, which transcodes to
 * H.264/AAC and pushes RTMP(S) to every enabled destination at once
 * (YouTube, Facebook, custom) via the tee muxer.
 *
 *   browser (canvas+mic) ──WebM/WS──▶ server ──▶ ffmpeg ──▶ rtmp(s)://…
 * ========================================================================= */

'use strict';

const http = require('http');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const express = require('express');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

/* Destinations must be plain rtmp:// or rtmps:// URLs — nothing else ever
 * reaches the ffmpeg command line. */
const RTMP_RE = /^rtmps?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?\/[^\s"'|\\]+$/;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, ffmpeg: ffmpegAvailable() });
});

function ffmpegAvailable() {
  try {
    return spawnSync(FFMPEG, ['-version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

/* ---------------------------------------------------------------------- */

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/stream' });

function buildFfmpegArgs(destinations) {
  const args = [
    '-hide_banner', '-loglevel', 'warning',
    // WebM (VP8/VP9 or H.264 + Opus) arrives on stdin as a live stream.
    '-i', 'pipe:0',
    '-map', '0:v:0', '-map', '0:a?',
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
    '-pix_fmt', 'yuv420p', '-profile:v', 'main',
    '-b:v', '3500k', '-maxrate', '4000k', '-bufsize', '8000k',
    '-g', '60', '-keyint_min', '60', '-r', '30',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2',
    '-flags', '+global_header',
  ];
  if (destinations.length === 1) {
    args.push('-f', 'flv', destinations[0]);
  } else {
    const tee = destinations.map(d => `[f=flv:onfail=ignore]${d}`).join('|');
    args.push('-f', 'tee', tee);
  }
  return args;
}

wss.on('connection', ws => {
  let ffmpeg = null;
  let logTail = [];

  const send = obj => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  };

  const stopFfmpeg = () => {
    if (!ffmpeg) return;
    const proc = ffmpeg;
    ffmpeg = null;
    try { proc.stdin.end(); } catch { /* already closed */ }
    // Give ffmpeg a moment to flush the stream, then make sure it exits.
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } }, 5000);
  };

  ws.on('message', (data, isBinary) => {
    /* Binary frames are media chunks for ffmpeg's stdin. */
    if (isBinary) {
      if (ffmpeg && ffmpeg.stdin.writable) ffmpeg.stdin.write(data);
      return;
    }

    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.type === 'start') {
      if (ffmpeg) { send({ type: 'error', message: 'Stream already running on this connection.' }); return; }

      const destinations = (Array.isArray(msg.destinations) ? msg.destinations : [])
        .map(d => String(d).trim())
        .filter(d => RTMP_RE.test(d));

      if (destinations.length === 0) {
        send({ type: 'error', message: 'No valid RTMP/RTMPS destinations provided.' });
        return;
      }
      if (!ffmpegAvailable()) {
        send({ type: 'error', message: 'FFmpeg is not installed on the server. Install ffmpeg and restart.' });
        return;
      }

      logTail = [];
      ffmpeg = spawn(FFMPEG, buildFfmpegArgs(destinations), {
        stdio: ['pipe', 'ignore', 'pipe'],
      });

      ffmpeg.stdin.on('error', () => { /* EPIPE when ffmpeg dies first */ });

      ffmpeg.stderr.on('data', chunk => {
        const line = chunk.toString().trim();
        if (!line) return;
        logTail = logTail.concat(line.split('\n')).slice(-30);
        send({ type: 'log', message: line });
      });

      ffmpeg.on('close', code => {
        const wasRunning = ffmpeg !== null;
        ffmpeg = null;
        send({
          type: 'ended',
          code,
          expected: !wasRunning,
          log: logTail.slice(-10).join('\n'),
        });
      });

      ffmpeg.on('error', err => {
        ffmpeg = null;
        send({ type: 'error', message: `Failed to launch FFmpeg: ${err.message}` });
      });

      console.log(`[stream] live → ${destinations.length} destination(s)`);
      send({ type: 'started', destinations: destinations.length });
      return;
    }

    if (msg.type === 'stop') {
      console.log('[stream] stop requested');
      stopFfmpeg();
    }
  });

  ws.on('close', stopFfmpeg);
  ws.on('error', stopFfmpeg);
});

/* ---------------------------------------------------------------------- */

server.listen(PORT, () => {
  console.log(`Lumio Studio running at http://localhost:${PORT}`);
  if (!ffmpegAvailable()) {
    console.warn('⚠ FFmpeg not found — install it (e.g. `apt install ffmpeg`) or set FFMPEG_PATH.');
  }
});

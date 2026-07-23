# Lumio Studio 🎥

**A StreamYard-style live streaming studio that runs in your browser** — capture your
camera, microphone and screen, compose a branded scene, and broadcast live to
**YouTube**, **Facebook** and any custom RTMP server, all at once.

```
browser studio ──WebM over WebSocket──▶ Node server ──▶ FFmpeg ──▶ RTMP(S)
(camera / mic / screen → canvas + audio mixer)              ├─▶ YouTube Live
                                                            ├─▶ Facebook Live
                                                            └─▶ Custom RTMP
```

## ✨ Features

- **In-browser studio** — camera + microphone capture with device pickers,
  one-click screen sharing (with tab/system audio when available).
- **Scene compositor** — four layouts rendered live on a 720p/30fps canvas:
  - **Solo** — camera full-frame
  - **Screen** — screen share full-frame
  - **PiP** — screen with a camera bubble
  - **Split** — screen and camera side by side
- **Branding** — lower-third name banner, headline/title bar, brand color,
  camera mirroring, and an automatic "camera off" avatar card.
- **Audio mixer** — Web Audio graph mixing your mic with screen-share audio,
  live VU meter, one-click mute.
- **Multistreaming** — add YouTube, Facebook and custom RTMP destinations,
  toggle each on/off, and broadcast to all enabled ones simultaneously
  (FFmpeg `tee` muxer, `onfail=ignore` so one bad destination doesn't kill the rest).
- **Local recording** — optionally save a WebM recording of your program feed
  while you stream.
- **Live status** — LIVE badge + timer burned into the program feed, connection
  state, and a live FFmpeg log panel in the sidebar.

## 🚀 Getting started

Requirements: **Node.js ≥ 18** and **FFmpeg** on the machine running the server.

```bash
# 1. Install FFmpeg (skip if you have it)
sudo apt install ffmpeg        # Debian/Ubuntu
brew install ffmpeg            # macOS

# 2. Install and run
npm install
npm start                      # → http://localhost:3000
```

> **Note on HTTPS:** browsers only allow camera/screen capture on `localhost` or
> HTTPS origins. For anything beyond local use, put the server behind TLS
> (Caddy, nginx + Let's Encrypt, or a platform that terminates TLS for you).
> The WebSocket automatically upgrades to `wss://` on HTTPS pages.

## 📡 Going live

1. Open the studio, allow camera/mic, and enter your display name.
2. In **Destinations**, add your platforms:
   - **YouTube** — YouTube Studio → *Go live* → *Stream* → copy the **Stream key**.
     Lumio pushes to the RTMPS ingest `rtmps://a.rtmps.youtube.com:443/live2/KEY`.
   - **Facebook** — facebook.com/live/producer → *Go live* → *Streaming software* →
     copy the **Stream key**. Lumio pushes to
     `rtmps://live-api-s.facebook.com:443/rtmp/KEY`.
   - **Custom RTMP** — paste a full `rtmp://` or `rtmps://` URL (Twitch, restream
     servers, nginx-rtmp, …).
3. Set up your scene (layout, screen share, branding) — the canvas preview **is**
   the program feed your viewers will see.
4. Press **Go Live**. Start the broadcast on the platform side if it doesn't
   auto-start (YouTube goes live automatically once it receives data; Facebook
   shows a preview you confirm).

Stream keys are stored in your browser's `localStorage` and are only ever sent
to **your own** Lumio server, which passes them straight to FFmpeg.

## 🧠 How it works

| Stage | Technology |
| --- | --- |
| Capture | `getUserMedia` (cam/mic), `getDisplayMedia` (screen + audio) |
| Compositing | `<canvas>` 1280×720 @ 30fps — layouts, banners, LIVE badge |
| Audio mix | Web Audio API → `MediaStreamAudioDestinationNode` |
| Encoding (browser) | `canvas.captureStream()` + `MediaRecorder` (WebM, H.264/VP9/VP8 + Opus, ~3.5 Mbps) |
| Transport | Binary WebSocket chunks (500 ms) to the Node server |
| Encoding (server) | FFmpeg: `libx264 veryfast zerolatency` + AAC 160k, GOP 2s |
| Delivery | `-f flv` single output, or `-f tee` for simultaneous multistreaming |

Browsers can't speak RTMP, so a relay hop is mandatory — this is the same
architecture StreamYard, Restream Studio and similar tools use (they relay via
their cloud; Lumio relays via your own server).

## 📁 Project structure

```
├── server.js              # Express + WebSocket relay → FFmpeg → RTMP(S)
├── package.json
└── public/
    ├── index.html         # Setup gate + studio UI
    ├── css/studio.css
    ├── img/favicon.svg
    └── js/studio.js       # Capture, compositor, mixer, recorder, transport
```

## ⚠️ Limitations

- Single-host studio (no remote guests yet — that requires WebRTC SFU
  infrastructure; natural v2 territory).
- The relay server transcodes with x264 `veryfast`; budget ~1–2 CPU cores per
  concurrent stream, or point `FFMPEG_PATH` at a build with hardware encoders.
- Platforms require the stream to be **started/confirmed** on their side
  (YouTube auto-detects; Facebook asks you to confirm the preview).

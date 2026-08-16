# Lumio Studio 🎥

**A StreamYard-style live streaming studio that runs entirely in the browser.**
Invite guests over WebRTC, compose a branded multi-person scene, and multistream
live to **YouTube**, **Facebook** and any custom RTMP destination — no downloads,
no accounts.

```
 host browser ─┬─────── WebRTC mesh ───────┬─ guest browser
               │  (camera / mic / screen)   │  (camera / mic / screen)
               │                            └─ guest browser …
               │
   canvas compositor + audio mixer
               │
      WebM over WebSocket
               │
        Node relay ── FFmpeg ──┬─▶ YouTube Live   (rtmps)
                               ├─▶ Facebook Live  (rtmps)
                               └─▶ Custom RTMP    (Twitch, X, …)
```

This mirrors how StreamYard works — a browser studio, a WebRTC layer that brings
in remote guests, cloud-side compositing, and one encode fanned out to many
platforms ([how multistreaming works](https://streamyard.com/blog/how-multistreaming-works-technology-explained)).
The difference: Lumio runs on **your own** server instead of a hosted cloud.

## ✨ Features

- **Multi-guest studio (WebRTC mesh)** — invite guests with a link; they join
  from any browser, see and hear each other, and appear in the broadcast.
- **Greenroom / backstage** — guests wait off-air until the host adds them to
  the stage; the host can remove guests or drop them back to the greenroom.
- **Scene layouts** — Auto grid, Solo spotlight, Screen only, Screen + camera
  (PiP), and News (screen + people sidebar), switchable in one click.
- **Screen sharing** — from the host or any guest, with audio.
- **Branding** — headline title bar, brand color, uploaded logo (top-right),
  custom background image, and camera mirroring.
- **Lower-third banners & ticker** — add name/title banners and put one on air;
  scroll a ticker message along the bottom.
- **Multistreaming** — YouTube, Facebook and custom RTMP destinations, each
  individually toggleable, all broadcast at once (FFmpeg `tee`, `onfail=ignore`).
- **Audio mixer** — host mic + every on-stage guest + screen audio mixed into
  the broadcast; live mic VU meter.
- **Backstage chat** — private text chat between host and guests (off-air).
- **Local recording** — optionally save a WebM of the program feed while live.

## 🚀 Getting started

Requires **Node.js ≥ 18** and **FFmpeg** on the server.

```bash
sudo apt install ffmpeg     # or: brew install ffmpeg
npm install
npm start                   # → http://localhost:3000
```

Open `http://localhost:3000`, allow camera/mic, and you're in the studio.

> **HTTPS is required off-localhost.** Browsers only grant camera/screen/WebRTC
> access on `localhost` or HTTPS origins, so for anything beyond local testing
> put the server behind TLS (Caddy, nginx + Let's Encrypt, or a host that
> terminates TLS). The WebSockets auto-upgrade to `wss://` on HTTPS pages.
> For guests behind strict NATs you'll also want a **TURN** server (only STUN is
> configured by default, in `public/js/rtc.js`).

## 📡 Running a show

1. **Enter the studio** as host (name + camera/mic).
2. **Invite guests** — click *Invite guest*, send the link. Guests join and land
   in the greenroom.
3. **Bring guests on** — in the *People* tab, click *Add to stage*.
4. **Set the scene** — pick a layout, share your screen, add banners, set your
   brand/logo. The canvas preview **is** exactly what viewers will see.
5. **Add destinations** — in the *Stream* tab, paste your YouTube / Facebook
   stream keys (or a custom RTMP URL) and enable them.
6. **Go Live.** Lumio encodes once and pushes to every enabled platform.

### Getting your stream keys

| Platform | Where | Ingest Lumio uses |
| --- | --- | --- |
| YouTube | Studio → *Go live* → *Stream* → **Stream key** | `rtmps://a.rtmps.youtube.com:443/live2/KEY` |
| Facebook | facebook.com/live/producer → *Streaming software* → **Stream key** | `rtmps://live-api-s.facebook.com:443/rtmp/KEY` |
| Custom | your RTMP server (Twitch, X, nginx-rtmp…) | the full `rtmp(s)://…` URL you paste |

Keys live only in the host's `localStorage` and are sent only to your own Lumio
server, which hands them to FFmpeg.

## 🧠 How it works

| Stage | Technology |
| --- | --- |
| Capture | `getUserMedia` (cam/mic), `getDisplayMedia` (screen) |
| Guests | full-mesh **WebRTC** with the *perfect-negotiation* pattern; a WS signaling relay (`/rtc`) exchanges SDP/ICE and room presence |
| Compositing | `<canvas>` 1280×720 @ 30fps — layouts, banners, ticker, logo, LIVE badge |
| Audio mix | Web Audio API graph → `MediaStreamAudioDestinationNode` |
| Encoding (browser) | `canvas.captureStream()` + `MediaRecorder` (WebM, ~3.5 Mbps) |
| Transport | binary WebSocket chunks (500 ms) to the Node relay (`/stream`) |
| Encoding (server) | FFmpeg `libx264 veryfast zerolatency` + AAC, 2s GOP |
| Delivery | `-f flv` (single) or `-f tee` (simultaneous multistream) |

Browsers can't emit RTMP, so a server relay is required — the same reason
StreamYard has a backend.

## 📁 Project structure

```
├── server.js                 # WebRTC signaling (/rtc) + FFmpeg relay (/stream)
├── package.json
└── public/
    ├── index.html            # Host studio
    ├── guest.html            # Guest join / greenroom
    ├── css/studio.css
    ├── img/favicon.svg
    └── js/
        ├── media.js          # shared device pickers / getUserMedia
        ├── rtc.js            # WebRTC full-mesh (perfect negotiation)
        ├── studio.js         # host: compositor, layouts, brand, mixer, go-live
        └── guest.js          # guest: join, greenroom, tiles, chat
```

## ⚠️ Limitations vs. hosted StreamYard

- **Mesh, not an SFU** — great for a host + a handful of guests; for large panels
  you'd swap the mesh for an SFU (e.g. mediasoup/LiveKit).
- **Comments** — pulling live YouTube/Facebook comments onto the screen needs
  each platform's API/OAuth and isn't included.
- **CPU** — the relay transcodes with x264; budget ~1–2 cores per live stream,
  or point `FFMPEG_PATH` at a hardware-encoder FFmpeg build.
- **NAT** — only STUN is configured; add a TURN server for guests on restrictive
  networks.

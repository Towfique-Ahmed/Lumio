# Lumio Studio 🎥

**A StreamYard-style live streaming & webinar studio that runs in the browser.**
Bring multiple people on screen from anywhere, compose a branded program feed,
broadcast it to **YouTube**, **Facebook** and any **RTMP** server — and to your
own **watch page**, where an unlimited audience can watch over HLS and join the
live chat.

```
                 WebRTC mesh (media stays peer-to-peer)
   guest ◀──────────────────────────────────────────────▶ guest
     ▲                                                     ▲
     └──────────────▶  HOST BROWSER  ◀─────────────────────┘
                      canvas compositor + audio mixer
                      (grid / spotlight / sidebar / screen)
                              │  WebM over WebSocket
                              ▼
                        Node relay server ──▶ FFmpeg ─┬─▶ HLS  ─▶ /watch page (∞ viewers + chat)
                                                      ├─▶ RTMPS ─▶ YouTube Live
                                                      ├─▶ RTMPS ─▶ Facebook Live
                                                      └─▶ RTMP  ─▶ Custom (Twitch, nginx-rtmp, …)
```

## 🔬 How StreamYard works (research that shaped this app)

StreamYard was studied as the reference product before building Lumio:

1. **Browser-first studio.** Hosts and guests never install anything; capture,
   compositing and control all happen in the browser.
2. **Guests via invite link → backstage → stage.** The host shares a guest
   link; guests land in a green room to check camera/mic, then wait
   *backstage*. Only when the host adds them to the *stage* are they visible
   and audible to the audience. StreamYard allows up to 10 people on screen,
   with more waiting backstage, and offers preset layouts (grid, spotlight,
   sidebar/screen-share, full-screen) plus branding, overlays and
   featured comments.
3. **WebRTC in, RTMP out.** Participant media travels over WebRTC (real-time,
   sub-second). The composed program is then re-encoded and pushed over RTMP(S)
   to YouTube/Facebook/LinkedIn/etc. simultaneously ("multistreaming") —
   browsers cannot speak RTMP, so a relay/encode hop is mandatory.
4. **Webinars ("StreamYard On-Air").** For audiences beyond the platforms,
   StreamYard hosts a registration + watch page with live chat, emoji
   reactions and a viewer counter, scaling from ten to tens of thousands of
   viewers — viewers receive a one-way stream (not WebRTC), which is what
   makes large audiences cheap.

Sources:
[StreamYard guest invites](https://support.streamyard.com/hc/en-us/articles/4405100913428-How-do-I-invite-guests-to-my-StreamYard-stream),
[Greenroom](https://support.streamyard.com/hc/en-us/articles/6342816437268-Using-the-Greenroom),
[guest instructions](https://support.streamyard.com/hc/en-us/articles/360043291612-Guest-instructions),
[on-screen participants & layouts](https://streamyard.com/blog/invite-guests-to-stream-for-free),
[On-Air webinars](https://support.streamyard.com/hc/en-us/articles/10920795244308-Create-a-Webinar-with-StreamYard-On-Air),
[watching on StreamYard](https://support.streamyard.com/hc/en-us/articles/360043298792-Can-people-watch-on-StreamYard),
[WebRTC SFU architectures](https://getstream.io/resources/projects/webrtc/architectures/sfu/),
[WebRTC live-streaming app comparison](https://www.hirevoipdeveloper.com/blog/live-streaming-apps-using-webrtc/),
[YouTube Live Streaming API — life of a broadcast](https://developers.google.com/youtube/v3/live/life-of-a-broadcast),
[liveBroadcasts.insert](https://developers.google.com/youtube/v3/live/docs/liveBroadcasts/insert),
[liveBroadcasts.bind](https://developers.google.com/youtube/v3/live/docs/liveBroadcasts/bind),
[Meta Live Video API](https://developers.facebook.com/docs/live-video-api/),
[Page live_videos](https://developers.facebook.com/docs/graph-api/reference/page/live_videos/).

Lumio mirrors this architecture at self-hosted scale: a **WebRTC mesh**
replaces StreamYard's SFU for the studio (great up to ~6–10 people), the
**host's browser** is the compositor, and the server relays the program feed
to **HLS** (unlimited one-way viewers) and **RTMP** (multistreaming).

## ✨ Features

- **Multi-person stage** — guests join from a link, wait **backstage**, and the
  host puts up to **10 people on screen**. Everyone sees and hears each other
  in real time over a WebRTC mesh; media never touches the server.
- **Green room** — guests check camera, mic and display name before joining.
- **Host-controlled stage** — add/remove people from the stage, spotlight
  someone, kick disruptive guests. Backstage guests are never seen or heard by
  the audience (their audio is excluded from the program mix).
- **Scene compositor** — live 720p/30fps canvas with StreamYard-style layouts:
  - **Grid** — everyone on stage, auto-arranged
  - **Spotlight** — one big + the rest in a strip
  - **Sidebar** — screen share large + faces in a column
  - **Screen** — presentation full-frame
- **Screen sharing** — host *and* guests can share a screen (with tab/system
  audio when available); the share becomes the presentation source.
- **Branding** — headline bar, brand color, per-tile name labels, camera
  mirroring, cam-off avatar cards, LIVE badge with timer.
- **Webinar watch page (unlimited viewers)** — every broadcast gets
  `/watch/<id>`: HLS playback (hls.js bundled + Safari native), waiting/live/
  ended states, **live chat** and a **viewer counter**. HLS segments are plain
  static files, so audience size is limited only by the web server/CDN — not
  by the studio.
- **Live chat everywhere** — viewers, guests and host share one chat; the host
  can click any message to **feature it on the stream** as a lower-third.
- **Multistreaming** — YouTube, Facebook and custom RTMP(S) destinations with
  per-destination toggles (FFmpeg `tee` muxer, `onfail=ignore` so one bad
  destination doesn't kill the rest). The watch page runs even with zero RTMP
  destinations — that's webinar mode.
- **Local recording** — optionally save a WebM of the program feed while live.

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

> **HTTPS matters:** browsers only allow camera/screen capture on `localhost`
> or HTTPS origins — and your guests will be remote, so put the server behind
> TLS (Caddy, nginx + Let's Encrypt, or a platform that terminates TLS).
> WebSockets automatically upgrade to `wss://` on HTTPS pages.

## 🔌 One-click destinations (the StreamYard "connect" flow)

Just like StreamYard, Lumio can connect platform accounts **through OAuth** so
hosts never touch a stream key:

- **Connect YouTube** → Google sign-in popup → pick the channel → done. When
  you press *Go Live*, Lumio calls the **YouTube Live Streaming API**
  (`liveBroadcasts.insert` + `liveStreams.insert` + `liveBroadcasts.bind`,
  with `enableAutoStart`/`enableAutoStop`) to create the broadcast, fetch the
  RTMPS ingest and start it automatically — the studio log shows the watch
  URL. Privacy (public/unlisted/private) is picked per destination.
- **Connect Facebook** → Facebook Login popup → choose **Profile or Page**
  from a dropdown (like StreamYard's picker). On *Go Live*, Lumio calls the
  **Graph API** (`POST /{target}/live_videos`, `status=LIVE_NOW`) and pushes to
  the returned `secure_stream_url`; the live video is ended via
  `end_live_video` when you stop. *Groups are not offered because Meta removed
  the Groups API in April 2024 (StreamYard dropped it too) — use a persistent
  stream key for groups instead.*

OAuth **tokens never reach the browser** — they're stored on your server in
`.data/connections.json` (mode 600); the studio only holds an opaque
connection id plus the display name/avatar. Google tokens auto-refresh;
Facebook user tokens are exchanged for long-lived (~60-day) tokens.

### Enabling it

Copy `.env.example` to `.env` and fill in:

1. **Google**: [Google Cloud Console](https://console.cloud.google.com/) →
   new project → enable **YouTube Data API v3** → OAuth consent screen →
   Web OAuth client with redirect URI `https://your-domain/auth/youtube/callback`
   → set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
   (The connected channel must have live streaming enabled in YouTube Studio.)
2. **Meta**: [Meta for Developers](https://developers.facebook.com/) → create
   app → add **Facebook Login** → redirect URI
   `https://your-domain/auth/facebook/callback` → set `FACEBOOK_APP_ID` /
   `FACEBOOK_APP_SECRET`. In development the app's testers can go live
   immediately; public use of `publish_video` / pages permissions requires
   Meta App Review.
3. Set `PUBLIC_URL` to the exact HTTPS origin you registered.

No credentials? The Destinations tab automatically falls back to
**manual stream-key entry** (YouTube / Facebook / custom RTMP), which needs no
setup at all.

## 📡 Hosting a broadcast

1. **Create** — on the home page, give your broadcast a title and hit
   *Create broadcast*. You land in the studio as host (a host key in your
   browser proves it's yours).
2. **Invite** — the **Invite** button gives you two links:
   - **Guest link** (`/guest/<id>`) — for people who should appear on screen.
   - **Watch link** (`/watch/<id>`) — for the audience.
3. **Stage your guests** — guests appear in the backstage strip and the
   People tab. Click *Add to stage* when you're ready for them.
4. **Destinations** (optional) — click **Connect YouTube** / **Connect
   Facebook** (OAuth, see above) or paste stream keys / a custom RTMP URL.
   Skip this entirely for a watch-page-only webinar.
5. **Go Live** — the canvas preview *is* the program your audience sees.
   Viewers on the watch page connect automatically; platform streams start on
   the platform side (YouTube auto-detects; Facebook asks you to confirm).

Stream keys are stored in your browser's `localStorage` and are only ever sent
to **your own** Lumio server, which passes them straight to FFmpeg.

## 🧠 How it works

| Stage | Technology |
| --- | --- |
| Studio media | WebRTC full mesh (STUN: Google), perfect-negotiation pattern |
| Signaling / rooms / chat | WebSocket `/ws` — join, roster, stage control, RTC relay, chat |
| Capture | `getUserMedia` (cam/mic), `getDisplayMedia` (screen + audio) |
| Compositing | `<canvas>` 1280×720 @ 30fps — layouts, labels, branding, featured comments |
| Audio mix | Web Audio graph: host mic + screen audio + every **on-stage** guest |
| Encoding (browser) | `canvas.captureStream()` + `MediaRecorder` (WebM, ~3.5 Mbps) |
| Transport | Binary WebSocket chunks (500 ms) to `/stream` |
| Encoding (server) | FFmpeg: `libx264 veryfast zerolatency` + AAC 160k, GOP 2 s |
| Audience delivery | HLS (2 s segments, `delete_segments`) served statically at `/hls/<room>/` |
| Platform delivery | `-f tee` → `[f=hls]…\|[f=flv:onfail=ignore]rtmp(s)://…` |

**Why a mesh and not an SFU?** StreamYard runs a cloud SFU because it serves
thousands of concurrent studios. For a self-hosted tool, a mesh keeps the
server out of the media path entirely (each participant uploads one stream per
peer). With ≤ 6 participants it's excellent; toward 10 it depends on
everyone's upload bandwidth. The relay/HLS/RTMP side is unaffected — viewers
never join the mesh, which is exactly how "unlimited viewers" stays cheap.

## 📁 Project structure

```
├── server.js                  # Express + WS: rooms, signaling, chat, OAuth routes, FFmpeg relay (HLS+RTMP)
├── lib/platforms.js           # YouTube Live Streaming API + Facebook Live Video API + token store
├── .env.example               # PUBLIC_URL + Google/Meta API credentials template
├── package.json
└── public/
    ├── index.html             # Landing: create / join / watch
    ├── studio.html            # Host studio
    ├── guest.html             # Guest green room + stage
    ├── watch.html             # Webinar watch page
    ├── css/studio.css
    ├── img/favicon.svg
    ├── vendor/hls.min.js      # hls.js (bundled — no CDN dependency)
    └── js/
        ├── mesh.js            # Shared signaling client + WebRTC mesh
        ├── studio.js          # Host: compositor, mixer, stage control, broadcast
        ├── guest.js           # Guest: green room, mesh tiles, chat
        └── watch.js           # Viewer: HLS player, chat, statuses
```

## ⚠️ Limitations & scaling notes

- **Mesh, not SFU** — each on-screen participant maintains a connection to
  every other. Fine to ~6, workable to 10 with good upstream bandwidth. For
  more, put an SFU (mediasoup / LiveKit / Janus) behind the same signaling.
- **No TURN server bundled** — participants behind strict/symmetric NAT may
  fail to connect peer-to-peer. Add a TURN server (coturn) to the
  `ICE_SERVERS` list in `public/js/mesh.js` for production use.
- **Viewer latency** is HLS-typical (~6–12 s). Chat is instant (WebSocket).
- The relay transcodes with x264 `veryfast`; budget ~1–2 CPU cores per live
  broadcast, or point `FFMPEG_PATH` at a build with hardware encoders.
- "Unlimited" viewers means the studio doesn't limit them — actual capacity is
  your server's static-file throughput. For very large audiences, put a CDN or
  nginx cache in front of `/hls/`.
- Platforms require the stream to be **started/confirmed** on their side
  (YouTube auto-detects; Facebook shows a preview you confirm).

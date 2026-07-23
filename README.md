# Lumio 🎥

**Turn any YouTube or Facebook live stream into a professional webinar page.**

Lumio is a lightweight, zero-dependency web app for hosting webinars and live-stream
events on top of **YouTube Live** and **Facebook Live**. Paste a stream link, add your
event details, and Lumio generates a branded webinar room — with a countdown lobby,
the live player, embedded chat and one self-contained shareable link.

## ✨ Features

- **YouTube & Facebook Live support** — works with regular videos, live streams,
  channel "always-live" links (`/channel/UC…/live`), `youtu.be` short links,
  `fb.watch` links and any public Facebook video URL. Platform is auto-detected.
- **Countdown lobby** — attendees who arrive early see a live countdown that flips
  to the player automatically at the scheduled start time.
- **Live chat** — YouTube live chat is embedded next to the player
  (via `youtube.com/live_chat?v=…&embed_domain=…`). Facebook events show a
  link-out to the conversation, since Facebook doesn't offer an embeddable chat.
- **Self-contained share links** — the whole event (title, schedule, speakers,
  stream URL, options) is encoded into the `watch.html?w=…` link as base64url JSON,
  so a link works for anyone, on any device, with no backend.
- **Dashboard** — create, edit, share and delete webinars; events are persisted in
  `localStorage`. Status badges (UPCOMING / LIVE / ENDED) update automatically
  based on the schedule and duration.
- **Replay state** — after the scheduled end, the page switches to a replay view.
- **No backend, no build step, no sign-up** — pure HTML/CSS/JS. Host it anywhere
  static files can live (GitHub Pages, Netlify, Vercel, S3, …).

## 🚀 Getting started

Serve the folder with any static file server (the YouTube chat embed requires a
real hostname, so use a server rather than opening `index.html` from disk):

```bash
# Python
python3 -m http.server 8080

# or Node
npx serve .
```

Then open <http://localhost:8080>.

### Creating a webinar

1. Go live on YouTube (YouTube Studio) or Facebook (Live Producer) as usual.
2. Click **+ New Webinar** in Lumio and paste the stream URL — Lumio validates it
   and detects the platform live as you type.
3. Add a title, date/time, duration, host, speakers and an agenda.
4. Copy the generated link and share it with your audience.

### Supported stream URLs

| Platform | Examples |
| --- | --- |
| YouTube video / live | `youtube.com/watch?v=ID`, `youtu.be/ID`, `youtube.com/live/ID`, `youtube.com/embed/ID` |
| YouTube channel live | `youtube.com/channel/UC…/live`, `youtube.com/embed/live_stream?channel=UC…` |
| Facebook Live / video | `facebook.com/<page>/videos/<id>`, `facebook.com/watch?v=<id>`, `fb.watch/<code>` |

## 🧠 How the embeds work

- **YouTube player** — official IFrame embed: `https://www.youtube.com/embed/VIDEO_ID`
  (or `https://www.youtube.com/embed/live_stream?channel=CHANNEL_ID` for a channel's
  current live stream). The stream must be **public** with embedding enabled.
- **YouTube live chat** — `https://www.youtube.com/live_chat?v=VIDEO_ID&embed_domain=<your-host>`.
  YouTube requires `embed_domain` to match the page's hostname, which Lumio sets
  automatically at runtime.
- **Facebook player** — official Video Player plugin:
  `https://www.facebook.com/plugins/video.php?href=<encoded-video-url>`.
  The video must be **public**; Facebook has no embeddable chat, so Lumio links
  viewers to the comments on Facebook instead.

## 📁 Project structure

```
├── index.html          # Landing page + webinar dashboard (create/edit/share)
├── watch.html          # Attendee-facing webinar room (lobby → live → ended)
└── assets/
    ├── css/style.css   # Full design system (dark theme, responsive)
    ├── img/favicon.svg
    └── js/
        ├── utils.js    # URL parsing, embed builders, link codec, storage
        ├── app.js      # Dashboard logic
        └── watch.js    # Watch-page state machine (countdown / live / replay)
```

## 🔒 Privacy

Lumio has no server. Webinar data lives in your browser's `localStorage` and inside
the links you choose to share. The only third-party requests are the YouTube /
Facebook player iframes and Google Fonts.

## Limitations

- Streams must be public and have embedding enabled on their platform.
- The LIVE/ENDED status is schedule-based (start time + duration), not read from
  the platform APIs — attendees can use the "show the player now" button if a
  stream runs long or starts early.
- Facebook live chat cannot be embedded (platform limitation); Lumio links out.

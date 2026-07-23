/* =========================================================================
 * Lumio — watch page (webinar viewers)
 *
 * HLS playback of the composed program feed + live chat over /ws.
 * HLS segments are plain static files, so viewer count is limited only by
 * what the server/CDN in front of it can serve — not by the studio.
 * ========================================================================= */
(() => {
  'use strict';

  const $ = s => document.querySelector(s);
  const U = window.LumioUtil;
  const NAME_KEY = 'lumio.name';

  const roomId = U.roomIdFromPath();
  if (!roomId) { location.href = '/'; return; }

  const hlsUrl = `/hls/${roomId}/live.m3u8`;
  const video = $('#player');

  let live = false;
  let playerStarted = false;
  let hls = null;
  let pollTimer = null;

  /* ------------------------------ status ------------------------------ */

  fetch(`/api/rooms/${roomId}`).then(r => r.json()).then(info => {
    if (!info.exists) {
      $('#watch-title').textContent = 'Broadcast not found';
      $('#overlay-title').textContent = 'This broadcast does not exist or has ended.';
      $('#overlay-sub').textContent = '';
      return;
    }
    setTitle(info.title);
    setLive(info.live);
  }).catch(() => { /* WS will update us */ });

  function setTitle(t) {
    $('#watch-title').textContent = t;
    document.title = `${t} — Lumio`;
  }

  function setLive(isLive) {
    live = isLive;
    $('#live-pill').className = `live-pill ${isLive ? 'live' : 'idle'}`;
    $('#live-label').textContent = isLive ? 'LIVE' : 'OFFLINE';
    if (isLive) {
      $('#overlay-title').textContent = 'Going live…';
      $('#overlay-sub').textContent = 'Connecting to the stream.';
      startWhenReady();
    } else {
      stopPlayer();
      $('#player-overlay').classList.remove('hidden');
      $('#overlay-title').textContent = playerStarted
        ? 'The broadcast has ended. Thanks for watching!'
        : 'Waiting for the broadcast to start…';
      $('#overlay-sub').textContent = playerStarted ? '' : 'The stream starts automatically — keep this page open.';
      playerStarted = false;
    }
  }

  /* ------------------------------ player ------------------------------ */

  /** The playlist can take a few seconds to appear after "live" flips on —
   *  poll it until it exists, then start playback. */
  function startWhenReady() {
    clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      if (!live) { clearInterval(pollTimer); return; }
      try {
        const res = await fetch(hlsUrl, { cache: 'no-store' });
        if (res.ok) {
          clearInterval(pollTimer);
          startPlayer();
        }
      } catch { /* keep polling */ }
    }, 2000);
  }

  function startPlayer() {
    playerStarted = true;
    $('#player-overlay').classList.add('hidden');

    if (window.Hls && Hls.isSupported()) {
      hls = new Hls({
        liveSyncDurationCount: 3,
        maxLiveSyncPlaybackRate: 1.5,
      });
      hls.loadSource(hlsUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(showTapToPlay));
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) return;
        if (live) {
          // transient — the encoder may be re-keying; retry from scratch
          stopPlayer();
          startWhenReady();
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = hlsUrl; // Safari native HLS
      video.play().catch(showTapToPlay);
    } else {
      $('#overlay-title').textContent = 'Your browser cannot play HLS video.';
      $('#overlay-sub').textContent = 'Try Chrome, Edge, Firefox or Safari.';
      $('#player-overlay').classList.remove('hidden');
    }
  }

  function showTapToPlay() {
    // Autoplay with sound was blocked — show the overlay as a big play button.
    $('#player-overlay').classList.remove('hidden');
    $('#overlay-title').textContent = '▶ Tap to watch';
    $('#overlay-sub').textContent = '';
    $('#player-overlay').addEventListener('click', () => {
      video.play().then(() => $('#player-overlay').classList.add('hidden')).catch(() => {});
    }, { once: true });
  }

  function stopPlayer() {
    clearInterval(pollTimer);
    if (hls) { hls.destroy(); hls = null; }
    video.removeAttribute('src');
    video.srcObject = null;
    try { video.load(); } catch { /* ok */ }
  }

  /* ------------------------------ chat + status over WS ------------------------------ */

  const signal = new LumioSignal();
  $('#chat-name').value = localStorage.getItem(NAME_KEY) || '';

  signal.connect().then(() => {
    signal.on('joined', m => {
      setTitle(m.title);
      setLive(m.live);
      $('#viewer-count').textContent = m.viewers || 1;
      (m.chat || []).forEach(appendChat);
    });
    signal.on('chat', appendChat);
    signal.on('viewers', m => { $('#viewer-count').textContent = m.count; });
    signal.on('status', m => { $('#viewer-count').textContent = m.viewers; });
    signal.on('live', m => setLive(m.live));
    signal.on('title', m => setTitle(m.title));
    signal.on('error', m => {
      $('#overlay-title').textContent = m.message;
      $('#overlay-sub').textContent = '';
    });
    signal.send({ type: 'join', room: roomId, role: 'viewer' });
  }).catch(() => {
    $('#overlay-sub').textContent = 'Could not reach the server — chat is unavailable.';
  });

  function appendChat(m) {
    const list = $('#chat-list');
    const div = document.createElement('div');
    div.className = `chat-msg from-${m.from}`;
    div.innerHTML = `<b>${U.escapeHtml(m.name)}</b><span>${U.escapeHtml(m.text)}</span><i>${U.fmtTime(m.ts)}</i>`;
    list.appendChild(div);
    // Cap the DOM at 300 messages.
    while (list.children.length > 300) list.removeChild(list.firstChild);
    list.scrollTop = list.scrollHeight;
  }

  $('#chat-form').addEventListener('submit', e => {
    e.preventDefault();
    const name = $('#chat-name').value.trim() || 'Viewer';
    const text = $('#chat-input').value.trim();
    if (!text) return;
    localStorage.setItem(NAME_KEY, name);
    signal.send({ type: 'chat', name, text });
    $('#chat-input').value = '';
  });
})();

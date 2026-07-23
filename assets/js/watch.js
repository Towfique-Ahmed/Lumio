/* =========================================================================
 * Lumio — watch page: decodes the webinar from the ?w= payload and drives
 * the lobby countdown → live room → ended/replay lifecycle.
 * ========================================================================= */
(() => {
  'use strict';

  const $ = sel => document.querySelector(sel);
  const params = new URLSearchParams(location.search);
  const webinar = Lumio.fromWire(Lumio.decodePayload(params.get('w') || ''));

  if (!webinar) {
    $('#watch-error').classList.remove('hidden');
    $('#status-badge').classList.add('hidden');
    $('#watch-copy').classList.add('hidden');
    return;
  }

  const info = Lumio.parseStreamUrl(webinar.url);
  document.title = `${webinar.title} — Lumio`;

  let shownState = null;
  let countdownTimer = null;
  let forceLive = false;

  /* ---------------- state machine ---------------- */

  function currentState() {
    if (forceLive) return 'live';
    return Lumio.statusOf(webinar);
  }

  function tick() {
    const state = currentState();
    updateBadge(state);
    if (state !== shownState) show(state);
    if (state === 'upcoming') updateCountdown();
  }

  function updateBadge(state) {
    const badge = $('#status-badge');
    badge.className = `status-badge ${state}`;
    badge.textContent = state === 'live' ? '● LIVE'
      : state === 'upcoming' ? 'UPCOMING' : 'ENDED';
  }

  function show(state) {
    shownState = state;
    $('#lobby').classList.toggle('hidden', state !== 'upcoming');
    $('#room').classList.toggle('hidden', state !== 'live');
    $('#ended').classList.toggle('hidden', state !== 'ended');
    if (state === 'upcoming') renderLobby();
    if (state === 'live') renderRoom();
    if (state === 'ended') renderEnded();
  }

  /* ---------------- lobby ---------------- */

  function renderLobby() {
    $('#lobby-platform').textContent =
      `${Lumio.platformLabel(info && info.platform)} · STARTING SOON`;
    $('#lobby-title').textContent = webinar.title;
    $('#lobby-when').textContent =
      `${Lumio.fmtDateTime(webinar.datetime)}${webinar.host ? ' · Hosted by ' + webinar.host : ''}`;
    updateCountdown();
  }

  function updateCountdown() {
    const diff = Math.max(0, new Date(webinar.datetime).getTime() - Date.now());
    const s = Math.floor(diff / 1000);
    const pad = n => String(n).padStart(2, '0');
    $('#cd-days').textContent = Math.floor(s / 86400);
    $('#cd-hours').textContent = pad(Math.floor(s / 3600) % 24);
    $('#cd-mins').textContent = pad(Math.floor(s / 60) % 60);
    $('#cd-secs').textContent = pad(s % 60);
  }

  $('#lobby-skip').addEventListener('click', () => { forceLive = true; tick(); });

  /* ---------------- live room ---------------- */

  let roomBuilt = false;

  function renderRoom() {
    if (roomBuilt) return;
    roomBuilt = true;

    const playerFrame = $('#player-frame');
    const iframe = Lumio.buildPlayerIframe(webinar);
    if (iframe) playerFrame.appendChild(iframe);
    else playerFrame.innerHTML = '<p class="player-error">Could not build a player for this stream URL.</p>';

    $('#room-title').textContent = webinar.title;
    $('#room-platform').textContent = Lumio.platformLabel(info && info.platform);
    $('#room-when').textContent = `📅 ${Lumio.fmtDateTime(webinar.datetime)}`;
    if (webinar.host) $('#room-host').textContent = `👤 Hosted by ${webinar.host}`;

    if (webinar.speakers) {
      const el = $('#room-speakers');
      el.classList.remove('hidden');
      el.textContent = `🎤 Speakers: ${webinar.speakers}`;
    }
    if (webinar.desc) {
      const el = $('#room-desc');
      el.classList.remove('hidden');
      // Render agenda lines as a list; plain lines as paragraphs.
      el.innerHTML = webinar.desc.split('\n').filter(Boolean)
        .map(line => `<p>${Lumio.escapeHtml(line)}</p>`).join('');
    }

    // Chat column: embedded for YouTube; link-out note for Facebook.
    const chatCol = $('#chat-col');
    const grid = $('#room-grid');
    if (info && info.platform === 'youtube' && webinar.chat) {
      const chatSrc = Lumio.youTubeChatSrc(info);
      if (chatSrc) {
        const chat = document.createElement('iframe');
        chat.src = chatSrc;
        chat.title = 'YouTube live chat';
        $('#chat-frame').appendChild(chat);
      } else {
        chatCol.classList.add('hidden');
        grid.classList.add('no-chat');
      }
    } else {
      chatCol.classList.add('hidden');
      grid.classList.add('no-chat');
      if (info && info.platform === 'facebook') {
        $('#fb-chat-note').classList.remove('hidden');
        $('#fb-chat-link').href = webinar.url;
      }
    }
  }

  /* ---------------- ended ---------------- */

  let endedBuilt = false;

  function renderEnded() {
    if (endedBuilt) return;
    endedBuilt = true;
    $('#ended-title').textContent = webinar.title;
    const iframe = Lumio.buildPlayerIframe(webinar, { autoplay: false });
    if (iframe) $('#replay-frame').appendChild(iframe);
  }

  /* ---------------- copy link ---------------- */

  $('#watch-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(location.href); } catch { /* noop */ }
    const btn = $('#watch-copy');
    btn.textContent = '✓ Copied';
    setTimeout(() => { btn.textContent = '🔗 Copy link'; }, 1500);
  });

  /* ---------------- go ---------------- */

  tick();
  countdownTimer = setInterval(tick, 1000);
})();

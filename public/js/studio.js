/* =========================================================================
 * Lumio Studio — host engine
 *
 * getUserMedia + WebRTC mesh (guests) → canvas compositor + Web Audio mixer
 *   → MediaRecorder (WebM) → /stream WS → FFmpeg → HLS watch page + RTMP
 * ========================================================================= */
(() => {
  'use strict';

  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const U = window.LumioUtil;

  const W = 1280, H = 720, FPS = 30;
  const DEST_KEY = 'lumio.destinations.v1';
  const BRAND_KEY = 'lumio.brand.v2';
  const NAME_KEY = 'lumio.name';

  const INGEST = {
    youtube: key => `rtmps://a.rtmps.youtube.com:443/live2/${key}`,
    facebook: key => `rtmps://live-api-s.facebook.com:443/rtmp/${key}`,
    custom: url => url,
  };
  const PLATFORM_LABEL = { youtube: 'YouTube', facebook: 'Facebook', custom: 'Custom RTMP' };
  const RTMP_RE = /^rtmps?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?\/\S+$/;

  /* --------------------------- room bootstrap --------------------------- */

  const roomId = U.roomIdFromPath();
  if (!roomId) { location.href = '/'; return; }

  const keyStore = `lumio.hostkey.${roomId}`;
  const urlKey = new URLSearchParams(location.search).get('key');
  if (urlKey) {
    localStorage.setItem(keyStore, urlKey);
    history.replaceState(null, '', `/studio/${roomId}`);
  }
  const hostKey = localStorage.getItem(keyStore);
  if (!hostKey) {
    document.body.innerHTML = '<div class="gate"><div class="gate-card"><h1>Not your studio</h1>' +
      '<p>This browser has no host key for this broadcast. Create a new broadcast from the home page.</p>' +
      '<a class="btn btn-primary btn-lg" href="/">← Back to Lumio</a></div></div>';
    return;
  }

  /* ------------------------------- state ------------------------------- */

  const state = {
    selfId: null,
    camStream: null,
    screenStream: null,
    layout: 'grid',
    spotlightId: 'self',
    micOn: true,
    camOn: true,
    live: false,
    liveStart: 0,
    recordLocally: false,
    recordedChunks: [],
    mediaWs: null,
    recorder: null,
    timerId: null,
    featured: null, // { name, text }
    chatUnread: 0,
  };

  const brand = Object.assign({
    title: '', color: '#7c3aed', showTitle: false, showNames: true, mirror: false,
  }, load(BRAND_KEY));

  let destinations = load(DEST_KEY) || [];

  /** peerId -> participant
   *  { peerId, name, role, onStage, camStream, screenStream,
   *    camEl, screenEl, camStreamId, screenStreamId, audio: Map<streamId,{gProg,gMon}> } */
  const participants = new Map();

  function load(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }
  function save(k, v) { localStorage.setItem(k, JSON.stringify(v)); }

  function self() { return participants.get('self'); }
  function remotes() { return [...participants.values()].filter(p => p.peerId !== 'self'); }
  function onStageParts() { return [...participants.values()].filter(p => p.onStage); }

  /* --------------------------- media elements --------------------------- */

  const pool = $('#media-pool');

  function makeVideoEl(stream) {
    const v = document.createElement('video');
    v.muted = true;
    v.autoplay = true;
    v.playsInline = true;
    v.srcObject = stream;
    pool.appendChild(v);
    return v;
  }

  function dropVideoEl(v) {
    if (!v) return;
    v.srcObject = null;
    v.remove();
  }

  /* ------------------------------ setup gate ------------------------------ */

  async function populateDevices() {
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      $('#gate-preview').srcObject = probe;
    } catch { /* user may allow later */ }
    const devs = await navigator.mediaDevices.enumerateDevices();
    const fill = (sel, kind, fallback) => {
      sel.innerHTML = '';
      devs.filter(d => d.kind === kind).forEach((d, i) => {
        const o = document.createElement('option');
        o.value = d.deviceId;
        o.textContent = d.label || `${fallback} ${i + 1}`;
        sel.appendChild(o);
      });
      if (!sel.options.length) sel.innerHTML = `<option value="">No ${fallback.toLowerCase()} found</option>`;
    };
    fill($('#gate-cam'), 'videoinput', 'Camera');
    fill($('#gate-mic'), 'audioinput', 'Microphone');
  }

  $('#gate-name').value = localStorage.getItem(NAME_KEY) || '';

  $('#gate-enter').addEventListener('click', async () => {
    const err = $('#gate-error');
    err.classList.add('hidden');
    try {
      const camId = $('#gate-cam').value, micId = $('#gate-mic').value;
      const prev = $('#gate-preview').srcObject;
      if (prev) prev.getTracks().forEach(t => t.stop());
      state.camStream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: camId ? { exact: camId } : undefined, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: { deviceId: micId ? { exact: micId } : undefined, echoCancellation: true, noiseSuppression: true },
      });
    } catch (e) {
      err.textContent = `Could not access camera/mic: ${e.message}. Check browser permissions and try again.`;
      err.classList.remove('hidden');
      return;
    }

    const name = $('#gate-name').value.trim() || 'Host';
    localStorage.setItem(NAME_KEY, name);

    participants.set('self', {
      peerId: 'self', name, role: 'host', onStage: true,
      camStream: state.camStream, screenStream: null,
      camEl: makeVideoEl(state.camStream), screenEl: null,
      audio: new Map(),
    });

    initAudio();

    try {
      await connect(name);
    } catch (e) {
      err.textContent = e.message;
      err.classList.remove('hidden');
      return;
    }

    $('#gate').classList.add('hidden');
    $('#studio').classList.remove('hidden');
    $('#btn-golive').disabled = false;
    renderPeople();
  });

  /* ------------------------- signaling + mesh ------------------------- */

  const signal = new LumioSignal();
  let mesh = null;

  async function connect(name) {
    await signal.connect();

    const joined = new Promise((resolve, reject) => {
      signal.on('joined', resolve);
      signal.on('error', m => reject(new Error(m.message || 'Could not join the studio.')));
    });

    signal.send({
      type: 'join', room: roomId, role: 'host', hostKey,
      name, camStreamId: state.camStream.id,
    });

    const msg = await joined;
    state.selfId = msg.peerId;
    $('#viewer-count').textContent = msg.viewers || 0;
    if (msg.title) { brand.title = brand.title || msg.title; $('#brand-title').value = brand.title; }
    (msg.chat || []).forEach(appendChat);

    mesh = new LumioMesh({
      signal,
      selfId: state.selfId,
      getLocalTracks: localTracks,
      onTrack: onRemoteTrack,
      onPeerClosed: () => {},
    });

    signal.on('error', m => logLine('✗ ' + m.message));
    signal.on('_disconnected', () => logLine('✗ Lost connection to the Lumio server — reload to reconnect.'));

    signal.on('peer-joined', m => { addRemote(m.peer); logLine(`＋ ${m.peer.name} joined backstage.`); });
    signal.on('peer-left', m => removeRemote(m.peerId));
    signal.on('peer-renamed', m => { const p = participants.get(m.peerId); if (p) { p.name = m.name; renderPeople(); } });
    signal.on('peer-media', m => updateRemoteMedia(m));
    signal.on('stage', m => { const p = participants.get(m.peerId); if (p) { p.onStage = m.onStage; syncStage(); } });
    signal.on('rtc', m => mesh.handleSignal(m.from, m.data));
    signal.on('chat', appendChat);
    signal.on('viewers', m => { $('#viewer-count').textContent = m.count; });

    // Connect to everyone already in the room (we initiate as the newcomer).
    (msg.roster || []).filter(p => p.peerId !== state.selfId).forEach(p => {
      addRemote(p);
      mesh.ensurePeer(p.peerId);
    });
  }

  function localTracks() {
    const out = [];
    state.camStream.getTracks().forEach(track => out.push({ track, stream: state.camStream }));
    if (state.screenStream) {
      state.screenStream.getTracks().forEach(track => out.push({ track, stream: state.screenStream }));
    }
    return out;
  }

  function addRemote(peer) {
    if (participants.has(peer.peerId)) return;
    participants.set(peer.peerId, {
      peerId: peer.peerId, name: peer.name, role: peer.role, onStage: !!peer.onStage,
      camStream: null, screenStream: null, camEl: null, screenEl: null,
      camStreamId: peer.camStreamId, screenStreamId: peer.screenStreamId,
      audio: new Map(),
    });
    renderPeople();
  }

  function removeRemote(peerId) {
    const p = participants.get(peerId);
    if (!p) return;
    mesh.closePeer(peerId);
    for (const nodes of p.audio.values()) detachAudioNodes(nodes);
    dropVideoEl(p.camEl);
    dropVideoEl(p.screenEl);
    participants.delete(peerId);
    logLine(`− ${p.name} left.`);
    syncStage();
  }

  function updateRemoteMedia(m) {
    const p = participants.get(m.peerId);
    if (!p) return;
    p.camStreamId = m.camStreamId;
    p.screenStreamId = m.screenStreamId;
    // Re-classify already-received streams.
    if (p.screenStream && p.screenStream.id !== p.screenStreamId) {
      dropVideoEl(p.screenEl);
      p.screenEl = null;
      p.screenStream = null;
    }
    if (p.camStream && p.camStream.id === p.screenStreamId) {
      p.screenStream = p.camStream; p.screenEl = p.camEl;
      p.camStream = null; p.camEl = null;
    }
    syncStage();
  }

  function onRemoteTrack(peerId, track, stream) {
    const p = participants.get(peerId);
    if (!p) return;

    const isScreen = p.screenStreamId && stream.id === p.screenStreamId;
    if (isScreen) {
      if (!p.screenEl || p.screenStream !== stream) {
        dropVideoEl(p.screenEl);
        p.screenStream = stream;
        p.screenEl = makeVideoEl(stream);
        if (state.layout === 'grid') setLayout('sidebar');
      }
    } else if (!p.camEl || p.camStream !== stream) {
      dropVideoEl(p.camEl);
      p.camStream = stream;
      p.camEl = makeVideoEl(stream);
    }

    if (track.kind === 'audio') attachRemoteAudio(p, stream);

    stream.addEventListener('removetrack', () => {
      if (!stream.getTracks().length) {
        if (p.screenStream === stream) { dropVideoEl(p.screenEl); p.screenEl = null; p.screenStream = null; }
        if (p.camStream === stream) { dropVideoEl(p.camEl); p.camEl = null; p.camStream = null; }
        const nodes = p.audio.get(stream.id);
        if (nodes) { detachAudioNodes(nodes); p.audio.delete(stream.id); }
        syncStage();
      }
    });

    syncStage();
  }

  /* ------------------------------ audio mixer ------------------------------ */

  let actx, micGain, screenGain, mixDest, analyser;

  function initAudio() {
    actx = new (window.AudioContext || window.webkitAudioContext)();
    mixDest = actx.createMediaStreamDestination();
    analyser = actx.createAnalyser();
    analyser.fftSize = 256;

    micGain = actx.createGain();
    const micTracks = state.camStream.getAudioTracks();
    if (micTracks.length) {
      const src = actx.createMediaStreamSource(new MediaStream(micTracks));
      src.connect(micGain);
      micGain.connect(mixDest);
      micGain.connect(analyser);
    }
    requestAnimationFrame(vuLoop);
  }

  function attachRemoteAudio(p, stream) {
    if (p.audio.has(stream.id)) return;
    if (!stream.getAudioTracks().length) return;
    U.primeAudio(stream); // Chrome: WebAudio needs the stream attached to an element
    const src = actx.createMediaStreamSource(stream);
    const gProg = actx.createGain(); // → broadcast mix (only while on stage)
    const gMon = actx.createGain();  // → host's speakers (always, incl. backstage)
    gProg.gain.value = p.onStage ? 1 : 0;
    gMon.gain.value = 0.9;
    src.connect(gProg); gProg.connect(mixDest);
    src.connect(gMon); gMon.connect(actx.destination);
    p.audio.set(stream.id, { src, gProg, gMon });
  }

  function detachAudioNodes(nodes) {
    try { nodes.src.disconnect(); } catch { /* ok */ }
    try { nodes.gProg.disconnect(); } catch { /* ok */ }
    try { nodes.gMon.disconnect(); } catch { /* ok */ }
  }

  function attachScreenAudio() {
    if (screenGain) { try { screenGain.disconnect(); } catch { /* ok */ } screenGain = null; }
    const tracks = state.screenStream ? state.screenStream.getAudioTracks() : [];
    if (!tracks.length) return;
    screenGain = actx.createGain();
    screenGain.gain.value = 0.9;
    actx.createMediaStreamSource(new MediaStream(tracks)).connect(screenGain);
    screenGain.connect(mixDest);
  }

  function vuLoop() {
    if (analyser) {
      const buf = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteFrequencyData(buf);
      const level = Math.min(100, Math.round((buf.reduce((a, b) => a + b, 0) / buf.length) / 1.6));
      $('#vu-bar').style.width = (state.micOn ? level : 0) + '%';
    }
    requestAnimationFrame(vuLoop);
  }

  /* ------------------------------ compositor ------------------------------ */

  const canvas = $('#program');
  const ctx = canvas.getContext('2d', { alpha: false });

  function ready(v) { return v && v.srcObject && v.readyState >= 2 && v.videoWidth > 0; }

  function presentation() {
    const s = self();
    if (s && s.screenStream && ready(s.screenEl)) return s.screenEl;
    for (const p of onStageParts()) if (p.screenStream && ready(p.screenEl)) return p.screenEl;
    return null;
  }

  function drawCover(v, x, y, w, h, mirror = false) {
    const vw = v.videoWidth, vh = v.videoHeight;
    const scale = Math.max(w / vw, h / vh);
    const sw = w / scale, sh = h / scale;
    const sx = (vw - sw) / 2, sy = (vh - sh) / 2;
    ctx.save();
    if (mirror) { ctx.translate(x + w, y); ctx.scale(-1, 1); ctx.drawImage(v, sx, sy, sw, sh, 0, 0, w, h); }
    else ctx.drawImage(v, sx, sy, sw, sh, x, y, w, h);
    ctx.restore();
  }

  function drawContain(v, x, y, w, h) {
    const vw = v.videoWidth, vh = v.videoHeight;
    const scale = Math.min(w / vw, h / vh);
    const dw = vw * scale, dh = vh * scale;
    ctx.drawImage(v, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  }

  function drawAvatarCard(p, x, y, w, h) {
    ctx.fillStyle = '#191130';
    ctx.fillRect(x, y, w, h);
    const initial = (p.name || 'G')[0].toUpperCase();
    const r = Math.min(w, h) * 0.2;
    const cx = x + w / 2, cy = y + h / 2;
    ctx.fillStyle = brand.color;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = `700 ${Math.round(r)}px Inter, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(initial, cx, cy + r * 0.06);
  }

  function drawTile(p, x, y, w, h, radius = 12) {
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, radius);
    ctx.clip();
    const mirror = p.peerId === 'self' && brand.mirror;
    if (ready(p.camEl) && p.camStream && p.camStream.getVideoTracks().some(t => t.enabled !== false)) {
      drawCover(p.camEl, x, y, w, h, mirror);
    } else {
      drawAvatarCard(p, x, y, w, h);
    }
    if (brand.showNames && p.name && h > 90) {
      ctx.font = `600 ${Math.max(14, Math.round(h * 0.055))}px Inter, sans-serif`;
      const tw = ctx.measureText(p.name).width;
      const bh = Math.max(24, Math.round(h * 0.09));
      ctx.fillStyle = 'rgba(11,7,22,0.72)';
      ctx.beginPath(); ctx.roundRect(x + 10, y + h - bh - 10, tw + 22, bh, 6); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(p.name, x + 21, y + h - 10 - bh / 2 + 1);
    }
    ctx.restore();
  }

  /** Lay N tiles out in an auto grid inside a rect, keeping ~16:9 tiles. */
  function gridRects(n, X, Y, Wd, Ht, gap = 12) {
    if (n === 0) return [];
    let best = null;
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      const tw = (Wd - gap * (cols - 1)) / cols;
      const th = (Ht - gap * (rows - 1)) / rows;
      const s = Math.min(tw / 16, th / 9);
      if (!best || s > best.s) best = { cols, rows, s };
    }
    const { cols, rows, s } = best;
    const tw = s * 16, th = s * 9;
    const rects = [];
    for (let i = 0; i < n; i++) {
      const r = Math.floor(i / cols);
      const rowCount = r === rows - 1 ? n - r * cols : cols;
      const rowW = rowCount * tw + (rowCount - 1) * gap;
      const c = i - r * cols;
      const x = X + (Wd - rowW) / 2 + c * (tw + gap);
      const gridH = rows * th + (rows - 1) * gap;
      const y = Y + (Ht - gridH) / 2 + r * (th + gap);
      rects.push({ x, y, w: tw, h: th });
    }
    return rects;
  }

  function drawFrame() {
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#0b0716'); g.addColorStop(1, '#171029');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    const cast = onStageParts();
    const pres = presentation();
    const top = brand.showTitle && brand.title ? 62 : 16;
    const bottom = state.featured ? 96 : 16;
    const innerH = H - top - bottom;

    let layout = state.layout;
    if ((layout === 'sidebar' || layout === 'screen') && !pres) layout = 'grid';

    if (layout === 'grid' || cast.length === 0) {
      const rects = gridRects(cast.length, 16, top, W - 32, innerH);
      cast.forEach((p, i) => drawTile(p, rects[i].x, rects[i].y, rects[i].w, rects[i].h));
    } else if (layout === 'spotlight') {
      const star = cast.find(p => p.peerId === state.spotlightId) || cast[0];
      const others = cast.filter(p => p !== star);
      if (others.length === 0) {
        drawTile(star, 16, top, W - 32, innerH);
      } else {
        const stripH = 128;
        drawTile(star, 16, top, W - 32, innerH - stripH - 12);
        const rects = gridRects(others.length, 16, top + innerH - stripH, W - 32, stripH);
        others.forEach((p, i) => drawTile(p, rects[i].x, rects[i].y, rects[i].w, rects[i].h, 8));
      }
    } else if (layout === 'sidebar') {
      const pw = Math.round(W * 0.72);
      ctx.save();
      ctx.beginPath(); ctx.roundRect(16, top, pw, innerH, 12); ctx.clip();
      ctx.fillStyle = '#000';
      ctx.fillRect(16, top, pw, innerH);
      drawContain(pres, 16, top, pw, innerH);
      ctx.restore();
      const rects = gridRects(cast.length, pw + 28, top, W - pw - 44, innerH);
      cast.forEach((p, i) => drawTile(p, rects[i].x, rects[i].y, rects[i].w, rects[i].h, 8));
    } else if (layout === 'screen') {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
      drawContain(pres, 0, 0, W, H);
    }

    drawBranding();
    if (state.featured) drawFeatured();
    if (state.live) drawLiveBadge();
  }

  function drawBranding() {
    if (brand.showTitle && brand.title) {
      ctx.fillStyle = 'rgba(11,7,22,0.82)';
      ctx.fillRect(0, 0, W, 54);
      ctx.fillStyle = brand.color;
      ctx.fillRect(0, 50, W, 4);
      ctx.fillStyle = '#fff';
      ctx.font = '600 24px Inter, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(brand.title, W / 2, 27);
    }
  }

  function drawFeatured() {
    const f = state.featured;
    ctx.font = '500 22px Inter, sans-serif';
    const label = f.text.length > 90 ? f.text.slice(0, 90) + '…' : f.text;
    const tw = ctx.measureText(label).width;
    ctx.font = '700 16px Inter, sans-serif';
    const nw = ctx.measureText(f.name).width;
    const bw = Math.min(W - 72, Math.max(tw, nw) + 56);
    const bx = (W - bw) / 2, by = H - 84, bh = 66;
    ctx.fillStyle = 'rgba(11,7,22,0.88)';
    ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 10); ctx.fill();
    ctx.fillStyle = brand.color;
    ctx.beginPath(); ctx.roundRect(bx, by, 6, bh, [10, 0, 0, 10]); ctx.fill();
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = brand.color;
    ctx.font = '700 16px Inter, sans-serif';
    ctx.fillText(f.name, bx + 24, by + 26);
    ctx.fillStyle = '#fff';
    ctx.font = '500 22px Inter, sans-serif';
    ctx.fillText(label, bx + 24, by + 52, bw - 44);
  }

  function drawLiveBadge() {
    const t = elapsed();
    ctx.font = '800 18px Inter, sans-serif';
    const label = `LIVE ${t}`;
    const w = ctx.measureText(label).width + 44;
    const y = brand.showTitle && brand.title ? 62 : 16;
    ctx.fillStyle = 'rgba(11,7,22,0.8)';
    ctx.beginPath(); ctx.roundRect(W - w - 20, y, w, 34, 17); ctx.fill();
    ctx.fillStyle = '#ef4444';
    ctx.beginPath(); ctx.arc(W - w - 20 + 18, y + 17, 5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(label, W - w - 20 + 31, y + 18);
  }

  setInterval(drawFrame, 1000 / FPS);

  /* --------------------------- people & stage --------------------------- */

  function syncStage() {
    // program audio follows stage state
    for (const p of remotes()) {
      for (const nodes of p.audio.values()) nodes.gProg.gain.value = p.onStage ? 1 : 0;
    }
    renderPeople();
    renderBackstageStrip();
    $('#stat-stage').textContent = onStageParts().length;
  }

  function setStage(peerId, onStage) {
    if (onStage && onStageParts().length >= 10) {
      logLine('✗ Stage is full (10 people max on screen).');
      return;
    }
    const p = participants.get(peerId);
    if (!p) return;
    p.onStage = onStage;
    signal.send({ type: 'stage', peerId, onStage });
    syncStage();
  }

  function personRow(p) {
    const row = document.createElement('div');
    row.className = 'person' + (p.peerId === 'self' ? ' me' : '');
    const connected = p.peerId === 'self' || p.camStream || p.audio.size;
    row.innerHTML = `
      <span class="person-dot ${connected ? 'ok' : 'wait'}"></span>
      <span class="person-name">${U.escapeHtml(p.name)}${p.peerId === 'self' ? ' <i>(you)</i>' : ''}${p.role === 'host' ? ' <i>· host</i>' : ''}</span>
      <span class="person-actions"></span>`;
    const actions = row.querySelector('.person-actions');

    if (p.onStage) {
      const spot = document.createElement('button');
      spot.className = 'btn btn-ghost btn-xs' + (state.spotlightId === p.peerId ? ' on' : '');
      spot.textContent = '★';
      spot.title = 'Spotlight (used by the Spotlight layout)';
      spot.onclick = () => { state.spotlightId = p.peerId; setLayout('spotlight'); renderPeople(); };
      actions.appendChild(spot);
    }
    if (p.peerId !== 'self') {
      const stage = document.createElement('button');
      stage.className = 'btn btn-sm ' + (p.onStage ? 'btn-ghost' : 'btn-primary');
      stage.textContent = p.onStage ? 'Remove' : 'Add to stage';
      stage.onclick = () => setStage(p.peerId, !p.onStage);
      actions.appendChild(stage);

      const kick = document.createElement('button');
      kick.className = 'btn btn-ghost btn-xs';
      kick.textContent = '✕';
      kick.title = 'Remove from studio';
      kick.onclick = () => signal.send({ type: 'kick', peerId: p.peerId });
      actions.appendChild(kick);
    }
    return row;
  }

  function renderPeople() {
    const all = [...participants.values()];
    const stageList = $('#list-stage'), backList = $('#list-backstage');
    stageList.innerHTML = ''; backList.innerHTML = '';
    all.filter(p => p.onStage).forEach(p => stageList.appendChild(personRow(p)));
    const back = all.filter(p => !p.onStage);
    if (!back.length) backList.innerHTML = '<p class="dest-empty">Nobody backstage. Share the guest link from <b>Invite</b>.</p>';
    back.forEach(p => backList.appendChild(personRow(p)));
    $('#people-count').textContent = all.length > 1 ? all.length : '';
  }

  function renderBackstageStrip() {
    const back = remotes().filter(p => !p.onStage);
    $('#backstage-strip').classList.toggle('hidden', back.length === 0);
    const tiles = $('#backstage-tiles');
    [...tiles.querySelectorAll('video')].forEach(v => { v.srcObject = null; });
    tiles.innerHTML = '';
    back.forEach(p => {
      const t = document.createElement('div');
      t.className = 'bs-tile';
      t.title = `${p.name} — click to add to stage`;
      if (p.camStream) {
        // A dedicated preview element — the compositor keeps its own copy.
        const v = document.createElement('video');
        v.className = 'bs-video';
        v.muted = true; v.autoplay = true; v.playsInline = true;
        v.srcObject = p.camStream;
        t.appendChild(v);
      } else {
        t.textContent = (p.name || 'G')[0].toUpperCase();
      }
      const label = document.createElement('span');
      label.textContent = p.name;
      t.appendChild(label);
      t.onclick = () => setStage(p.peerId, true);
      tiles.appendChild(t);
    });
  }

  /* ------------------------------ controls ------------------------------ */

  $('#btn-mic').addEventListener('click', () => {
    state.micOn = !state.micOn;
    state.camStream.getAudioTracks().forEach(t => { t.enabled = state.micOn; });
    if (micGain) micGain.gain.value = state.micOn ? 1 : 0;
    $('#btn-mic').classList.toggle('on', state.micOn);
    $('#btn-mic').classList.toggle('off', !state.micOn);
  });

  $('#btn-cam').addEventListener('click', () => {
    state.camOn = !state.camOn;
    state.camStream.getVideoTracks().forEach(t => { t.enabled = state.camOn; });
    $('#btn-cam').classList.toggle('on', state.camOn);
    $('#btn-cam').classList.toggle('off', !state.camOn);
  });

  $('#btn-screen').addEventListener('click', async () => {
    if (state.screenStream) { stopScreen(); return; }
    try {
      state.screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: FPS }, audio: true,
      });
    } catch { return; /* user cancelled */ }
    const s = self();
    s.screenStream = state.screenStream;
    s.screenEl = makeVideoEl(state.screenStream);
    attachScreenAudio();
    signal.send({ type: 'media', screenStreamId: state.screenStream.id });
    state.screenStream.getTracks().forEach(track => mesh.addTrackToAll(track, state.screenStream));
    state.screenStream.getVideoTracks()[0].addEventListener('ended', stopScreen);
    $('#btn-screen').classList.add('on');
    if (state.layout === 'grid') setLayout('sidebar');
  });

  function stopScreen() {
    if (!state.screenStream) return;
    state.screenStream.getTracks().forEach(track => { mesh.removeTrackFromAll(track); track.stop(); });
    signal.send({ type: 'media', screenStreamId: null });
    state.screenStream = null;
    const s = self();
    if (s) { dropVideoEl(s.screenEl); s.screenEl = null; s.screenStream = null; }
    if (screenGain) { try { screenGain.disconnect(); } catch { /* ok */ } screenGain = null; }
    $('#btn-screen').classList.remove('on');
    if (state.layout === 'sidebar' || state.layout === 'screen') setLayout('grid');
  }

  function setLayout(l) {
    state.layout = l;
    $$('.layout').forEach(b => b.classList.toggle('on', b.dataset.layout === l));
  }
  $$('.layout').forEach(b => b.addEventListener('click', () => setLayout(b.dataset.layout)));

  /* tabs */
  $$('.tab').forEach(t => t.addEventListener('click', () => {
    $$('.tab').forEach(x => x.classList.toggle('on', x === t));
    $$('.tab-panel').forEach(p => p.classList.toggle('hidden', p.id !== `tab-${t.dataset.tab}`));
    if (t.dataset.tab === 'chat') { state.chatUnread = 0; $('#chat-badge').textContent = ''; }
  }));

  /* ------------------------------ invite ------------------------------ */

  $('#btn-invite').addEventListener('click', () => {
    $('#invite-guest').value = `${location.origin}/guest/${roomId}`;
    $('#invite-watch').value = `${location.origin}/watch/${roomId}`;
    $('#invite-modal').classList.remove('hidden');
  });
  $('#invite-close').addEventListener('click', () => $('#invite-modal').classList.add('hidden'));
  $$('#invite-modal [data-copy]').forEach(b => b.addEventListener('click', async () => {
    const input = $('#' + b.dataset.copy);
    try { await navigator.clipboard.writeText(input.value); } catch { input.select(); document.execCommand('copy'); }
    b.textContent = 'Copied!';
    setTimeout(() => { b.textContent = 'Copy'; }, 1500);
  }));

  /* ------------------------------ chat ------------------------------ */

  function appendChat(m) {
    const list = $('#chat-list');
    const div = document.createElement('div');
    div.className = `chat-msg from-${m.from}`;
    div.innerHTML = `<b>${U.escapeHtml(m.name)}</b><span>${U.escapeHtml(m.text)}</span><i>${U.fmtTime(m.ts)}</i>`;
    div.title = 'Click to feature this message on the stream';
    div.onclick = () => {
      if (state.featured && state.featured.text === m.text && state.featured.name === m.name) {
        state.featured = null;
        div.classList.remove('featured');
      } else {
        state.featured = { name: m.name, text: m.text };
        $$('.chat-msg.featured').forEach(x => x.classList.remove('featured'));
        div.classList.add('featured');
      }
    };
    list.appendChild(div);
    list.scrollTop = list.scrollHeight;
    if (!$('#tab-chat') || $('#tab-chat').classList.contains('hidden')) {
      state.chatUnread++;
      $('#chat-badge').textContent = state.chatUnread;
    }
  }

  $('#chat-form').addEventListener('submit', e => {
    e.preventDefault();
    const text = $('#chat-input').value.trim();
    if (!text) return;
    signal.send({ type: 'chat', text });
    $('#chat-input').value = '';
  });

  /* ------------------------------ branding ------------------------------ */

  function saveBrand() { save(BRAND_KEY, brand); }
  $('#brand-title').value = brand.title;
  $('#brand-color').value = brand.color;
  $('#brand-show-title').checked = brand.showTitle;
  $('#brand-show-names').checked = brand.showNames;
  $('#brand-mirror').checked = brand.mirror;

  $('#brand-title').addEventListener('input', e => {
    brand.title = e.target.value; saveBrand();
    signal.send({ type: 'title', title: brand.title });
  });
  $('#brand-color').addEventListener('input', e => { brand.color = e.target.value; saveBrand(); });
  $('#brand-show-title').addEventListener('change', e => { brand.showTitle = e.target.checked; saveBrand(); });
  $('#brand-show-names').addEventListener('change', e => { brand.showNames = e.target.checked; saveBrand(); });
  $('#brand-mirror').addEventListener('change', e => { brand.mirror = e.target.checked; saveBrand(); });

  /* ------------------------------ destinations ------------------------------ */

  function renderDests() {
    const list = $('#dest-list');
    list.innerHTML = '';
    if (!destinations.length) {
      list.innerHTML = '<p class="dest-empty">No RTMP destinations — your Lumio watch page still works. Add YouTube, Facebook or custom RTMP to multistream.</p>';
    }
    destinations.forEach((d, i) => {
      const row = document.createElement('div');
      row.className = 'dest' + (d.enabled ? ' enabled' : '');
      row.innerHTML = `
        <label class="switch" title="${d.enabled ? 'Enabled' : 'Disabled'}">
          <input type="checkbox" data-i="${i}" ${d.enabled ? 'checked' : ''}/><span></span>
        </label>
        <div class="dest-info">
          <b class="${d.platform}">${PLATFORM_LABEL[d.platform]}</b>
          <span>${maskKey(d)}</span>
        </div>
        <button class="dest-del" data-del="${i}" title="Remove">✕</button>`;
      list.appendChild(row);
    });
    $('#stat-dest').textContent = destinations.filter(d => d.enabled).length;
  }

  function maskKey(d) {
    const raw = d.platform === 'custom' ? d.value.replace(/^rtmps?:\/\//, '') : d.value;
    return raw.length <= 8 ? '••••' : raw.slice(0, 4) + '••••' + raw.slice(-4);
  }

  $('#dest-add-btn').addEventListener('click', () => {
    const platform = $('#dest-platform').value;
    const value = $('#dest-key').value.trim();
    if (!value) return;
    if (platform === 'custom' && !RTMP_RE.test(value)) {
      logLine('✗ Custom destination must be a full rtmp:// or rtmps:// URL.');
      return;
    }
    destinations.push({ platform, value, enabled: true });
    save(DEST_KEY, destinations);
    $('#dest-key').value = '';
    renderDests();
  });

  $('#dest-key').addEventListener('keydown', e => { if (e.key === 'Enter') $('#dest-add-btn').click(); });

  $('#dest-list').addEventListener('click', e => {
    const del = e.target.closest('[data-del]');
    if (del) {
      destinations.splice(Number(del.dataset.del), 1);
      save(DEST_KEY, destinations);
      renderDests();
    }
  });
  $('#dest-list').addEventListener('change', e => {
    const cb = e.target.closest('input[data-i]');
    if (cb) {
      destinations[Number(cb.dataset.i)].enabled = cb.checked;
      save(DEST_KEY, destinations);
      renderDests();
    }
  });

  $('#dest-platform').addEventListener('change', e => {
    $('#dest-key').placeholder = e.target.value === 'custom'
      ? 'rtmp://server/app/streamkey' : 'Stream key';
    $('#dest-key').type = e.target.value === 'custom' ? 'text' : 'password';
  });

  /* ------------------------------ go live ------------------------------ */

  $('#btn-record').addEventListener('click', () => {
    if (state.live) return;
    state.recordLocally = !state.recordLocally;
    $('#btn-record').innerHTML = `⏺ <b>${state.recordLocally ? 'on' : 'off'}</b>`;
    $('#btn-record').classList.toggle('rec-on', state.recordLocally);
  });

  $('#btn-golive').addEventListener('click', () => (state.live ? stopLive() : startLive()));

  function activeUrls() {
    return destinations.filter(d => d.enabled)
      .map(d => INGEST[d.platform](d.value))
      .filter(u => RTMP_RE.test(u));
  }

  function pickMime() {
    const prefs = [
      'video/webm;codecs=h264,opus',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ];
    return prefs.find(m => MediaRecorder.isTypeSupported(m)) || '';
  }

  function startLive() {
    setLiveUi('connecting');

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/stream`);
    ws.binaryType = 'arraybuffer';
    state.mediaWs = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: 'start', room: roomId, hostKey,
        destinations: activeUrls(), width: W, height: H, fps: FPS,
      }));
    };

    ws.onmessage = ev => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'started') {
        beginRecorder();
        state.live = true;
        state.liveStart = Date.now();
        setLiveUi('live');
        logLine(`● LIVE — watch page + ${msg.destinations} RTMP destination(s).`);
      } else if (msg.type === 'log') {
        logLine(msg.message);
      } else if (msg.type === 'error') {
        logLine('✗ ' + msg.message);
        stopLive(true);
      } else if (msg.type === 'ended') {
        if (state.live) {
          logLine(`✗ Encoder exited (code ${msg.code}).${msg.log ? '\n' + msg.log : ''}`);
          stopLive(true);
        }
      }
    };

    ws.onerror = () => { logLine('✗ Could not reach the streaming server.'); setLiveUi('idle'); };
    ws.onclose = () => { if (state.live) { logLine('✗ Connection to server lost.'); stopLive(true); } };
  }

  function beginRecorder() {
    const stream = canvas.captureStream(FPS);
    mixDest.stream.getAudioTracks().forEach(t => stream.addTrack(t));
    state.recordedChunks = [];
    state.recorder = new MediaRecorder(stream, {
      mimeType: pickMime(),
      videoBitsPerSecond: 3_500_000,
      audioBitsPerSecond: 160_000,
    });
    state.recorder.ondataavailable = async e => {
      if (!e.data.size) return;
      if (state.recordLocally) state.recordedChunks.push(e.data);
      if (state.mediaWs && state.mediaWs.readyState === WebSocket.OPEN) {
        state.mediaWs.send(await e.data.arrayBuffer());
      }
    };
    state.recorder.start(500); // 500ms chunks keep glass-to-glass latency low
  }

  function stopLive(fromError = false) {
    const wasLive = state.live;
    state.live = false;

    if (state.recorder && state.recorder.state !== 'inactive') state.recorder.stop();
    state.recorder = null;

    if (state.mediaWs) {
      if (state.mediaWs.readyState === WebSocket.OPEN) state.mediaWs.send(JSON.stringify({ type: 'stop' }));
      const ws = state.mediaWs;
      setTimeout(() => { try { ws.close(); } catch { /* ok */ } }, 1500);
      state.mediaWs = null;
    }

    if (wasLive && state.recordLocally && state.recordedChunks.length) downloadRecording();
    setLiveUi('idle');
    if (wasLive && !fromError) logLine('■ Stream ended.');
  }

  function downloadRecording() {
    const blob = new Blob(state.recordedChunks, { type: 'video/webm' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `lumio-${new Date().toISOString().replace(/[:.]/g, '-')}.webm`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    state.recordedChunks = [];
    logLine('⬇ Local recording saved.');
  }

  /* ------------------------------ UI helpers ------------------------------ */

  function elapsed() {
    const s = Math.floor((Date.now() - state.liveStart) / 1000);
    const pad = n => String(n).padStart(2, '0');
    return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
  }

  function setLiveUi(mode) {
    const pill = $('#live-pill'), label = $('#live-label'),
          btn = $('#btn-golive'), timer = $('#live-timer');
    pill.className = `live-pill ${mode}`;
    if (mode === 'live') {
      label.textContent = 'LIVE';
      btn.textContent = 'End Stream';
      btn.disabled = false;
      btn.classList.add('ending');
      timer.classList.remove('hidden');
      state.timerId = setInterval(() => { timer.textContent = elapsed(); }, 1000);
    } else {
      label.textContent = mode === 'connecting' ? 'CONNECTING…' : 'OFFLINE';
      btn.textContent = mode === 'connecting' ? 'Connecting…' : 'Go Live';
      btn.classList.remove('ending');
      btn.disabled = mode === 'connecting';
      if (mode === 'idle') btn.disabled = false;
      timer.classList.add('hidden');
      clearInterval(state.timerId);
    }
    $('#stat-state').textContent = mode === 'live' ? 'Live' : mode === 'connecting' ? 'Connecting' : 'Idle';
  }

  const logEl = $('#log');
  function logLine(s) {
    logEl.textContent = (logEl.textContent + '\n' + s).split('\n').slice(-80).join('\n');
    logEl.scrollTop = logEl.scrollHeight;
  }

  window.addEventListener('beforeunload', e => {
    if (state.live) { e.preventDefault(); e.returnValue = ''; }
  });

  /* ------------------------------ boot ------------------------------ */

  renderDests();
  populateDevices();
  navigator.mediaDevices.addEventListener?.('devicechange', populateDevices);
})();

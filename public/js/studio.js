/* =========================================================================
 * Lumio Studio — host engine
 *
 * Ties together: local capture, the WebRTC mesh (guests), a canvas
 * compositor (layouts + branding + banners + ticker), a Web Audio mixer
 * (host + all guests + screen), and the go-live path to the FFmpeg relay.
 * ========================================================================= */
(() => {
  'use strict';

  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const W = 1280, H = 720, FPS = 30;

  const roomId = (location.hash.slice(1) || Math.random().toString(36).slice(2, 8));
  location.hash = roomId;

  const state = {
    mesh: null,
    localStream: null,
    screenStream: null,
    selfMeta: { id: 'self', name: 'Host', role: 'host', onstage: true, mic: true, cam: true },
    roster: [],
    remote: new Map(),          // id -> { camVideo, screenVideo, camStream, screenStream }
    selfVideo: null,
    layout: 'auto',
    live: false, liveStart: 0,
    recordLocally: false, recordedChunks: [],
    ws: null, recorder: null, timerId: null,
  };

  const brand = {
    title: '', showTitle: false, color: '#7c3aed', mirror: false,
    logo: null, bg: null,
  };
  let banners = [];            // { id, name, title }
  let activeBannerId = null;
  let ticker = { text: '', on: false, x: W };
  let destinations = load('lumio.dest.v2') || [];

  function load(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }
  function save(k, v) { localStorage.setItem(k, JSON.stringify(v)); }

  /* ------------------------------ audio mixer ------------------------------ */
  let actx, mixDest, analyser;
  const audioNodes = new Map(); // streamId -> MediaStreamAudioSourceNode

  function initAudio() {
    actx = new (window.AudioContext || window.webkitAudioContext)();
    mixDest = actx.createMediaStreamDestination();
    analyser = actx.createAnalyser();
    analyser.fftSize = 256;
    addAudio(state.localStream, true);
    requestAnimationFrame(vuLoop);
  }
  function addAudio(stream, isSelf = false) {
    if (!stream || audioNodes.has(stream.id)) return;
    if (!stream.getAudioTracks().length) return;
    const src = actx.createMediaStreamSource(stream);
    src.connect(mixDest);
    if (isSelf) src.connect(analyser);
    audioNodes.set(stream.id, src);
  }
  function removeAudio(stream) {
    if (!stream) return;
    const n = audioNodes.get(stream.id);
    if (n) { try { n.disconnect(); } catch { /* ok */ } audioNodes.delete(stream.id); }
  }
  function vuLoop() {
    if (analyser) {
      const buf = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteFrequencyData(buf);
      const lvl = Math.min(100, Math.round((buf.reduce((a, b) => a + b, 0) / buf.length) / 1.6));
      $('#vu-bar').style.width = (state.selfMeta.mic ? lvl : 0) + '%';
    }
    requestAnimationFrame(vuLoop);
  }

  /* ------------------------------ setup gate ------------------------------ */
  let previewStream = null;
  async function refreshPreview() {
    try {
      if (previewStream) previewStream.getTracks().forEach(t => t.stop());
      previewStream = await LumioMedia.getStream($('#gate-cam').value, $('#gate-mic').value);
      $('#gate-video').srcObject = previewStream;
    } catch { /* ignore */ }
  }
  $('#gate-cam').addEventListener('change', refreshPreview);
  $('#gate-mic').addEventListener('change', refreshPreview);

  $('#gate-enter').addEventListener('click', async () => {
    const err = $('#gate-error'); err.classList.add('hidden');
    const name = $('#gate-name').value.trim() || 'Host';
    try {
      state.localStream = previewStream && previewStream.active
        ? previewStream
        : await LumioMedia.getStream($('#gate-cam').value, $('#gate-mic').value);
      previewStream = null;
    } catch (e) {
      err.textContent = `Could not access camera/mic: ${e.message}`;
      err.classList.remove('hidden'); return;
    }
    state.selfMeta.name = name;
    state.selfVideo = mkVideo(state.localStream, true);

    initAudio();

    state.mesh = new MeshRTC({ room: roomId, role: 'host', name });
    wireMesh(state.mesh);
    try { await state.mesh.connect(state.localStream); }
    catch (e) { err.textContent = e.message; err.classList.remove('hidden'); return; }

    $('#gate').classList.add('hidden');
    $('#studio').classList.remove('hidden');
    $('#btn-golive').disabled = false;
    renderPeople();
    pushBrand();
  });

  function mkVideo(stream, muted) {
    const v = document.createElement('video');
    v.autoplay = true; v.playsInline = true; v.muted = muted;
    v.srcObject = stream;
    v.play().catch(() => {});
    return v;
  }

  /* ------------------------------ mesh wiring ------------------------------ */
  function wireMesh(mesh) {
    mesh.addEventListener('ready', e => { state.selfMeta.id = e.detail.id; });
    mesh.addEventListener('roster', e => {
      state.roster = e.detail.roster;
      // keep hearing all guests: ensure remote audio nodes exist
      renderPeople();
    });
    mesh.addEventListener('stream', e => {
      const { id, kind, stream } = e.detail;
      let r = state.remote.get(id);
      if (!r) { r = {}; state.remote.set(id, r); }
      if (kind === 'screen') {
        r.screenStream = stream; r.screenVideo = mkVideo(stream, true);
        addAudio(stream);
      } else {
        r.camStream = stream; r.camVideo = mkVideo(stream, false); // audible
        addAudio(stream);
      }
    });
    mesh.addEventListener('streamgone', e => {
      const r = state.remote.get(e.detail.id); if (!r) return;
      if (e.detail.kind === 'screen') { removeAudio(r.screenStream); r.screenStream = r.screenVideo = null; }
    });
    mesh.addEventListener('leave', e => {
      const r = state.remote.get(e.detail.id);
      if (r) { removeAudio(r.camStream); removeAudio(r.screenStream); }
      state.remote.delete(e.detail.id);
      renderPeople();
    });
    mesh.addEventListener('chat', e => addChat(e.detail.name, e.detail.text, e.detail.from === state.selfMeta.id));
  }

  /* ------------------------------ people / stage ------------------------------ */
  function allPeople() {
    const map = new Map();
    map.set(state.selfMeta.id, { ...state.selfMeta, self: true });
    for (const p of state.roster) {
      if (p.id === state.selfMeta.id) { map.set(p.id, { ...p, self: true, name: state.selfMeta.name }); }
      else map.set(p.id, p);
    }
    return [...map.values()];
  }
  function onstagePeople() {
    return allPeople().filter(p => p.onstage)
      .sort((a, b) => (a.role === 'host' ? -1 : 1) - (b.role === 'host' ? -1 : 1));
  }

  function tileFor(p) {
    if (p.self) return { video: state.selfVideo, camOn: state.selfMeta.cam, name: state.selfMeta.name, mic: state.selfMeta.mic, self: true };
    const r = state.remote.get(p.id) || {};
    return { video: r.camVideo, camOn: p.cam, name: p.name, mic: p.mic, self: false };
  }

  function activeScreen() {
    if (state.screenStream) return mkOrGetSelfScreenVideo();
    for (const p of onstagePeople()) {
      const r = state.remote.get(p.id);
      if (r && r.screenVideo) return r.screenVideo;
    }
    return null;
  }
  let _selfScreenVideo = null;
  function mkOrGetSelfScreenVideo() {
    if (state.screenStream && (!_selfScreenVideo || _selfScreenVideo.srcObject !== state.screenStream)) {
      _selfScreenVideo = mkVideo(state.screenStream, true);
    }
    return state.screenStream ? _selfScreenVideo : null;
  }

  function renderPeople() {
    const people = allPeople();
    const on = $('#onstage-list'), back = $('#backstage-list');
    on.innerHTML = ''; back.innerHTML = '';
    for (const p of people) {
      const row = document.createElement('div');
      row.className = 'person';
      const badges = `${p.mic === false ? '<span class="pmute">🔇</span>' : ''}${p.cam === false ? '<span class="pmute">🚫</span>' : ''}`;
      row.innerHTML = `
        <div class="pavatar" style="background:${p.self ? brand.color : '#2a1e4d'}">${(p.name || '?')[0].toUpperCase()}</div>
        <div class="pinfo"><b>${escapeHtml(p.name)}${p.self ? ' (you)' : ''}</b><span>${p.role === 'host' ? 'Host' : 'Guest'} ${badges}</span></div>
        <div class="pactions"></div>`;
      const actions = row.querySelector('.pactions');
      if (!p.self) {
        const stageBtn = document.createElement('button');
        stageBtn.className = 'btn btn-sm ' + (p.onstage ? 'btn-ghost' : 'btn-primary');
        stageBtn.textContent = p.onstage ? 'Remove' : 'Add to stage';
        stageBtn.onclick = () => state.mesh.setStage(p.id, !p.onstage);
        actions.appendChild(stageBtn);
        const kickBtn = document.createElement('button');
        kickBtn.className = 'btn btn-danger btn-sm'; kickBtn.textContent = '✕'; kickBtn.title = 'Remove guest';
        kickBtn.onclick = () => { if (confirm(`Remove ${p.name} from the studio?`)) state.mesh.kick(p.id); };
        actions.appendChild(kickBtn);
      }
      (p.onstage ? on : back).appendChild(row);
    }
    if (!back.children.length) back.innerHTML = '<p class="dest-empty">No one backstage. Share an invite link to bring on guests.</p>';
  }

  /* ------------------------------ compositor ------------------------------ */
  const canvas = $('#program');
  const ctx = canvas.getContext('2d', { alpha: false });
  const ready = v => v && v.srcObject && v.readyState >= 2 && v.videoWidth > 0;

  function drawCover(v, x, y, w, h, mirror = false, radius = 0) {
    const vw = v.videoWidth, vh = v.videoHeight;
    const scale = Math.max(w / vw, h / vh);
    const sw = w / scale, sh = h / scale, sx = (vw - sw) / 2, sy = (vh - sh) / 2;
    ctx.save();
    if (radius) { ctx.beginPath(); ctx.roundRect(x, y, w, h, radius); ctx.clip(); }
    if (mirror) { ctx.translate(x + w, y); ctx.scale(-1, 1); ctx.drawImage(v, sx, sy, sw, sh, 0, 0, w, h); }
    else ctx.drawImage(v, sx, sy, sw, sh, x, y, w, h);
    ctx.restore();
  }
  function drawContain(v, x, y, w, h) {
    const vw = v.videoWidth, vh = v.videoHeight, s = Math.min(w / vw, h / vh);
    const dw = vw * s, dh = vh * s;
    ctx.fillStyle = '#000'; ctx.fillRect(x, y, w, h);
    ctx.drawImage(v, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  }

  function tileCard(p, x, y, w, h) {
    const t = tileFor(p);
    ctx.save();
    ctx.beginPath(); ctx.roundRect(x, y, w, h, 14); ctx.clip();
    if (t.camOn && ready(t.video)) drawCover(t.video, x, y, w, h, t.self && brand.mirror);
    else {
      ctx.fillStyle = '#191130'; ctx.fillRect(x, y, w, h);
      const r = Math.min(w, h) * 0.16, cx = x + w / 2, cy = y + h / 2;
      ctx.fillStyle = brand.color; ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = `700 ${Math.round(r)}px Inter, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText((t.name || '?')[0].toUpperCase(), cx, cy + r * 0.05);
    }
    ctx.restore();
    // name tag
    ctx.font = '600 18px Inter, sans-serif';
    const label = t.name + (t.mic === false ? '  🔇' : '');
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(11,7,22,0.72)';
    ctx.beginPath(); ctx.roundRect(x + 12, y + h - 40, tw + 26, 28, 7); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(label, x + 24, y + h - 25);
    ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.roundRect(x, y, w, h, 14); ctx.stroke();
  }

  function gridRects(n, x, y, w, h, gap = 12) {
    let cols = 1;
    if (n <= 1) cols = 1; else if (n <= 2) cols = 2; else if (n <= 4) cols = 2;
    else if (n <= 6) cols = 3; else cols = 4;
    const rows = Math.ceil(n / cols);
    const cw = (w - gap * (cols - 1)) / cols, ch = (h - gap * (rows - 1)) / rows;
    const rects = [];
    for (let i = 0; i < n; i++) {
      const rN = Math.floor(i / cols), cN = i % cols;
      const inRow = Math.min(cols, n - rN * cols);
      const rowW = inRow * cw + (inRow - 1) * gap, offX = x + (w - rowW) / 2;
      rects.push([offX + cN * (cw + gap), y + rN * (ch + gap), cw, ch]);
    }
    return rects;
  }

  function drawFrame() {
    // background
    if (brand.bg) drawCover(brand.bg, 0, 0, W, H);
    else { const g = ctx.createLinearGradient(0, 0, W, H); g.addColorStop(0, '#0b0716'); g.addColorStop(1, '#171029'); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); }

    const people = onstagePeople();
    const screen = activeScreen();
    let layout = state.layout;
    if (layout === 'screen' && !ready(screen)) layout = 'auto';
    if (layout === 'pip' && !ready(screen)) layout = 'auto';
    if (layout === 'news' && !ready(screen)) layout = 'auto';

    const pad = 24;
    if (layout === 'auto') {
      const list = people.length ? people : [{ ...state.selfMeta, self: true }];
      gridRects(list.length, pad, brand.showTitle ? 78 : pad, W - pad * 2, H - (brand.showTitle ? 78 : pad) - pad)
        .forEach((r, i) => tileCard(list[i], ...r));
    } else if (layout === 'solo') {
      const p = people[0] || { ...state.selfMeta, self: true };
      tileCard(p, pad, brand.showTitle ? 78 : pad, W - pad * 2, H - (brand.showTitle ? 78 : pad) - pad);
    } else if (layout === 'screen') {
      drawContain(screen, pad, pad, W - pad * 2, H - pad * 2);
    } else if (layout === 'pip') {
      drawContain(screen, 0, 0, W, H);
      const p = people[0]; if (p) tileCard(p, W - 300 - 28, H - 169 - 28, 300, 169);
    } else if (layout === 'news') {
      const sideW = 300, sx = W - sideW - pad;
      drawContain(screen, pad, pad, sx - pad * 2, H - pad * 2);
      const list = people.slice(0, 4);
      gridRects(list.length, sx, pad, sideW, H - pad * 2).forEach((r, i) => {
        const [x, y, w] = r; tileCard(list[i], x, y, w, w * 9 / 16);
      });
    }

    drawBranding();
    drawBannerAndTicker();
    if (state.live) drawLiveBadge();
  }

  function drawBranding() {
    if (brand.showTitle && brand.title) {
      ctx.fillStyle = 'rgba(11,7,22,0.82)'; ctx.fillRect(0, 0, W, 58);
      ctx.fillStyle = brand.color; ctx.fillRect(0, 54, W, 4);
      ctx.fillStyle = '#fff'; ctx.font = '600 26px Inter, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(brand.title, W / 2, 30);
    }
    if (brand.logo) {
      const lh = 54, lw = lh * (brand.logo.naturalWidth / brand.logo.naturalHeight || 1);
      ctx.drawImage(brand.logo, W - lw - 24, brand.showTitle ? 70 : 24, lw, lh);
    }
  }

  function drawBannerAndTicker() {
    const b = banners.find(x => x.id === activeBannerId);
    if (b) {
      ctx.font = '700 26px Inter, sans-serif';
      const nameW = ctx.measureText(b.name).width;
      ctx.font = '500 18px Inter, sans-serif';
      const titleW = b.title ? ctx.measureText(b.title).width : 0;
      const bw = Math.max(nameW, titleW) + 60, bh = b.title ? 78 : 54;
      const bx = 40, by = ticker.on && ticker.text ? H - bh - 74 : H - bh - 40;
      ctx.fillStyle = 'rgba(11,7,22,0.9)'; ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 10); ctx.fill();
      ctx.fillStyle = brand.color; ctx.beginPath(); ctx.roundRect(bx, by, 8, bh, [10, 0, 0, 10]); ctx.fill();
      ctx.textAlign = 'left'; ctx.fillStyle = '#fff';
      ctx.font = '700 26px Inter, sans-serif'; ctx.textBaseline = 'alphabetic';
      ctx.fillText(b.name, bx + 28, by + (b.title ? 36 : 36));
      if (b.title) { ctx.fillStyle = '#cbb9f5'; ctx.font = '500 18px Inter, sans-serif'; ctx.fillText(b.title, bx + 28, by + 62); }
    }
    if (ticker.on && ticker.text) {
      const barY = H - 46;
      ctx.fillStyle = brand.color; ctx.fillRect(0, barY, W, 46);
      ctx.fillStyle = '#fff'; ctx.font = '600 22px Inter, sans-serif';
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      const text = ticker.text + '     •     ';
      const tw = ctx.measureText(text).width;
      ticker.x -= 2; if (ticker.x < -tw) ticker.x += tw;
      for (let x = ticker.x; x < W; x += tw) ctx.fillText(text, x, barY + 24);
    }
  }

  function drawLiveBadge() {
    const label = `LIVE ${elapsed()}`;
    ctx.font = '800 20px Inter, sans-serif';
    const w = ctx.measureText(label).width + 44;
    ctx.fillStyle = 'rgba(11,7,22,0.8)'; ctx.beginPath(); ctx.roundRect(24, 20, w, 38, 19); ctx.fill();
    ctx.fillStyle = '#ef4444'; ctx.beginPath(); ctx.arc(24 + 20, 39, 6, 0, 7); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(label, 24 + 34, 40);
  }

  setInterval(drawFrame, 1000 / FPS);

  /* ------------------------------ controls ------------------------------ */
  $('#btn-mic').addEventListener('click', () => {
    state.selfMeta.mic = !state.selfMeta.mic;
    state.localStream.getAudioTracks().forEach(t => t.enabled = state.selfMeta.mic);
    $('#btn-mic').classList.toggle('on', state.selfMeta.mic);
    $('#btn-mic').classList.toggle('off', !state.selfMeta.mic);
    state.mesh.setState({ mic: state.selfMeta.mic });
  });
  $('#btn-cam').addEventListener('click', () => {
    state.selfMeta.cam = !state.selfMeta.cam;
    state.localStream.getVideoTracks().forEach(t => t.enabled = state.selfMeta.cam);
    $('#btn-cam').classList.toggle('on', state.selfMeta.cam);
    $('#btn-cam').classList.toggle('off', !state.selfMeta.cam);
    state.mesh.setState({ cam: state.selfMeta.cam });
  });
  $('#btn-screen').addEventListener('click', async () => {
    if (state.screenStream) {
      state.screenStream.getTracks().forEach(t => t.stop());
      removeAudio(state.screenStream);
      await state.mesh.removeScreenStream();
      state.screenStream = null; _selfScreenVideo = null;
      $('#btn-screen').classList.remove('on');
      if (['screen', 'pip', 'news'].includes(state.layout)) setLayout('auto');
      return;
    }
    try { state.screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: FPS }, audio: true }); }
    catch { return; }
    addAudio(state.screenStream);
    await state.mesh.setScreenStream(state.screenStream);
    state.screenStream.getVideoTracks()[0].addEventListener('ended', () => $('#btn-screen').click());
    $('#btn-screen').classList.add('on');
    setLayout('pip');
  });

  function setLayout(l) { state.layout = l; $$('.layout').forEach(b => b.classList.toggle('on', b.dataset.layout === l)); }
  $$('.layout').forEach(b => b.addEventListener('click', () => setLayout(b.dataset.layout)));

  $$('.tab').forEach(t => t.addEventListener('click', () => {
    $$('.tab').forEach(x => x.classList.toggle('on', x === t));
    $$('.tab-panel').forEach(p => p.classList.toggle('hidden', p.id !== `tab-${t.dataset.tab}`));
  }));

  /* ------------------------------ banners / ticker ------------------------------ */
  $('#banner-add').addEventListener('click', () => {
    const name = $('#banner-name').value.trim(); if (!name) return;
    banners.push({ id: Math.random().toString(36).slice(2, 8), name, title: $('#banner-title').value.trim() });
    $('#banner-name').value = ''; $('#banner-title').value = '';
    renderBanners();
  });
  function renderBanners() {
    const list = $('#banner-list'); list.innerHTML = '';
    banners.forEach(b => {
      const row = document.createElement('div');
      row.className = 'banner-row' + (b.id === activeBannerId ? ' active' : '');
      row.innerHTML = `<div class="binfo"><b>${escapeHtml(b.name)}</b><span>${escapeHtml(b.title || '')}</span></div>`;
      const show = document.createElement('button');
      show.className = 'btn btn-sm ' + (b.id === activeBannerId ? 'btn-primary' : 'btn-ghost');
      show.textContent = b.id === activeBannerId ? 'On air' : 'Show';
      show.onclick = () => { activeBannerId = activeBannerId === b.id ? null : b.id; renderBanners(); };
      const del = document.createElement('button');
      del.className = 'btn btn-danger btn-sm'; del.textContent = '✕';
      del.onclick = () => { banners = banners.filter(x => x.id !== b.id); if (activeBannerId === b.id) activeBannerId = null; renderBanners(); };
      row.appendChild(show); row.appendChild(del);
      list.appendChild(row);
    });
  }
  $('#ticker-text').addEventListener('input', e => { ticker.text = e.target.value; });
  $('#ticker-on').addEventListener('change', e => { ticker.on = e.target.checked; ticker.x = W; });

  /* ------------------------------ brand ------------------------------ */
  $('#brand-title').addEventListener('input', e => { brand.title = e.target.value; pushBrand(); });
  $('#brand-show-title').addEventListener('change', e => { brand.showTitle = e.target.checked; });
  $('#brand-color').addEventListener('input', e => { brand.color = e.target.value; renderPeople(); pushBrand(); });
  $('#brand-mirror').addEventListener('change', e => { brand.mirror = e.target.checked; });
  $('#brand-logo').addEventListener('change', e => loadImg(e.target.files[0], img => { brand.logo = img; pushBrand(); }));
  $('#brand-bg').addEventListener('change', e => loadImg(e.target.files[0], img => { brand.bg = img; }));
  $('#brand-clear').addEventListener('click', () => { brand.logo = null; brand.bg = null; $('#brand-logo').value = ''; $('#brand-bg').value = ''; pushBrand(); });
  function loadImg(file, cb) { if (!file) return; const img = new Image(); img.onload = () => cb(img); img.src = URL.createObjectURL(file); }
  function pushBrand() {
    if (!state.mesh) return;
    state.mesh.setBrand({ title: brand.title, color: brand.color, logo: brand.logo ? brand.logo.src : null });
  }

  /* ------------------------------ destinations ------------------------------ */
  const INGEST = {
    youtube: k => `rtmps://a.rtmps.youtube.com:443/live2/${k}`,
    facebook: k => `rtmps://live-api-s.facebook.com:443/rtmp/${k}`,
    custom: u => u,
  };
  const PLABEL = { youtube: 'YouTube', facebook: 'Facebook', custom: 'Custom RTMP' };
  const RTMP_RE = /^rtmps?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?\/\S+$/;

  function renderDests() {
    const list = $('#dest-list'); list.innerHTML = '';
    if (!destinations.length) list.innerHTML = '<p class="dest-empty">No destinations yet.</p>';
    destinations.forEach((d, i) => {
      const raw = d.platform === 'custom' ? d.value.replace(/^rtmps?:\/\//, '') : d.value;
      const mask = raw.length <= 8 ? '••••' : raw.slice(0, 4) + '••••' + raw.slice(-4);
      const row = document.createElement('div');
      row.className = 'dest' + (d.enabled ? ' enabled' : '');
      row.innerHTML = `
        <label class="switch"><input type="checkbox" ${d.enabled ? 'checked' : ''} data-i="${i}"/><span></span></label>
        <div class="dest-info"><b class="${d.platform}">${PLABEL[d.platform]}</b><span>${mask}</span></div>
        <button class="dest-del" data-del="${i}">✕</button>`;
      list.appendChild(row);
    });
  }
  $('#dest-add-btn').addEventListener('click', () => {
    const platform = $('#dest-platform').value, value = $('#dest-key').value.trim();
    if (!value) return;
    if (platform === 'custom' && !RTMP_RE.test(value)) { logLine('✗ Custom must be a full rtmp:// or rtmps:// URL.'); return; }
    destinations.push({ platform, value, enabled: true });
    save('lumio.dest.v2', destinations); $('#dest-key').value = ''; renderDests();
  });
  $('#dest-key').addEventListener('keydown', e => { if (e.key === 'Enter') $('#dest-add-btn').click(); });
  $('#dest-platform').addEventListener('change', e => {
    $('#dest-key').type = e.target.value === 'custom' ? 'text' : 'password';
    $('#dest-key').placeholder = e.target.value === 'custom' ? 'rtmp://server/app/key' : 'Stream key';
  });
  $('#dest-list').addEventListener('click', e => {
    const del = e.target.closest('[data-del]');
    if (del) { destinations.splice(+del.dataset.del, 1); save('lumio.dest.v2', destinations); renderDests(); }
  });
  $('#dest-list').addEventListener('change', e => {
    const cb = e.target.closest('input[data-i]');
    if (cb) { destinations[+cb.dataset.i].enabled = cb.checked; save('lumio.dest.v2', destinations); renderDests(); }
  });

  /* ------------------------------ go live ------------------------------ */
  $('#btn-record').addEventListener('click', () => {
    if (state.live) return;
    state.recordLocally = !state.recordLocally;
    $('#btn-record').innerHTML = `⏺ Record: <b>${state.recordLocally ? 'on' : 'off'}</b>`;
    $('#btn-record').classList.toggle('rec-on', state.recordLocally);
  });
  $('#btn-golive').addEventListener('click', () => state.live ? stopLive() : startLive());

  function activeUrls() {
    return destinations.filter(d => d.enabled).map(d => INGEST[d.platform](d.value)).filter(u => RTMP_RE.test(u));
  }
  function pickMime() {
    return ['video/webm;codecs=h264,opus', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
      .find(m => MediaRecorder.isTypeSupported(m)) || '';
  }
  function startLive() {
    const urls = activeUrls();
    if (!urls.length) { logLine('✗ Add and enable at least one destination first.'); $$('.tab').find(t => t.dataset.tab === 'destinations').click(); return; }
    setLiveUi('connecting');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/stream`); ws.binaryType = 'arraybuffer';
    state.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'start', destinations: urls }));
    ws.onmessage = ev => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'started') { beginRecorder(); state.live = true; state.liveStart = Date.now(); setLiveUi('live'); logLine(`● LIVE → ${m.destinations} destination(s).`); }
      else if (m.type === 'log') logLine(m.message);
      else if (m.type === 'error') { logLine('✗ ' + m.message); stopLive(true); }
      else if (m.type === 'ended' && state.live) { logLine(`✗ Encoder exited (${m.code}).${m.log ? '\n' + m.log : ''}`); stopLive(true); }
    };
    ws.onerror = () => { logLine('✗ Could not reach the streaming server.'); setLiveUi('idle'); };
    ws.onclose = () => { if (state.live) { logLine('✗ Server connection lost.'); stopLive(true); } };
  }
  function beginRecorder() {
    const stream = canvas.captureStream(FPS);
    mixDest.stream.getAudioTracks().forEach(t => stream.addTrack(t));
    state.recordedChunks = [];
    state.recorder = new MediaRecorder(stream, { mimeType: pickMime(), videoBitsPerSecond: 3_500_000, audioBitsPerSecond: 160_000 });
    state.recorder.ondataavailable = async e => {
      if (!e.data.size) return;
      if (state.recordLocally) state.recordedChunks.push(e.data);
      if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(await e.data.arrayBuffer());
    };
    state.recorder.start(500);
  }
  function stopLive(fromError = false) {
    const wasLive = state.live; state.live = false;
    if (state.recorder && state.recorder.state !== 'inactive') state.recorder.stop();
    state.recorder = null;
    if (state.ws) {
      if (state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify({ type: 'stop' }));
      const ws = state.ws; setTimeout(() => { try { ws.close(); } catch { /* ok */ } }, 1500); state.ws = null;
    }
    if (wasLive && state.recordLocally && state.recordedChunks.length) downloadRecording();
    setLiveUi('idle');
    if (wasLive && !fromError) logLine('■ Stream ended.');
  }
  function downloadRecording() {
    const blob = new Blob(state.recordedChunks, { type: 'video/webm' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `lumio-${new Date().toISOString().replace(/[:.]/g, '-')}.webm`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000); state.recordedChunks = [];
    logLine('⬇ Local recording saved.');
  }

  /* ------------------------------ chat ------------------------------ */
  $('#chat-form').addEventListener('submit', e => {
    e.preventDefault();
    const v = $('#chat-input').value.trim(); if (!v) return;
    state.mesh.sendChat(v); addChat(state.selfMeta.name, v, true); $('#chat-input').value = '';
  });
  function addChat(name, text, self) {
    const log = $('#chat-log');
    const el = document.createElement('div'); el.className = 'chat-msg' + (self ? ' me' : '');
    el.innerHTML = `<b>${escapeHtml(name)}</b>${escapeHtml(text)}`;
    log.appendChild(el); log.scrollTop = log.scrollHeight;
  }

  /* ------------------------------ invite ------------------------------ */
  const inviteLink = `${location.origin}/guest.html?room=${roomId}`;
  $('#btn-invite').addEventListener('click', () => { $('#invite-link').value = inviteLink; $('#invite-modal').classList.remove('hidden'); });
  $('#copy-invite').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(inviteLink); } catch { $('#invite-link').select(); document.execCommand('copy'); }
    $('#copy-invite').textContent = 'Copied!'; setTimeout(() => $('#copy-invite').textContent = 'Copy', 1500);
  });
  document.addEventListener('click', e => { if (e.target.closest('[data-close-invite]') || e.target.id === 'invite-modal') $('#invite-modal').classList.add('hidden'); });

  /* ------------------------------ ui helpers ------------------------------ */
  function elapsed() {
    const s = Math.floor((Date.now() - state.liveStart) / 1000), p = n => String(n).padStart(2, '0');
    return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`;
  }
  function setLiveUi(mode) {
    const pill = $('#live-pill'), label = $('#live-label'), btn = $('#btn-golive'), timer = $('#live-timer');
    pill.className = `live-pill ${mode}`;
    if (mode === 'live') {
      label.textContent = 'LIVE'; btn.textContent = 'End Stream'; btn.disabled = false; btn.classList.add('ending');
      timer.classList.remove('hidden'); state.timerId = setInterval(() => timer.textContent = elapsed(), 1000);
    } else {
      label.textContent = mode === 'connecting' ? 'CONNECTING…' : 'OFFLINE';
      btn.textContent = mode === 'connecting' ? 'Connecting…' : 'Go Live';
      btn.classList.remove('ending'); btn.disabled = mode === 'connecting'; timer.classList.add('hidden');
      clearInterval(state.timerId);
    }
    $('#stat-state').textContent = mode === 'live' ? 'Live' : mode === 'connecting' ? 'Connecting' : 'Idle';
  }
  const logEl = $('#log');
  function logLine(s) { logEl.textContent = (logEl.textContent + '\n' + s).split('\n').slice(-80).join('\n'); logEl.scrollTop = logEl.scrollHeight; }
  function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  window.addEventListener('beforeunload', e => { if (state.live) { e.preventDefault(); e.returnValue = ''; } });

  /* ------------------------------ boot ------------------------------ */
  renderDests(); renderBanners();
  LumioMedia.populateDevices($('#gate-cam'), $('#gate-mic')).then(refreshPreview);
  navigator.mediaDevices.addEventListener?.('devicechange', () => LumioMedia.populateDevices($('#gate-cam'), $('#gate-mic')));
})();

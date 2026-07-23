/* =========================================================================
 * Lumio Studio — browser-side engine
 *
 * capture (getUserMedia / getDisplayMedia)
 *   → canvas compositor (layouts, branding)  +  Web Audio mixer
 *   → MediaRecorder (WebM)
 *   → WebSocket → server → FFmpeg → RTMP(S) → YouTube / Facebook / custom
 * ========================================================================= */
(() => {
  'use strict';

  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];

  const W = 1280, H = 720, FPS = 30;
  const DEST_KEY = 'lumio.destinations.v1';
  const BRAND_KEY = 'lumio.brand.v1';

  const INGEST = {
    youtube: key => `rtmps://a.rtmps.youtube.com:443/live2/${key}`,
    facebook: key => `rtmps://live-api-s.facebook.com:443/rtmp/${key}`,
    custom: url => url,
  };
  const PLATFORM_LABEL = { youtube: 'YouTube', facebook: 'Facebook', custom: 'Custom RTMP' };
  const RTMP_RE = /^rtmps?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?\/\S+$/;

  /* ------------------------------ state ------------------------------ */

  const state = {
    camStream: null,
    screenStream: null,
    layout: 'solo',
    micOn: true,
    camOn: true,
    live: false,
    liveStart: 0,
    recordLocally: false,
    recordedChunks: [],
    ws: null,
    recorder: null,
    timerId: null,
  };

  const brand = Object.assign({
    name: '', title: '', color: '#7c3aed',
    showName: true, showTitle: false, mirror: false,
  }, load(BRAND_KEY));

  let destinations = load(DEST_KEY) || [];

  function load(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }
  function save(k, v) { localStorage.setItem(k, JSON.stringify(v)); }

  /* ------------------------------ setup gate ------------------------------ */

  const vCam = $('#v-cam'), vScreen = $('#v-screen');

  async function populateDevices() {
    // Ask once so device labels become readable.
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      probe.getTracks().forEach(t => t.stop());
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

  $('#gate-enter').addEventListener('click', async () => {
    const err = $('#gate-error');
    err.classList.add('hidden');
    try {
      const camId = $('#gate-cam').value, micId = $('#gate-mic').value;
      state.camStream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: camId ? { exact: camId } : undefined, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: { deviceId: micId ? { exact: micId } : undefined, echoCancellation: true, noiseSuppression: true },
      });
    } catch (e) {
      err.textContent = `Could not access camera/mic: ${e.message}. Check browser permissions and try again.`;
      err.classList.remove('hidden');
      return;
    }
    vCam.srcObject = state.camStream;
    brand.name = $('#gate-name').value.trim() || brand.name;
    $('#brand-name').value = brand.name;
    saveBrand();
    initAudio();
    $('#gate').classList.add('hidden');
    $('#studio').classList.remove('hidden');
    $('#btn-golive').disabled = false;
  });

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

  function ready(v) { return v.srcObject && v.readyState >= 2 && v.videoWidth > 0; }

  /** Draw a video into a rect, cropping to fill (object-fit: cover). */
  function drawCover(v, x, y, w, h, mirror = false) {
    const vw = v.videoWidth, vh = v.videoHeight;
    const scale = Math.max(w / vw, h / vh);
    const sw = w / scale, sh = h / scale;
    const sx = (vw - sw) / 2, sy = (vh - sh) / 2;
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 0);
    ctx.clip();
    if (mirror) { ctx.translate(x + w, y); ctx.scale(-1, 1); ctx.drawImage(v, sx, sy, sw, sh, 0, 0, w, h); }
    else ctx.drawImage(v, sx, sy, sw, sh, x, y, w, h);
    ctx.restore();
  }

  /** Draw a video letterboxed (object-fit: contain). */
  function drawContain(v, x, y, w, h) {
    const vw = v.videoWidth, vh = v.videoHeight;
    const scale = Math.min(w / vw, h / vh);
    const dw = vw * scale, dh = vh * scale;
    ctx.drawImage(v, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  }

  function roundedCam(x, y, w, h) {
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 14);
    ctx.clip();
    drawCover(vCam, x, y, w, h, brand.mirror);
    ctx.restore();
    ctx.strokeStyle = brand.color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 14);
    ctx.stroke();
  }

  function drawCamOffCard(x, y, w, h) {
    ctx.fillStyle = '#191130';
    ctx.fillRect(x, y, w, h);
    const initial = (brand.name || 'L')[0].toUpperCase();
    const r = Math.min(w, h) * 0.18;
    const cx = x + w / 2, cy = y + h / 2;
    ctx.fillStyle = brand.color;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = `700 ${Math.round(r)}px Inter, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(initial, cx, cy + r * 0.06);
  }

  function drawFrame() {
    // Background
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#0b0716'); g.addColorStop(1, '#171029');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    const camOk = state.camOn && ready(vCam);
    const scrOk = !!state.screenStream && ready(vScreen);
    const layout = scrOk ? state.layout : 'solo';

    if (layout === 'solo') {
      if (camOk) drawCover(vCam, 0, 0, W, H, brand.mirror);
      else drawCamOffCard(0, 0, W, H);
    } else if (layout === 'screen') {
      drawContain(vScreen, 0, 0, W, H);
    } else if (layout === 'pip') {
      drawContain(vScreen, 0, 0, W, H);
      const pw = 300, ph = 169;
      if (camOk) roundedCam(W - pw - 28, H - ph - 28, pw, ph);
    } else if (layout === 'split') {
      const sw = W * 0.62;
      drawContain(vScreen, 16, (H - (sw * 9 / 16)) / 2, sw, sw * 9 / 16);
      const cw = W - sw - 48, chh = cw * 9 / 16;
      if (camOk) roundedCam(sw + 32, (H - chh) / 2, cw, chh);
      else drawCamOffCard(sw + 32, (H - chh) / 2, cw, chh);
    }

    drawBranding();
    if (state.live) drawLiveBadge();
  }

  function drawBranding() {
    if (brand.showTitle && brand.title) {
      ctx.fillStyle = 'rgba(11,7,22,0.82)';
      ctx.fillRect(0, 0, W, 58);
      ctx.fillStyle = brand.color;
      ctx.fillRect(0, 54, W, 4);
      ctx.fillStyle = '#fff';
      ctx.font = '600 26px Inter, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(brand.title, W / 2, 30);
    }
    if (brand.showName && brand.name) {
      ctx.font = '600 24px Inter, sans-serif';
      const tw = ctx.measureText(brand.name).width;
      const bw = tw + 56, bh = 46, bx = 36, by = H - bh - 34;
      ctx.fillStyle = 'rgba(11,7,22,0.85)';
      ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 8); ctx.fill();
      ctx.fillStyle = brand.color;
      ctx.beginPath(); ctx.roundRect(bx, by, 8, bh, [8, 0, 0, 8]); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(brand.name, bx + 30, by + bh / 2 + 1);
    }
  }

  function drawLiveBadge() {
    const t = elapsed();
    ctx.font = '800 20px Inter, sans-serif';
    const label = `LIVE ${t}`;
    const w = ctx.measureText(label).width + 44;
    ctx.fillStyle = 'rgba(11,7,22,0.8)';
    ctx.beginPath(); ctx.roundRect(W - w - 24, 20, w, 38, 19); ctx.fill();
    ctx.fillStyle = '#ef4444';
    ctx.beginPath(); ctx.arc(W - w - 24 + 20, 39, 6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(label, W - w - 24 + 34, 40);
  }

  setInterval(drawFrame, 1000 / FPS);

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
    vScreen.srcObject = state.screenStream;
    attachScreenAudio();
    state.screenStream.getVideoTracks()[0].addEventListener('ended', stopScreen);
    $('#btn-screen').classList.add('on');
    if (state.layout === 'solo') setLayout('pip');
  });

  function stopScreen() {
    if (state.screenStream) state.screenStream.getTracks().forEach(t => t.stop());
    state.screenStream = null;
    vScreen.srcObject = null;
    if (screenGain) { try { screenGain.disconnect(); } catch { /* ok */ } screenGain = null; }
    $('#btn-screen').classList.remove('on');
    setLayout('solo');
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
  }));

  /* ------------------------------ branding ------------------------------ */

  function saveBrand() { save(BRAND_KEY, brand); }
  $('#brand-name').value = brand.name;
  $('#brand-title').value = brand.title;
  $('#brand-color').value = brand.color;
  $('#brand-show-name').checked = brand.showName;
  $('#brand-show-title').checked = brand.showTitle;
  $('#brand-mirror').checked = brand.mirror;

  $('#brand-name').addEventListener('input', e => { brand.name = e.target.value; saveBrand(); });
  $('#brand-title').addEventListener('input', e => { brand.title = e.target.value; saveBrand(); });
  $('#brand-color').addEventListener('input', e => { brand.color = e.target.value; saveBrand(); });
  $('#brand-show-name').addEventListener('change', e => { brand.showName = e.target.checked; saveBrand(); });
  $('#brand-show-title').addEventListener('change', e => { brand.showTitle = e.target.checked; saveBrand(); });
  $('#brand-mirror').addEventListener('change', e => { brand.mirror = e.target.checked; saveBrand(); });

  /* ------------------------------ destinations ------------------------------ */

  function renderDests() {
    const list = $('#dest-list');
    list.innerHTML = '';
    if (!destinations.length) {
      list.innerHTML = '<p class="dest-empty">No destinations yet — add YouTube, Facebook or a custom RTMP server below.</p>';
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
    $('#btn-record').innerHTML = `⏺ Record locally: <b>${state.recordLocally ? 'on' : 'off'}</b>`;
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
    const urls = activeUrls();
    if (!urls.length) {
      logLine('✗ Add and enable at least one destination first.');
      $$('.tab').find(t => t.dataset.tab === 'destinations').click();
      return;
    }
    setLiveUi('connecting');

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/stream`);
    ws.binaryType = 'arraybuffer';
    state.ws = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'start', destinations: urls, width: W, height: H, fps: FPS }));
    };

    ws.onmessage = ev => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'started') {
        beginRecorder();
        state.live = true;
        state.liveStart = Date.now();
        setLiveUi('live');
        logLine(`● LIVE — streaming to ${msg.destinations} destination(s).`);
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
      if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(await e.data.arrayBuffer());
      }
    };
    state.recorder.start(500); // 500ms chunks keep glass-to-glass latency low
  }

  function stopLive(fromError = false) {
    const wasLive = state.live;
    state.live = false;

    if (state.recorder && state.recorder.state !== 'inactive') state.recorder.stop();
    state.recorder = null;

    if (state.ws) {
      if (state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify({ type: 'stop' }));
      const ws = state.ws;
      setTimeout(() => { try { ws.close(); } catch { /* ok */ } }, 1500);
      state.ws = null;
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

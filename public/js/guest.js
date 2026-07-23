/* =========================================================================
 * Lumio — guest engine
 *
 * Green room → join backstage over WebRTC mesh → host puts you on stage.
 * Guests see & hear everyone in the studio; the audience only sees the
 * host's composed program feed.
 * ========================================================================= */
(() => {
  'use strict';

  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const U = window.LumioUtil;
  const NAME_KEY = 'lumio.name';

  const roomId = U.roomIdFromPath();
  if (!roomId) { location.href = '/'; return; }

  const state = {
    selfId: null,
    camStream: null,
    screenStream: null,
    micOn: true,
    camOn: true,
    onStage: false,
    live: false,
    chatUnread: 0,
  };

  /** peerId -> { peerId, name, role, onStage, camStream, screenStream,
   *              camStreamId, screenStreamId, audioEls: Map<streamId, HTMLAudioElement> } */
  const participants = new Map();

  const signal = new LumioSignal();
  let mesh = null;

  /* ------------------------------ green room ------------------------------ */

  fetch(`/api/rooms/${roomId}`).then(r => r.json()).then(info => {
    if (!info.exists) {
      $('#gate-title').textContent = 'broadcast not found';
      $('#gate-error').textContent = 'This broadcast does not exist or has ended.';
      $('#gate-error').classList.remove('hidden');
      $('#gate-enter').disabled = true;
      return;
    }
    $('#gate-title').textContent = info.title;
    document.title = `Join: ${info.title} — Lumio`;
  }).catch(() => { /* server will validate on join */ });

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

    const name = $('#gate-name').value.trim() || 'Guest';
    localStorage.setItem(NAME_KEY, name);

    participants.set('self', {
      peerId: 'self', name, role: 'guest', onStage: false,
      camStream: state.camStream, screenStream: null, audioEls: new Map(),
    });

    initVu();

    try {
      await connect(name);
    } catch (e) {
      err.textContent = e.message;
      err.classList.remove('hidden');
      return;
    }

    $('#gate').classList.add('hidden');
    $('#studio').classList.remove('hidden');
    $('#btn-leave').classList.remove('hidden');
    render();
  });

  /* --------------------------- signaling + mesh --------------------------- */

  async function connect(name) {
    await signal.connect();

    const joined = new Promise((resolve, reject) => {
      signal.on('joined', resolve);
      signal.on('error', m => reject(new Error(m.message || 'Could not join this broadcast.')));
    });

    signal.send({
      type: 'join', room: roomId, role: 'guest',
      name, camStreamId: state.camStream.id,
    });

    const msg = await joined;
    state.selfId = msg.peerId;
    setLivePill(msg.live);
    (msg.chat || []).forEach(appendChat);

    mesh = new LumioMesh({
      signal,
      selfId: state.selfId,
      getLocalTracks: localTracks,
      onTrack: onRemoteTrack,
      onPeerClosed: () => {},
    });

    signal.on('error', m => toast(m.message));
    signal.on('_disconnected', () => toast('Lost connection to the studio — reload to rejoin.'));
    signal.on('kicked', () => {
      cleanupMedia();
      document.body.innerHTML = '<div class="gate"><div class="gate-card"><h1>Removed from studio</h1>' +
        '<p>The host removed you from this broadcast.</p><a class="btn btn-primary btn-lg" href="/">← Back to Lumio</a></div></div>';
    });

    signal.on('peer-joined', m => { addRemote(m.peer); render(); });
    signal.on('peer-left', m => { removeRemote(m.peerId); render(); });
    signal.on('peer-renamed', m => { const p = participants.get(m.peerId); if (p) { p.name = m.name; render(); } });
    signal.on('peer-media', m => updateRemoteMedia(m));
    signal.on('stage', m => {
      const target = m.peerId === state.selfId ? participants.get('self') : participants.get(m.peerId);
      if (target) target.onStage = m.onStage;
      if (m.peerId === state.selfId) setStagePill(m.onStage);
      render();
    });
    signal.on('rtc', m => mesh.handleSignal(m.from, m.data));
    signal.on('chat', appendChat);
    signal.on('live', m => setLivePill(m.live));
    signal.on('title', m => { document.title = `Join: ${m.title} — Lumio`; });

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
      camStream: null, screenStream: null,
      camStreamId: peer.camStreamId, screenStreamId: peer.screenStreamId,
      audioEls: new Map(),
    });
  }

  function removeRemote(peerId) {
    const p = participants.get(peerId);
    if (!p) return;
    mesh.closePeer(peerId);
    for (const a of p.audioEls.values()) { a.srcObject = null; a.remove(); }
    participants.delete(peerId);
  }

  function updateRemoteMedia(m) {
    const p = participants.get(m.peerId);
    if (!p) return;
    p.camStreamId = m.camStreamId;
    p.screenStreamId = m.screenStreamId;
    if (p.screenStream && p.screenStream.id !== p.screenStreamId) p.screenStream = null;
    if (p.camStream && p.camStream.id === p.screenStreamId) {
      p.screenStream = p.camStream;
      p.camStream = null;
    }
    render();
  }

  function onRemoteTrack(peerId, track, stream) {
    const p = participants.get(peerId);
    if (!p) return;

    const isScreen = p.screenStreamId && stream.id === p.screenStreamId;
    if (isScreen) p.screenStream = stream;
    else p.camStream = stream;

    if (track.kind === 'audio' && !p.audioEls.has(stream.id)) {
      // Guests hear everyone through plain audio elements.
      const a = new Audio();
      a.srcObject = stream;
      a.autoplay = true;
      a.play().catch(() => { /* needs gesture — join click already provided one */ });
      p.audioEls.set(stream.id, a);
    }

    stream.addEventListener('removetrack', () => {
      if (!stream.getTracks().length) {
        if (p.screenStream === stream) p.screenStream = null;
        if (p.camStream === stream) p.camStream = null;
        const a = p.audioEls.get(stream.id);
        if (a) { a.srcObject = null; a.remove(); p.audioEls.delete(stream.id); }
        render();
      }
    });

    render();
  }

  /* ------------------------------ tiles ------------------------------ */

  function tileFor(p, stream, kind) {
    const t = document.createElement('div');
    t.className = 'g-tile' + (p.onStage ? ' onstage' : '') + (kind === 'screen' ? ' screen' : '');
    if (stream && stream.getVideoTracks().length) {
      const v = document.createElement('video');
      v.muted = true; v.autoplay = true; v.playsInline = true;
      v.srcObject = stream;
      if (p.peerId === 'self' && kind === 'cam') v.classList.add('mirror');
      t.appendChild(v);
    } else {
      const av = document.createElement('div');
      av.className = 'g-avatar';
      av.textContent = (p.name || 'G')[0].toUpperCase();
      t.appendChild(av);
    }
    const label = document.createElement('span');
    label.className = 'g-label';
    label.textContent =
      (kind === 'screen' ? '🖥 ' : '') + p.name +
      (p.peerId === 'self' ? ' (you)' : '') +
      (p.onStage ? ' · on stage' : '');
    t.appendChild(label);
    return t;
  }

  function render() {
    const tiles = $('#tiles');
    [...tiles.querySelectorAll('video')].forEach(v => { v.srcObject = null; });
    tiles.innerHTML = '';
    const all = [...participants.values()];
    for (const p of all) {
      if (p.screenStream) tiles.appendChild(tileFor(p, p.screenStream, 'screen'));
      tiles.appendChild(tileFor(p, p.camStream, 'cam'));
    }
    tiles.dataset.count = tiles.children.length;

    const list = $('#people-list');
    list.innerHTML = '';
    for (const p of all) {
      const row = document.createElement('div');
      row.className = 'person' + (p.peerId === 'self' ? ' me' : '');
      row.innerHTML = `
        <span class="person-dot ${p.peerId === 'self' || p.camStream ? 'ok' : 'wait'}"></span>
        <span class="person-name">${U.escapeHtml(p.name)}${p.peerId === 'self' ? ' <i>(you)</i>' : ''}${p.role === 'host' ? ' <i>· host</i>' : ''}</span>
        <span class="person-actions">${p.onStage ? '<b class="tag-onstage">on stage</b>' : '<b class="tag-backstage">backstage</b>'}</span>`;
      list.appendChild(row);
    }
    $('#people-count').textContent = all.length > 1 ? all.length : '';
  }

  /* ------------------------------ controls ------------------------------ */

  $('#btn-mic').addEventListener('click', () => {
    state.micOn = !state.micOn;
    state.camStream.getAudioTracks().forEach(t => { t.enabled = state.micOn; });
    $('#btn-mic').classList.toggle('on', state.micOn);
    $('#btn-mic').classList.toggle('off', !state.micOn);
  });

  $('#btn-cam').addEventListener('click', () => {
    state.camOn = !state.camOn;
    state.camStream.getVideoTracks().forEach(t => { t.enabled = state.camOn; });
    $('#btn-cam').classList.toggle('on', state.camOn);
    $('#btn-cam').classList.toggle('off', !state.camOn);
    render();
  });

  $('#btn-screen').addEventListener('click', async () => {
    if (state.screenStream) { stopScreen(); return; }
    try {
      state.screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    } catch { return; /* user cancelled */ }
    const s = participants.get('self');
    s.screenStream = state.screenStream;
    signal.send({ type: 'media', screenStreamId: state.screenStream.id });
    state.screenStream.getTracks().forEach(track => mesh.addTrackToAll(track, state.screenStream));
    state.screenStream.getVideoTracks()[0].addEventListener('ended', stopScreen);
    $('#btn-screen').classList.add('on');
    render();
  });

  function stopScreen() {
    if (!state.screenStream) return;
    state.screenStream.getTracks().forEach(track => { mesh.removeTrackFromAll(track); track.stop(); });
    signal.send({ type: 'media', screenStreamId: null });
    state.screenStream = null;
    const s = participants.get('self');
    if (s) s.screenStream = null;
    $('#btn-screen').classList.remove('on');
    render();
  }

  $('#btn-leave').addEventListener('click', () => {
    cleanupMedia();
    signal.close();
    location.href = '/';
  });

  function cleanupMedia() {
    if (mesh) mesh.closeAll();
    if (state.camStream) state.camStream.getTracks().forEach(t => t.stop());
    if (state.screenStream) state.screenStream.getTracks().forEach(t => t.stop());
  }

  /* tabs */
  $$('.tab').forEach(t => t.addEventListener('click', () => {
    $$('.tab').forEach(x => x.classList.toggle('on', x === t));
    $$('.tab-panel').forEach(p => p.classList.toggle('hidden', p.id !== `tab-${t.dataset.tab}`));
    if (t.dataset.tab === 'chat') { state.chatUnread = 0; $('#chat-badge').textContent = ''; }
  }));

  /* ------------------------------ chat ------------------------------ */

  function appendChat(m) {
    const list = $('#chat-list');
    const div = document.createElement('div');
    div.className = `chat-msg from-${m.from}`;
    div.innerHTML = `<b>${U.escapeHtml(m.name)}</b><span>${U.escapeHtml(m.text)}</span><i>${U.fmtTime(m.ts)}</i>`;
    list.appendChild(div);
    list.scrollTop = list.scrollHeight;
    if ($('#tab-chat').classList.contains('hidden')) {
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

  /* ------------------------------ VU meter ------------------------------ */

  let analyser;

  function initVu() {
    const actx = new (window.AudioContext || window.webkitAudioContext)();
    const tracks = state.camStream.getAudioTracks();
    if (!tracks.length) return;
    analyser = actx.createAnalyser();
    analyser.fftSize = 256;
    actx.createMediaStreamSource(new MediaStream(tracks)).connect(analyser);
    requestAnimationFrame(vuLoop);
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

  /* ------------------------------ UI helpers ------------------------------ */

  function setLivePill(live) {
    state.live = live;
    $('#live-pill').className = `live-pill ${live ? 'live' : 'idle'}`;
    $('#live-label').textContent = live ? 'LIVE' : 'OFFLINE';
    $('#onstage-banner').classList.toggle('hidden', !(live && state.onStage));
  }

  function setStagePill(onStage) {
    state.onStage = onStage;
    const pill = $('#stage-pill');
    pill.className = `stage-pill ${onStage ? 'onstage' : 'backstage'}`;
    pill.textContent = onStage ? 'On stage' : 'Backstage';
    $('#onstage-banner').classList.toggle('hidden', !onStage);
  }

  let toastTimer;
  function toast(text) {
    let el = $('#toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.className = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 4000);
  }

  window.addEventListener('beforeunload', () => cleanupMedia());

  /* ------------------------------ boot ------------------------------ */

  populateDevices();
  navigator.mediaDevices.addEventListener?.('devicechange', populateDevices);
})();

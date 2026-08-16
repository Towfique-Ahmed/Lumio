/* =========================================================================
 * Lumio Studio — guest engine
 *
 * Join a host's room from a plain browser link, wait in the greenroom,
 * and appear on the host's stage when invited. Sees and hears the host and
 * other on-stage guests over the same WebRTC mesh.
 * ========================================================================= */
(() => {
  'use strict';

  const $ = s => document.querySelector(s);
  const params = new URLSearchParams(location.search);
  const room = (params.get('room') || 'main').slice(0, 64);

  const state = {
    mesh: null, localStream: null, screenStream: null,
    mic: true, cam: true, onstage: false,
    tiles: new Map(),  // id -> { wrap, video }
  };

  /* preview */
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

  /* join */
  $('#gate-enter').addEventListener('click', async () => {
    const err = $('#gate-error'); err.classList.add('hidden');
    const name = $('#gate-name').value.trim();
    if (!name) { err.textContent = 'Please enter your name.'; err.classList.remove('hidden'); return; }
    try {
      state.localStream = previewStream && previewStream.active ? previewStream
        : await LumioMedia.getStream($('#gate-cam').value, $('#gate-mic').value);
      previewStream = null;
    } catch (e) { err.textContent = `Could not access camera/mic: ${e.message}`; err.classList.remove('hidden'); return; }

    state.mesh = new MeshRTC({ room, role: 'guest', name });
    wireMesh(state.mesh);
    try { await state.mesh.connect(state.localStream); }
    catch (e) { err.textContent = e.message; err.classList.remove('hidden'); return; }

    // self tile
    addTile('self', name + ' (you)', state.localStream, true);
    $('#gate').classList.add('hidden');
    $('#room').classList.remove('hidden');
  });

  /* mesh events */
  function wireMesh(mesh) {
    mesh.addEventListener('brand', e => applyBrand(e.detail.brand));
    mesh.addEventListener('roster', e => {
      const me = e.detail.roster.find(p => p.id === mesh.id);
      if (me) setStageState(me.onstage);
    });
    mesh.addEventListener('stream', e => {
      const { id, kind, stream } = e.detail;
      if (kind === 'screen') addTile(id + ':screen', 'Screen', stream, true);
      else addTile(id, nameOf(id), stream, false);
    });
    mesh.addEventListener('streamgone', e => { if (e.detail.kind === 'screen') removeTile(e.detail.id + ':screen'); });
    mesh.addEventListener('leave', e => { removeTile(e.detail.id); removeTile(e.detail.id + ':screen'); });
    mesh.addEventListener('chat', e => addChat(e.detail.name, e.detail.text, e.detail.from === mesh.id));
    mesh.addEventListener('kicked', () => { alert('The host removed you from the studio.'); location.reload(); });
    mesh.addEventListener('closed', () => setBanner('🔌 Disconnected from the studio.'));
  }

  function nameOf(id) {
    const p = (state.mesh.roster || []).find(x => x.id === id);
    return p ? p.name : 'Guest';
  }

  function setStageState(onstage) {
    if (onstage === state.onstage) return;
    state.onstage = onstage;
    const pill = $('#guest-state');
    pill.className = 'live-pill ' + (onstage ? 'live' : 'idle');
    pill.querySelector('span:last-child').textContent = onstage ? 'ON STAGE' : 'BACKSTAGE';
    setBanner(onstage ? '🟢 You are on stage — you are now visible on the broadcast.' : '🟡 You are backstage. The host will bring you on soon.');
  }
  function setBanner(text) { $('#guest-banner').textContent = text; }

  /* tiles */
  function addTile(id, label, stream, muted) {
    let t = state.tiles.get(id);
    if (!t) {
      const wrap = document.createElement('div'); wrap.className = 'gtile';
      const video = document.createElement('video'); video.autoplay = true; video.playsInline = true; video.muted = muted;
      const tag = document.createElement('span'); tag.className = 'gtag'; tag.textContent = label;
      wrap.appendChild(video); wrap.appendChild(tag);
      $('#guest-videos').appendChild(wrap);
      t = { wrap, video, tag }; state.tiles.set(id, t);
    }
    t.tag.textContent = label;
    t.video.srcObject = stream; t.video.play().catch(() => {});
  }
  function removeTile(id) { const t = state.tiles.get(id); if (t) { t.wrap.remove(); state.tiles.delete(id); } }

  /* controls */
  $('#btn-mic').addEventListener('click', () => {
    state.mic = !state.mic; state.localStream.getAudioTracks().forEach(t => t.enabled = state.mic);
    $('#btn-mic').classList.toggle('on', state.mic); $('#btn-mic').classList.toggle('off', !state.mic);
    state.mesh.setState({ mic: state.mic });
  });
  $('#btn-cam').addEventListener('click', () => {
    state.cam = !state.cam; state.localStream.getVideoTracks().forEach(t => t.enabled = state.cam);
    $('#btn-cam').classList.toggle('on', state.cam); $('#btn-cam').classList.toggle('off', !state.cam);
    state.mesh.setState({ cam: state.cam });
  });
  $('#btn-screen').addEventListener('click', async () => {
    if (state.screenStream) {
      state.screenStream.getTracks().forEach(t => t.stop());
      await state.mesh.removeScreenStream(); state.screenStream = null;
      removeTile('self:screen'); $('#btn-screen').classList.remove('on'); return;
    }
    try { state.screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true }); }
    catch { return; }
    await state.mesh.setScreenStream(state.screenStream);
    addTile('self:screen', 'Your screen', state.screenStream, true);
    state.screenStream.getVideoTracks()[0].addEventListener('ended', () => $('#btn-screen').click());
    $('#btn-screen').classList.add('on');
  });
  $('#btn-leave').addEventListener('click', () => { if (confirm('Leave the studio?')) { state.mesh.close(); location.reload(); } });

  /* chat */
  $('#chat-form').addEventListener('submit', e => {
    e.preventDefault(); const v = $('#chat-input').value.trim(); if (!v) return;
    state.mesh.sendChat(v); addChat($('#gate-name').value.trim() || 'You', v, true); $('#chat-input').value = '';
  });
  function addChat(name, text, self) {
    const log = $('#chat-log'); const el = document.createElement('div');
    el.className = 'chat-msg' + (self ? ' me' : '');
    el.innerHTML = `<b>${esc(name)}</b>${esc(text)}`;
    log.appendChild(el); log.scrollTop = log.scrollHeight;
  }

  /* brand on the welcome page + header */
  function applyBrand(brand) {
    if (!brand) return;
    if (brand.color) document.documentElement.style.setProperty('--accent', brand.color);
    if (brand.title) { $('#welcome-h').innerHTML = esc(brand.title); document.title = brand.title + ' — Lumio'; }
  }

  function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  /* boot */
  LumioMedia.populateDevices($('#gate-cam'), $('#gate-mic')).then(refreshPreview);
})();

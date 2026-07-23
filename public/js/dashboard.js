/* =========================================================================
 * Lumio — dashboard (StreamYard-style home)
 *
 * Destinations are connected once here (OAuth popup / manual keys) and
 * stored account-wide; broadcasts are created with a title, description and
 * a destination checklist, then you enter the studio.
 * ========================================================================= */
(() => {
  'use strict';

  const $ = s => document.querySelector(s);
  const U = window.LumioUtil;

  const DEST_KEY = 'lumio.destinations.v2';
  const OWNER_KEY = 'lumio.owner';
  const PLATFORM_LABEL = { youtube: 'YouTube', facebook: 'Facebook', custom: 'Custom RTMP' };
  const RTMP_RE = /^rtmps?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?\/\S+$/;

  function load(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }
  function save(k, v) { localStorage.setItem(k, JSON.stringify(v)); }

  /* This browser's identity for "my broadcasts" (no accounts needed). */
  let owner = localStorage.getItem(OWNER_KEY);
  if (!owner) {
    owner = crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now();
    localStorage.setItem(OWNER_KEY, owner);
  }

  /* ------------------------------ destinations ------------------------------ */

  let destinations = load(DEST_KEY) || [];
  // Give every entry a stable id (used by per-broadcast selections).
  let dirty = false;
  destinations.forEach(d => { if (!d.id) { d.id = Math.random().toString(36).slice(2, 10); dirty = true; } });
  if (dirty) save(DEST_KEY, destinations);

  function saveDests() { save(DEST_KEY, destinations); }

  const platformConfig = { youtube: false, facebook: false };
  fetch('/api/config').then(r => r.json()).then(cfg => {
    Object.assign(platformConfig, cfg);
    // Show the exact callback URLs this server sends — the #1 cause of
    // redirect_uri_mismatch is these not matching the console registration.
    if (cfg.redirectUris) {
      $('#ruri-youtube').value = cfg.redirectUris.youtube;
      $('#ruri-facebook').value = cfg.redirectUris.facebook;
    } else {
      // Old server without redirectUris support — derive from the page origin.
      $('#ruri-youtube').value = `${location.origin}/auth/youtube/callback`;
      $('#ruri-facebook').value = `${location.origin}/auth/facebook/callback`;
    }
  }).catch(() => {});

  /* Refresh stored OAuth connections against the server. */
  destinations.filter(d => d.mode === 'oauth').forEach(d => {
    fetch(`/api/connections/${d.connId}`).then(r => {
      if (r.status === 404) { d.stale = true; renderDests(); }
      else return r.json().then(info => {
        if (info.connection) {
          d.name = info.connection.name;
          d.avatar = info.connection.avatar;
          d.liveEnabled = info.connection.liveEnabled !== false;
          if (d.platform === 'facebook') d.targets = info.connection.targets;
          d.stale = false;
          saveDests(); renderDests();
        }
      });
    }).catch(() => {});
  });

  function destRow(d, i) {
    const row = document.createElement('div');
    row.className = 'dest' + (d.mode === 'oauth' ? ' oauth' : '') + (d.stale ? '' : ' enabled');

    const avatar = d.mode === 'oauth'
      ? (d.avatar
        ? `<img class="dest-avatar" src="${U.escapeHtml(d.avatar)}" alt="" referrerpolicy="no-referrer" />`
        : '<span class="dest-avatar fallback">●</span>')
      : '';

    let sub = '';
    if (d.stale) {
      sub = '<span class="dest-stale">Connection expired</span>';
    } else if (d.mode === 'oauth' && d.platform === 'youtube') {
      const warn = d.liveEnabled === false
        ? '<span class="dest-stale">⚠ Enable live streaming in YouTube Studio first</span>' : '';
      sub = `${warn}<select class="dest-sub" data-privacy="${i}" title="YouTube privacy">
               ${['public', 'unlisted', 'private'].map(p =>
                 `<option value="${p}" ${d.privacy === p ? 'selected' : ''}>${p}</option>`).join('')}
             </select>`;
    } else if (d.mode === 'oauth' && d.platform === 'facebook') {
      sub = `<select class="dest-sub" data-target="${i}" title="Where to go live">
               ${(d.targets || []).map(t =>
                 `<option value="${U.escapeHtml(t.id)}" ${d.targetId === t.id ? 'selected' : ''}>${U.escapeHtml(t.name)}</option>`).join('')}
             </select>`;
    } else {
      const raw = d.platform === 'custom' ? d.value.replace(/^rtmps?:\/\//, '') : d.value;
      sub = `<span>${raw.length <= 8 ? '••••' : raw.slice(0, 4) + '••••' + raw.slice(-4)}</span>`;
    }

    row.innerHTML = `
      ${avatar}
      <div class="dest-info">
        <b class="${d.platform}">${PLATFORM_LABEL[d.platform]}${d.mode === 'oauth' ? ` · ${U.escapeHtml(d.name)}` : ' <i class="dest-mode">stream key</i>'}</b>
        ${sub}
      </div>
      ${d.stale ? `<button class="btn btn-primary btn-xs" data-reconnect="${d.platform}">Reconnect</button>` : ''}
      <button class="dest-del" data-del="${i}" title="Remove">✕</button>`;
    return row;
  }

  function renderDests() {
    const list = $('#dest-list');
    list.innerHTML = '';
    if (!destinations.length) {
      list.innerHTML = '<p class="dest-empty">Nothing connected yet. Connect YouTube or Facebook — or add a custom RTMP destination.</p>';
    }
    destinations.forEach((d, i) => list.appendChild(destRow(d, i)));
  }

  $('#dest-list').addEventListener('click', e => {
    const rec = e.target.closest('[data-reconnect]');
    if (rec) { connectClick(rec.dataset.reconnect); return; }
    const del = e.target.closest('[data-del]');
    if (del) {
      const d = destinations[Number(del.dataset.del)];
      if (d && d.mode === 'oauth' && !d.stale) fetch(`/api/connections/${d.connId}`, { method: 'DELETE' }).catch(() => {});
      destinations.splice(Number(del.dataset.del), 1);
      saveDests(); renderDests();
    }
  });

  $('#dest-list').addEventListener('change', e => {
    const priv = e.target.closest('select[data-privacy]');
    if (priv) { destinations[Number(priv.dataset.privacy)].privacy = priv.value; saveDests(); return; }
    const tgt = e.target.closest('select[data-target]');
    if (tgt) { destinations[Number(tgt.dataset.target)].targetId = tgt.value; saveDests(); }
  });

  /* ---- OAuth connect + first-run wizard ---- */

  function openAuthPopup(platform) {
    const w = 560, h = 720;
    const x = window.screenX + (window.outerWidth - w) / 2;
    const y = window.screenY + (window.outerHeight - h) / 2;
    // Unique name per open — a reused name would hijack a still-closing popup.
    window.open(`/auth/${platform}`, `lumio-auth-${Date.now()}`,
      `popup=yes,width=${w},height=${h},left=${x},top=${y}`);
  }

  function connectClick(platform) {
    if (platformConfig[platform]) openAuthPopup(platform);
    else openSetup(platform);
  }

  $('#connect-youtube').addEventListener('click', () => connectClick('youtube'));
  $('#connect-facebook').addEventListener('click', () => connectClick('facebook'));

  window.addEventListener('message', ev => {
    if (ev.origin !== location.origin || !ev.data || ev.data.type !== 'lumio-auth') return;
    if (ev.data.error) { alert(`${PLATFORM_LABEL[ev.data.platform]} connect failed: ${ev.data.error}`); return; }
    const c = ev.data.connection;
    destinations = destinations.filter(d => !(d.mode === 'oauth' && d.platform === c.platform && d.name === c.name));
    if (c.platform === 'youtube') {
      destinations.push({
        id: Math.random().toString(36).slice(2, 10),
        mode: 'oauth', platform: 'youtube', connId: c.id,
        name: c.name, avatar: c.avatar, privacy: 'public',
        liveEnabled: c.liveEnabled !== false, enabled: true,
      });
    } else {
      const profile = (c.targets || []).find(t => t.type === 'profile');
      destinations.push({
        id: Math.random().toString(36).slice(2, 10),
        mode: 'oauth', platform: 'facebook', connId: c.id,
        name: c.name, avatar: c.avatar, targets: c.targets || [],
        targetId: profile ? profile.id : (c.targets[0] && c.targets[0].id),
        enabled: true,
      });
    }
    saveDests(); renderDests();
  });

  const SETUP = {
    youtube: {
      title: 'Set up the YouTube connection',
      idLabel: 'OAuth client ID',
      secretLabel: 'OAuth client secret',
      steps: [
        'Open <a href="https://console.cloud.google.com/" target="_blank" rel="noopener">Google Cloud Console</a> and create (or pick) a project.',
        'APIs &amp; Services → <b>Enable APIs</b> → enable <b>YouTube Data API v3</b>.',
        'OAuth consent screen → External → add yourself as a test user.',
        'Credentials → <b>Create credentials → OAuth client ID → Web application</b>.',
        'Add the <b>redirect URI below</b>, create, then copy the client ID &amp; secret here.',
      ],
    },
    facebook: {
      title: 'Set up the Facebook connection',
      idLabel: 'App ID',
      secretLabel: 'App secret',
      steps: [
        'Open <a href="https://developers.facebook.com/apps/" target="_blank" rel="noopener">Meta for Developers</a> → <b>Create app</b> (type: Business).',
        'Add the <b>Facebook Login</b> product.',
        'Facebook Login → Settings → add the <b>redirect URI below</b> to “Valid OAuth Redirect URIs”.',
        'App settings → Basic → copy the <b>App ID</b> and <b>App secret</b> here.',
        'While the app is in Development mode, add your account under App roles → Testers.',
      ],
    },
  };

  let setupPlatform = null;

  function openSetup(platform) {
    setupPlatform = platform;
    const s = SETUP[platform];
    $('#setup-title').textContent = s.title;
    $('#setup-id-label').textContent = s.idLabel;
    $('#setup-secret-label').textContent = s.secretLabel;
    $('#setup-steps').innerHTML = s.steps.map(x => `<li>${x}</li>`).join('');
    $('#setup-redirect').value = `${location.origin}/auth/${platform}/callback`;
    $('#setup-client-id').value = '';
    $('#setup-client-secret').value = '';
    $('#setup-error').classList.add('hidden');
    $('#setup-modal').classList.remove('hidden');
  }

  $('#setup-cancel').addEventListener('click', () => $('#setup-modal').classList.add('hidden'));

  $('#setup-save').addEventListener('click', async () => {
    const err = $('#setup-error');
    err.classList.add('hidden');
    $('#setup-save').disabled = true;
    try {
      const res = await fetch(`/api/setup/${setupPlatform}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId: $('#setup-client-id').value,
          clientSecret: $('#setup-client-secret').value,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      platformConfig[setupPlatform] = true;
      $('#setup-modal').classList.add('hidden');
      openAuthPopup(setupPlatform);
    } catch (e) {
      err.textContent = e.message;
      err.classList.remove('hidden');
    } finally {
      $('#setup-save').disabled = false;
    }
  });

  /* Copy buttons. */
  document.addEventListener('click', async e => {
    const b = e.target.closest('[data-copy]');
    if (!b) return;
    const input = $('#' + b.dataset.copy);
    if (!input) return;
    try { await navigator.clipboard.writeText(input.value); } catch { input.select(); document.execCommand('copy'); }
    b.textContent = 'Copied!';
    setTimeout(() => { b.textContent = 'Copy'; }, 1500);
  });

  /* ---- manual RTMP modal ---- */

  $('#add-rtmp').addEventListener('click', () => {
    $('#rtmp-error').classList.add('hidden');
    $('#rtmp-key').value = '';
    $('#rtmp-modal').classList.remove('hidden');
  });
  $('#rtmp-cancel').addEventListener('click', () => $('#rtmp-modal').classList.add('hidden'));
  $('#rtmp-platform').addEventListener('change', e => {
    $('#rtmp-key-label').textContent = e.target.value === 'custom' ? 'RTMP URL incl. key' : 'Stream key';
    $('#rtmp-key').placeholder = e.target.value === 'custom' ? 'rtmp://server/app/streamkey' : 'Stream key';
  });
  $('#rtmp-save').addEventListener('click', () => {
    const platform = $('#rtmp-platform').value;
    const value = $('#rtmp-key').value.trim();
    const err = $('#rtmp-error');
    if (!value) return;
    if (platform === 'custom' && !RTMP_RE.test(value)) {
      err.textContent = 'Custom destination must be a full rtmp:// or rtmps:// URL.';
      err.classList.remove('hidden');
      return;
    }
    destinations.push({
      id: Math.random().toString(36).slice(2, 10),
      mode: 'key', platform, value, enabled: true,
    });
    saveDests(); renderDests();
    $('#rtmp-modal').classList.add('hidden');
  });

  /* ------------------------------ broadcasts ------------------------------ */

  async function renderBroadcasts() {
    const list = $('#broadcast-list');
    let broadcasts = [];
    try {
      const res = await fetch(`/api/broadcasts?owner=${encodeURIComponent(owner)}`);
      broadcasts = (await res.json()).broadcasts || [];
    } catch {
      list.innerHTML = '<p class="dest-empty">Could not reach the Lumio server.</p>';
      return;
    }
    list.innerHTML = '';
    if (!broadcasts.length) {
      list.innerHTML = '<p class="dest-empty">No broadcasts yet — hit <b>＋ Create a broadcast</b> to set up your first stream or webinar.</p>';
      return;
    }
    for (const b of broadcasts) {
      const hasKey = !!localStorage.getItem(`lumio.hostkey.${b.id}`);
      const row = document.createElement('div');
      row.className = 'broadcast' + (b.live ? ' is-live' : '');
      row.innerHTML = `
        <div class="broadcast-info">
          <b>${U.escapeHtml(b.title)} ${b.live ? '<span class="b-live">● LIVE</span>' : ''}</b>
          <span>${b.description ? U.escapeHtml(b.description.slice(0, 120)) : 'No description'} · created ${new Date(b.createdAt).toLocaleDateString()}</span>
        </div>
        <div class="broadcast-actions">
          <button class="btn btn-primary btn-sm" data-enter="${b.id}" ${hasKey ? '' : 'disabled title="Created in another browser"'}>Enter studio</button>
          <button class="btn btn-ghost btn-sm" data-copy-link="${location.origin}/guest/${b.id}">Guest link</button>
          <button class="btn btn-ghost btn-sm" data-copy-link="${location.origin}/watch/${b.id}">Watch link</button>
          <button class="dest-del" data-remove="${b.id}" title="Delete broadcast">✕</button>
        </div>`;
      list.appendChild(row);
    }
  }

  $('#broadcast-list').addEventListener('click', async e => {
    const enter = e.target.closest('[data-enter]');
    if (enter) { location.href = `/studio/${enter.dataset.enter}`; return; }
    const copy = e.target.closest('[data-copy-link]');
    if (copy) {
      try { await navigator.clipboard.writeText(copy.dataset.copyLink); } catch { /* ok */ }
      const orig = copy.textContent;
      copy.textContent = 'Copied!';
      setTimeout(() => { copy.textContent = orig; }, 1200);
      return;
    }
    const rm = e.target.closest('[data-remove]');
    if (rm && confirm('Delete this broadcast? Links to it will stop working.')) {
      await fetch(`/api/broadcasts/${rm.dataset.remove}?owner=${encodeURIComponent(owner)}`, { method: 'DELETE' }).catch(() => {});
      renderBroadcasts();
    }
  });

  /* ---- create broadcast modal ---- */

  function renderCreateDests() {
    const box = $('#create-dests');
    box.innerHTML = '';
    const usable = destinations.filter(d => !d.stale);
    box.insertAdjacentHTML('beforeend',
      `<label class="check dest-check on"><input type="checkbox" checked disabled />
        <span><b class="lumio-inline">Lumio watch page</b> — unlimited viewers + live chat (always on)</span></label>`);
    if (!usable.length) {
      box.insertAdjacentHTML('beforeend', '<p class="panel-hint">Connect YouTube/Facebook above to also stream there.</p>');
    }
    usable.forEach(d => {
      const label = d.mode === 'oauth'
        ? `${PLATFORM_LABEL[d.platform]} · ${d.name}${d.platform === 'facebook' ? ` → ${(d.targets.find(t => t.id === d.targetId) || {}).name || 'profile'}` : ''}`
        : `${PLATFORM_LABEL[d.platform]} (stream key)`;
      box.insertAdjacentHTML('beforeend',
        `<label class="check dest-check"><input type="checkbox" data-dest="${d.id}" checked />
          <span>${U.escapeHtml(label)}</span></label>`);
    });
  }

  $('#btn-create').addEventListener('click', () => {
    renderCreateDests();
    $('#create-error').classList.add('hidden');
    $('#create-modal').classList.remove('hidden');
    $('#create-title').focus();
  });
  $('#create-cancel').addEventListener('click', () => $('#create-modal').classList.add('hidden'));

  $('#create-go').addEventListener('click', async () => {
    const err = $('#create-error');
    err.classList.add('hidden');
    $('#create-go').disabled = true;
    try {
      const title = $('#create-title').value.trim() || 'Untitled broadcast';
      const description = $('#create-desc').value.trim();
      const res = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, description, owner }),
      });
      if (!res.ok) throw new Error(`Server error (${res.status}).`);
      const room = await res.json();
      const selected = [...document.querySelectorAll('#create-dests [data-dest]:checked')]
        .map(cb => cb.dataset.dest);
      localStorage.setItem(`lumio.hostkey.${room.id}`, room.hostKey);
      save(`lumio.sel.${room.id}`, selected);
      localStorage.setItem(`lumio.desc.${room.id}`, description);
      location.href = `/studio/${room.id}`;
    } catch (e) {
      err.textContent = e.message || 'Could not create the broadcast.';
      err.classList.remove('hidden');
      $('#create-go').disabled = false;
    }
  });

  /* ------------------------------ boot ------------------------------ */

  renderDests();
  renderBroadcasts();
  setInterval(renderBroadcasts, 15_000);
})();

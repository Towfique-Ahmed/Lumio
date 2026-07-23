/* =========================================================================
 * Lumio — dashboard: create, edit, list, share and delete webinars.
 * ========================================================================= */
(() => {
  'use strict';

  const $ = sel => document.querySelector(sel);
  const list = $('#webinar-list');
  const emptyState = $('#empty-state');
  const createModal = $('#create-modal');
  const shareModal = $('#share-modal');
  const form = $('#webinar-form');
  const urlInput = $('#f-url');
  const urlFeedback = $('#url-feedback');

  /* ---------------- rendering ---------------- */

  function render() {
    const webinars = Lumio.loadAll()
      .sort((a, b) => new Date(a.datetime) - new Date(b.datetime));

    list.innerHTML = '';
    emptyState.classList.toggle('hidden', webinars.length > 0);

    for (const w of webinars) {
      const status = Lumio.statusOf(w);
      const info = Lumio.parseStreamUrl(w.url);
      const platform = info ? info.platform : '';
      const card = document.createElement('article');
      card.className = 'webinar-card';
      card.innerHTML = `
        <div class="card-top ${platform}">
          <span class="platform-chip">${Lumio.platformLabel(platform)}</span>
          <span class="status-badge ${status}">${status.toUpperCase()}</span>
        </div>
        <h3>${Lumio.escapeHtml(w.title)}</h3>
        <p class="card-when">📅 ${Lumio.escapeHtml(Lumio.fmtDateTime(w.datetime))} · ${w.duration} min</p>
        ${w.speakers ? `<p class="card-speakers">🎤 ${Lumio.escapeHtml(w.speakers)}</p>` : ''}
        <div class="card-actions">
          <a class="btn btn-primary btn-sm" href="${Lumio.shareLink(w)}">Open</a>
          <button class="btn btn-ghost btn-sm" data-share="${w.id}">Share</button>
          <button class="btn btn-ghost btn-sm" data-edit="${w.id}">Edit</button>
          <button class="btn btn-danger btn-sm" data-delete="${w.id}" title="Delete">🗑</button>
        </div>`;
      list.appendChild(card);
    }
  }

  /* ---------------- create / edit modal ---------------- */

  function openCreate(webinar) {
    form.reset();
    $('#f-id').value = webinar ? webinar.id : '';
    $('#modal-title').textContent = webinar ? 'Edit webinar' : 'Create a webinar';
    $('#f-submit').textContent = webinar ? 'Save changes' : 'Create webinar';
    urlFeedback.textContent = '';
    urlFeedback.className = 'url-feedback';

    if (webinar) {
      $('#f-url').value = webinar.url;
      $('#f-title').value = webinar.title;
      $('#f-datetime').value = webinar.datetime;
      $('#f-duration').value = webinar.duration;
      $('#f-host').value = webinar.host;
      $('#f-speakers').value = webinar.speakers;
      $('#f-desc').value = webinar.desc;
      $('#f-chat').checked = webinar.chat;
      $('#f-autoplay').checked = webinar.autoplay;
      validateUrl();
    } else {
      // Default schedule: next round hour, local time.
      const d = new Date(Date.now() + 3600000);
      d.setMinutes(0, 0, 0);
      const pad = n => String(n).padStart(2, '0');
      $('#f-datetime').value =
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
    createModal.classList.remove('hidden');
    $('#f-url').focus();
  }

  function closeCreate() { createModal.classList.add('hidden'); }

  function validateUrl() {
    const info = Lumio.parseStreamUrl(urlInput.value);
    if (!urlInput.value.trim()) {
      urlFeedback.textContent = '';
      urlFeedback.className = 'url-feedback';
      return null;
    }
    if (info) {
      urlFeedback.textContent = `✓ Detected ${Lumio.platformLabel(info.platform)}`;
      urlFeedback.className = 'url-feedback ok';
    } else {
      urlFeedback.textContent = '✗ Not a recognized YouTube or Facebook video/live URL';
      urlFeedback.className = 'url-feedback err';
    }
    return info;
  }

  form.addEventListener('submit', e => {
    e.preventDefault();
    const info = validateUrl();
    if (!info) { urlInput.focus(); return; }
    if (!form.reportValidity()) return;

    const id = $('#f-id').value || Lumio.uid();
    const webinar = {
      id,
      url: urlInput.value.trim(),
      title: $('#f-title').value.trim(),
      datetime: $('#f-datetime').value,
      duration: Number($('#f-duration').value) || 60,
      host: $('#f-host').value.trim(),
      speakers: $('#f-speakers').value.trim(),
      desc: $('#f-desc').value.trim(),
      chat: $('#f-chat').checked,
      autoplay: $('#f-autoplay').checked,
    };

    const all = Lumio.loadAll();
    const idx = all.findIndex(w => w.id === id);
    if (idx >= 0) all[idx] = webinar; else all.push(webinar);
    Lumio.saveAll(all);

    closeCreate();
    render();
    openShare(webinar);
  });

  urlInput.addEventListener('input', validateUrl);

  /* ---------------- share modal ---------------- */

  function openShare(webinar) {
    const link = Lumio.shareLink(webinar);
    $('#share-link').value = link;
    $('#share-open').href = link;
    shareModal.classList.remove('hidden');
  }

  $('#copy-link').addEventListener('click', async () => {
    const input = $('#share-link');
    try {
      await navigator.clipboard.writeText(input.value);
    } catch {
      input.select();
      document.execCommand('copy');
    }
    const btn = $('#copy-link');
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
  });

  /* ---------------- global events ---------------- */

  document.addEventListener('click', e => {
    const t = e.target.closest('[data-open-create],[data-close-create],[data-close-share],[data-share],[data-edit],[data-delete]');
    if (!t) return;

    if (t.hasAttribute('data-open-create')) openCreate();
    else if (t.hasAttribute('data-close-create')) closeCreate();
    else if (t.hasAttribute('data-close-share')) shareModal.classList.add('hidden');
    else if (t.dataset.share) {
      const w = Lumio.loadAll().find(x => x.id === t.dataset.share);
      if (w) openShare(w);
    } else if (t.dataset.edit) {
      const w = Lumio.loadAll().find(x => x.id === t.dataset.edit);
      if (w) openCreate(w);
    } else if (t.dataset.delete) {
      const w = Lumio.loadAll().find(x => x.id === t.dataset.delete);
      if (w && confirm(`Delete “${w.title}”? This cannot be undone.`)) {
        Lumio.saveAll(Lumio.loadAll().filter(x => x.id !== t.dataset.delete));
        render();
      }
    }
  });

  // Close modals on backdrop click / Escape.
  [createModal, shareModal].forEach(m =>
    m.addEventListener('click', e => { if (e.target === m) m.classList.add('hidden'); }));
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') [createModal, shareModal].forEach(m => m.classList.add('hidden'));
  });

  // Keep status badges fresh.
  setInterval(render, 30000);
  render();
})();

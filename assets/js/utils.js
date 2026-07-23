/* =========================================================================
 * Lumio — shared utilities
 * Platform detection, stream-URL parsing, embed builders and the
 * base64url payload codec that makes webinar links self-contained.
 * ========================================================================= */

const Lumio = (() => {
  'use strict';

  const STORAGE_KEY = 'lumio.webinars.v1';

  /* ---------------------------------------------------------------------
   * Stream URL parsing
   * ------------------------------------------------------------------- */

  /**
   * Parse a YouTube URL into { videoId } or { channelId }.
   * Supported: watch?v=ID, youtu.be/ID, /live/ID, /embed/ID, /shorts/ID,
   * channel live pages (/channel/UC…/live) and raw 11-char video IDs.
   */
  function parseYouTube(raw) {
    let url;
    try { url = new URL(raw); } catch { return null; }
    const host = url.hostname.replace(/^www\.|^m\./, '');
    if (!/^(youtube\.com|youtu\.be|youtube-nocookie\.com)$/.test(host)) return null;

    const ID = /^[A-Za-z0-9_-]{11}$/;

    if (host === 'youtu.be') {
      const id = url.pathname.slice(1).split('/')[0];
      return ID.test(id) ? { videoId: id } : null;
    }

    const v = url.searchParams.get('v');
    if (v && ID.test(v)) return { videoId: v };

    const parts = url.pathname.split('/').filter(Boolean);
    // /live/ID, /embed/ID, /shorts/ID  (also /embed/live_stream?channel=UC…)
    if (parts.length >= 2 && ['live', 'embed', 'shorts'].includes(parts[0])) {
      if (parts[1] === 'live_stream') {
        const ch = url.searchParams.get('channel');
        return ch ? { channelId: ch } : null;
      }
      return ID.test(parts[1]) ? { videoId: parts[1] } : null;
    }
    // /channel/UCxxxx or /channel/UCxxxx/live → channel live stream
    if (parts[0] === 'channel' && parts[1] && /^UC[A-Za-z0-9_-]{10,}$/.test(parts[1])) {
      return { channelId: parts[1] };
    }
    return null;
  }

  /** Accepts any public facebook.com video URL or fb.watch short link. */
  function parseFacebook(raw) {
    let url;
    try { url = new URL(raw); } catch { return null; }
    const host = url.hostname.replace(/^www\.|^m\.|^web\./, '');
    if (host === 'fb.watch') return { href: raw };
    if (/(^|\.)facebook\.com$/.test(host)) {
      const p = url.pathname;
      if (/\/(videos?|watch|live|reel)\b/.test(p) || url.searchParams.get('v')) {
        return { href: raw };
      }
    }
    return null;
  }

  /**
   * Detect platform + stream identifiers from any pasted URL.
   * Returns { platform: 'youtube'|'facebook', ...ids } or null.
   */
  function parseStreamUrl(raw) {
    if (!raw) return null;
    raw = raw.trim();
    const yt = parseYouTube(raw);
    if (yt) return { platform: 'youtube', ...yt };
    const fb = parseFacebook(raw);
    if (fb) return { platform: 'facebook', ...fb };
    return null;
  }

  /* ---------------------------------------------------------------------
   * Embed builders
   * ------------------------------------------------------------------- */

  function youTubeEmbedSrc(info, { autoplay = true } = {}) {
    const params = new URLSearchParams({
      autoplay: autoplay ? '1' : '0',
      rel: '0',
      modestbranding: '1',
      playsinline: '1',
    });
    if (info.channelId) {
      params.set('channel', info.channelId);
      return `https://www.youtube.com/embed/live_stream?${params}`;
    }
    return `https://www.youtube.com/embed/${info.videoId}?${params}`;
  }

  /** YouTube live chat only works for a concrete video ID on a real host. */
  function youTubeChatSrc(info) {
    if (!info.videoId) return null;
    const domain = location.hostname;
    if (!domain) return null; // file:// — chat embed requires a real host
    return `https://www.youtube.com/live_chat?v=${info.videoId}&embed_domain=${domain}`;
  }

  function facebookEmbedSrc(info, { autoplay = true } = {}) {
    const params = new URLSearchParams({
      href: info.href,
      show_text: 'false',
      autoplay: autoplay ? 'true' : 'false',
      allowfullscreen: 'true',
      width: '1280',
    });
    return `https://www.facebook.com/plugins/video.php?${params}`;
  }

  /** Build the player iframe element for a webinar object. */
  function buildPlayerIframe(w, { autoplay } = {}) {
    const info = parseStreamUrl(w.url);
    if (!info) return null;
    const iframe = document.createElement('iframe');
    iframe.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen; web-share';
    iframe.allowFullscreen = true;
    iframe.loading = 'eager';
    iframe.referrerPolicy = 'strict-origin-when-cross-origin';
    iframe.title = w.title || 'Live stream player';
    iframe.src = info.platform === 'youtube'
      ? youTubeEmbedSrc(info, { autoplay: autoplay ?? w.autoplay })
      : facebookEmbedSrc(info, { autoplay: autoplay ?? w.autoplay });
    return iframe;
  }

  /* ---------------------------------------------------------------------
   * Shareable-link codec (unicode-safe base64url of the webinar JSON)
   * ------------------------------------------------------------------- */

  function encodePayload(obj) {
    const json = JSON.stringify(obj);
    const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(json)));
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function decodePayload(str) {
    try {
      const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
      const bin = atob(b64);
      const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return null;
    }
  }

  /** Compact wire format keeps share links as short as possible. */
  function toWire(w) {
    return {
      t: w.title, u: w.url, d: w.datetime, m: w.duration,
      h: w.host, s: w.speakers, x: w.desc,
      c: w.chat ? 1 : 0, a: w.autoplay ? 1 : 0,
    };
  }

  function fromWire(p) {
    if (!p || !p.u || !p.t) return null;
    return {
      title: p.t, url: p.u, datetime: p.d, duration: Number(p.m) || 60,
      host: p.h || '', speakers: p.s || '', desc: p.x || '',
      chat: p.c !== 0, autoplay: p.a !== 0,
    };
  }

  function shareLink(w) {
    const base = location.href.replace(/[^/]*$/, '');
    return `${base}watch.html?w=${encodePayload(toWire(w))}`;
  }

  /* ---------------------------------------------------------------------
   * Local storage
   * ------------------------------------------------------------------- */

  function loadAll() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; }
    catch { return []; }
  }

  function saveAll(list) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  }

  /* ---------------------------------------------------------------------
   * Misc helpers
   * ------------------------------------------------------------------- */

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function fmtDateTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric',
      year: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  }

  /** 'upcoming' | 'live' | 'ended' relative to now. */
  function statusOf(w, now = Date.now()) {
    const start = new Date(w.datetime).getTime();
    if (isNaN(start)) return 'live';
    const end = start + (Number(w.duration) || 60) * 60000;
    if (now < start) return 'upcoming';
    if (now > end) return 'ended';
    return 'live';
  }

  function platformLabel(p) {
    return p === 'youtube' ? 'YouTube Live' : p === 'facebook' ? 'Facebook Live' : 'Live';
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  return {
    parseStreamUrl, buildPlayerIframe, youTubeChatSrc,
    encodePayload, decodePayload, toWire, fromWire, shareLink,
    loadAll, saveAll, uid, fmtDateTime, statusOf, platformLabel, escapeHtml,
  };
})();

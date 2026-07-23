/* =========================================================================
 * Lumio — platform integrations (StreamYard-style OAuth destinations)
 *
 * YouTube : Google OAuth 2.0 → YouTube Live Streaming API
 *           liveBroadcasts.insert (+enableAutoStart/Stop) + liveStreams.insert
 *           + liveBroadcasts.bind  →  RTMPS ingest URL, no manual stream key.
 * Facebook: Facebook Login → Graph API
 *           /me + /me/accounts to pick Profile or Page →
 *           POST /{target}/live_videos (status=LIVE_NOW) → secure_stream_url.
 *
 * OAuth tokens live ONLY on this server (.data/connections.json). The
 * browser is given an opaque connection id plus display info (name/avatar).
 * ========================================================================= */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '.data');
const STORE_FILE = path.join(DATA_DIR, 'connections.json');

let GOOGLE_ID = process.env.GOOGLE_CLIENT_ID || '';
let GOOGLE_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
let FB_ID = process.env.FACEBOOK_APP_ID || '';
let FB_SECRET = process.env.FACEBOOK_APP_SECRET || '';
const FB_API = 'https://graph.facebook.com/v21.0';

const configured = {
  youtube: !!(GOOGLE_ID && GOOGLE_SECRET),
  facebook: !!(FB_ID && FB_SECRET),
};

/** In-app setup wizard: accept credentials at runtime and persist them to
 *  .env so they survive restarts. */
function setCredentials(platform, id, secret) {
  if (platform === 'youtube') {
    GOOGLE_ID = id; GOOGLE_SECRET = secret;
    configured.youtube = !!(id && secret);
    persistEnv({ GOOGLE_CLIENT_ID: id, GOOGLE_CLIENT_SECRET: secret });
  } else if (platform === 'facebook') {
    FB_ID = id; FB_SECRET = secret;
    configured.facebook = !!(id && secret);
    persistEnv({ FACEBOOK_APP_ID: id, FACEBOOK_APP_SECRET: secret });
  }
}

function persistEnv(vars) {
  const envPath = path.join(__dirname, '..', '.env');
  let lines = [];
  try { lines = fs.readFileSync(envPath, 'utf8').split('\n'); } catch { /* first write */ }
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (const [k, v] of Object.entries(vars)) {
    const idx = lines.findIndex(l => l.startsWith(`${k}=`));
    if (idx >= 0) lines[idx] = `${k}=${v}`;
    else lines.push(`${k}=${v}`);
  }
  fs.writeFileSync(envPath, lines.join('\n') + '\n', { mode: 0o600 });
}

/* ----------------------------- connection store ----------------------------- */

let connections = new Map();

function loadStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    connections = new Map(Object.entries(raw));
  } catch { connections = new Map(); }
}

function saveStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STORE_FILE, JSON.stringify(Object.fromEntries(connections), null, 2), { mode: 0o600 });
}

loadStore();

function putConnection(conn) {
  conn.id = conn.id || crypto.randomBytes(12).toString('base64url');
  connections.set(conn.id, conn);
  saveStore();
  return conn;
}

function getConnection(id) { return connections.get(String(id)) || null; }

function deleteConnection(id) {
  const had = connections.delete(String(id));
  if (had) saveStore();
  return had;
}

/** What the browser is allowed to see about a connection. */
function publicView(conn) {
  if (!conn) return null;
  return {
    id: conn.id,
    platform: conn.platform,
    name: conn.name,
    avatar: conn.avatar || null,
    liveEnabled: conn.liveEnabled !== false,
    targets: (conn.targets || []).map(t => ({ type: t.type, id: t.id, name: t.name })),
  };
}

/* --------------------------------- helpers --------------------------------- */

async function httpJson(url, opts = {}) {
  const res = await fetch(url, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body.error?.message || body.error?.error_description || body.error_description ||
      (typeof body.error === 'string' ? body.error : null) || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

const form = obj => new URLSearchParams(obj).toString();

/* ================================= YouTube ================================= */

const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';

function youtubeAuthUrl(redirectUri, state) {
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + form({
    client_id: GOOGLE_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPE,
    access_type: 'offline', // we need a refresh_token to go live later
    prompt: 'consent select_account',
    state,
  });
}

async function youtubeExchangeCode(code, redirectUri) {
  const tok = await httpJson('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({
      code, client_id: GOOGLE_ID, client_secret: GOOGLE_SECRET,
      redirect_uri: redirectUri, grant_type: 'authorization_code',
    }),
  });

  const ch = await httpJson(
    'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
    { headers: { Authorization: `Bearer ${tok.access_token}` } });
  const channel = ch.items && ch.items[0];
  if (!channel) throw new Error('This Google account has no YouTube channel.');

  // StreamYard's "other verification" step: check the channel actually has
  // live streaming enabled (YouTube requires phone verification + up to a
  // 24h wait). Listing liveStreams fails with liveStreamingNotEnabled if not.
  let liveEnabled = true;
  try {
    await httpJson('https://www.googleapis.com/youtube/v3/liveStreams?part=id&mine=true&maxResults=1',
      { headers: { Authorization: `Bearer ${tok.access_token}` } });
  } catch (e) {
    const reasons = (e.body?.error?.errors || []).map(x => x.reason);
    if (reasons.includes('liveStreamingNotEnabled') || e.status === 403) liveEnabled = false;
  }

  return putConnection({
    platform: 'youtube',
    name: channel.snippet.title,
    avatar: channel.snippet.thumbnails?.default?.url || null,
    channelId: channel.id,
    liveEnabled,
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token || null,
    expiresAt: Date.now() + (tok.expires_in || 3600) * 1000,
  });
}

async function youtubeToken(conn) {
  if (Date.now() < conn.expiresAt - 60_000) return conn.accessToken;
  if (!conn.refreshToken) throw new Error('YouTube session expired — reconnect the channel.');
  const tok = await httpJson('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({
      client_id: GOOGLE_ID, client_secret: GOOGLE_SECRET,
      refresh_token: conn.refreshToken, grant_type: 'refresh_token',
    }),
  });
  conn.accessToken = tok.access_token;
  conn.expiresAt = Date.now() + (tok.expires_in || 3600) * 1000;
  putConnection(conn);
  return conn.accessToken;
}

/** Create broadcast + stream, bind them, return the RTMPS ingest.
 *  enableAutoStart/Stop means YouTube goes live as soon as FFmpeg pushes
 *  data and ends shortly after it stops — no transition calls needed. */
async function youtubePrepare(conn, { title, privacy }) {
  const token = await youtubeToken(conn);
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const yt = 'https://www.googleapis.com/youtube/v3';

  const broadcast = await httpJson(`${yt}/liveBroadcasts?part=snippet,contentDetails,status`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      snippet: {
        title: (title || 'Live broadcast').slice(0, 100),
        scheduledStartTime: new Date().toISOString(),
      },
      status: {
        privacyStatus: ['public', 'unlisted', 'private'].includes(privacy) ? privacy : 'public',
        selfDeclaredMadeForKids: false,
      },
      contentDetails: { enableAutoStart: true, enableAutoStop: true },
    }),
  });

  const stream = await httpJson(`${yt}/liveStreams?part=snippet,cdn`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      snippet: { title: `Lumio — ${new Date().toISOString()}` },
      cdn: { ingestionType: 'rtmp', resolution: '720p', frameRate: '30fps' },
    }),
  });

  await httpJson(`${yt}/liveBroadcasts/bind?id=${broadcast.id}&part=id&streamId=${stream.id}`, {
    method: 'POST', headers: auth,
  });

  const ingest = stream.cdn.ingestionInfo;
  const base = ingest.rtmpsIngestionAddress || ingest.ingestionAddress;
  return {
    rtmpUrl: `${base.replace(/\/$/, '')}/${ingest.streamName}`,
    watchUrl: `https://youtube.com/watch?v=${broadcast.id}`,
    broadcastId: broadcast.id,
  };
}

/** Best-effort cleanup — enableAutoStop already ends it ~1 min after data stops. */
async function youtubeEnd(conn, broadcastId) {
  try {
    const token = await youtubeToken(conn);
    await httpJson(
      `https://www.googleapis.com/youtube/v3/liveBroadcasts/transition?broadcastStatus=complete&id=${broadcastId}&part=status`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  } catch { /* autoStop will finish the job */ }
}

/* ================================ Facebook ================================ */

/* publish_video      → go live on the user's own timeline
 * pages_show_list    → list the user's Pages in the target picker
 * pages_manage_posts + pages_read_engagement → go live on a Page
 * (Groups aren't offered: Meta removed the Groups API in April 2024.) */
const FB_SCOPE = 'publish_video,pages_show_list,pages_manage_posts,pages_read_engagement';

function facebookAuthUrl(redirectUri, state) {
  return 'https://www.facebook.com/v21.0/dialog/oauth?' + form({
    client_id: FB_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: FB_SCOPE,
    state,
  });
}

async function facebookExchangeCode(code, redirectUri) {
  const short = await httpJson(`${FB_API}/oauth/access_token?` + form({
    client_id: FB_ID, client_secret: FB_SECRET, redirect_uri: redirectUri, code,
  }));

  // Long-lived user token (~60 days) so the connection survives.
  let userToken = short.access_token;
  try {
    const long = await httpJson(`${FB_API}/oauth/access_token?` + form({
      grant_type: 'fb_exchange_token',
      client_id: FB_ID, client_secret: FB_SECRET,
      fb_exchange_token: userToken,
    }));
    userToken = long.access_token;
  } catch { /* short-lived token still works for now */ }

  const me = await httpJson(`${FB_API}/me?fields=id,name,picture.width(64)&access_token=${encodeURIComponent(userToken)}`);

  const targets = [{ type: 'profile', id: me.id, name: `${me.name} (profile)` }];
  const pageTokens = {};
  try {
    const pages = await httpJson(`${FB_API}/me/accounts?fields=id,name,access_token&limit=50&access_token=${encodeURIComponent(userToken)}`);
    for (const p of pages.data || []) {
      targets.push({ type: 'page', id: p.id, name: p.name });
      pageTokens[p.id] = p.access_token;
    }
  } catch { /* no pages permission granted — profile-only is fine */ }

  return putConnection({
    platform: 'facebook',
    name: me.name,
    avatar: me.picture?.data?.url || null,
    userToken,
    pageTokens,
    targets,
  });
}

function facebookTokenFor(conn, target) {
  if (target && target.type === 'page') {
    const t = conn.pageTokens[target.id];
    if (!t) throw new Error('No access token for that Page — reconnect Facebook.');
    return t;
  }
  return conn.userToken;
}

/** POST /{target}/live_videos → RTMPS stream_url, ready to push to. */
async function facebookPrepare(conn, target, { title, description }) {
  const known = (conn.targets || []).find(t => t.id === (target && target.id));
  if (!known) throw new Error('Unknown Facebook target — reconnect and pick again.');
  const token = facebookTokenFor(conn, known);

  const live = await httpJson(`${FB_API}/${known.id}/live_videos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({
      status: 'LIVE_NOW',
      title: (title || 'Live broadcast').slice(0, 250),
      description: (description || '').slice(0, 5000),
      access_token: token,
    }),
  });

  const url = live.secure_stream_url || live.stream_url;
  if (!url) throw new Error('Facebook did not return a stream URL.');
  return {
    rtmpUrl: url,
    watchUrl: known.type === 'page' ? `https://www.facebook.com/${known.id}/live` : 'https://www.facebook.com/me',
    videoId: live.id,
    targetId: known.id,
  };
}

async function facebookEnd(conn, videoId, targetId) {
  try {
    const known = (conn.targets || []).find(t => t.id === targetId);
    const token = facebookTokenFor(conn, known || { type: 'profile' });
    await httpJson(`${FB_API}/${videoId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({ end_live_video: 'true', access_token: token }),
    });
  } catch { /* stream ending stops it anyway */ }
}

module.exports = {
  configured, setCredentials,
  getConnection, deleteConnection, publicView,
  youtubeAuthUrl, youtubeExchangeCode, youtubePrepare, youtubeEnd,
  facebookAuthUrl, facebookExchangeCode, facebookPrepare, facebookEnd,
};

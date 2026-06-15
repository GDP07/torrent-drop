// TorrentDrop local engine.
// Runs WebTorrent in Node (full BitTorrent swarm: TCP / uTP / DHT / PEX / WebRTC),
// serves the UI, and streams finished files to the browser. Everything stays on
// this machine — no third-party server, nothing leaves your device.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import crypto from 'node:crypto';
import WebTorrent from 'webtorrent';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;
const HOST = process.env.TD_HOST || '0.0.0.0'; // Electron sets 127.0.0.1 (local-only)
const TORRENT_PORT = Number(process.env.TORRENT_PORT) || 6881; // forward this for max seed/peer speed
const MAX_CONNS = Number(process.env.MAX_CONNS) || 1000;
const DEFAULT_DOWNLOAD_DIR = process.env.TD_DOWNLOAD_DIR || path.join(__dirname, 'downloads');

/* ---- persistent settings ----
 * Lives in a writable dir (Electron passes its userData; CLI falls back to ~/.torrentdrop).
 * Holds first-run/wizard state, language, and seeding/connection preferences. */
const CONFIG_DIR = process.env.TD_CONFIG_DIR || path.join(os.homedir(), '.torrentdrop');
fs.mkdirSync(CONFIG_DIR, { recursive: true });
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const SESSION_FILE = path.join(CONFIG_DIR, 'session.json');
const HISTORY_FILE = path.join(CONFIG_DIR, 'history.json');
const SCHEDULE_FILE = path.join(CONFIG_DIR, 'schedule.json');

const DEFAULT_CONFIG = {
  setupComplete: false,    // false => the UI shows the first-run wizard
  language: 'en',
  seeding: true,           // keep uploading (seeding) after a download finishes
  seedRatio: 0,            // 0 = seed forever; otherwise stop when uploaded/downloaded >= this
  downloadDir: DEFAULT_DOWNLOAD_DIR,
  maxConns: MAX_CONNS,     // peers per torrent (takes effect on restart)
  downloadLimit: -1,       // bytes/sec, -1 = unlimited (restart to apply)
  uploadLimit: -1,         // bytes/sec, -1 = unlimited (restart to apply)
  restoreSession: true     // re-add torrents that were active last time, on startup
};

function loadConfig() {
  let c;
  try { c = Object.assign({}, DEFAULT_CONFIG, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))); }
  catch (e) { c = Object.assign({}, DEFAULT_CONFIG); }
  // Migrate stale connection caps up to the current floor (no UI sets this,
  // so an old saved value is just a previous default — safe to raise).
  if (!(c.maxConns >= MAX_CONNS)) c.maxConns = MAX_CONNS;
  return c;
}
function saveConfig() {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); }
  catch (e) { console.error('[config] save failed:', e.message || e); }
}
let config = loadConfig();
fs.mkdirSync(config.downloadDir, { recursive: true });

// Shared-password login. Set TD_PASSWORD to require a login before anyone can
// use it (mandatory before exposing to the internet). Empty = no auth (local use).
const AUTH_PASSWORD = process.env.TD_PASSWORD || '';
const AUTH_ENABLED = AUTH_PASSWORD.length > 0;
const AUTH_TOKEN = AUTH_ENABLED
  ? crypto.createHmac('sha256', AUTH_PASSWORD).update('torrentdrop-session-v1').digest('hex')
  : '';
const COOKIE = 'td_auth';

// Large, curated tracker pool (usable in Node, unlike a browser). More trackers
// = more peer sources = faster swarm ramp. UDP first (lowest overhead), then
// HTTP(S), then WSS for any WebRTC peers.
const TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.tracker.cl:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://explodie.org:6969/announce',
  'udp://tracker.dler.org:6969/announce',
  'udp://opentracker.i2p.rocks:6969/announce',
  'udp://tracker.moeking.me:6969/announce',
  'udp://tracker.tiny-vps.com:6969/announce',
  'udp://tracker.bittor.pw:1337/announce',
  'udp://tracker-udp.gbitt.info:80/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.ololosh.space:6969/announce',
  'udp://tracker1.bt.moack.co.kr:80/announce',
  'udp://tracker.theoks.net:6969/announce',
  'udp://p4p.arenabg.com:1337/announce',
  'udp://movies.zsw.ca:6969/announce',
  'udp://tracker.0x7c0.com:6969/announce',
  'udp://9.rarbg.com:2810/announce',
  'udp://tracker.dump.cl:6969/announce',
  'udp://opentracker.io:6969/announce',
  'udp://retracker01-msk-virt.corbina.net:80/announce',
  'https://tracker.tamersunion.org:443/announce',
  'https://tracker.gbitt.info:443/announce',
  'http://tracker.opentrackr.org:1337/announce',
  'http://tracker.openbittorrent.com:80/announce',
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.webtorrent.dev',
  'wss://tracker.btorrent.xyz',
  'wss://tracker.files.fm:7073/announce'
];

// Aggressive performance config:
//  - maxConns: many simultaneous peers per torrent (more throughput, more leechers when seeding)
//  - utp: uTP transport in addition to TCP (NAT-friendly, often faster)
//  - dht + lsd: maximum peer discovery
//  - natUpnp/natPmp: auto-open the listening port on your router => reachable for INCOMING peers
//    (this is the single biggest factor for seed/upload speed)
//  - torrentPort: a fixed port you can also forward manually
//  - download/upload limits removed (unlimited)
function buildClient() {
  const base = {
    maxConns: Math.max(config.maxConns || 0, MAX_CONNS),   // peers per torrent — never below the default floor
    maxWebConns: 50,             // parallel connections per web seed (huge for web-seeded releases)
    dht: true,
    lsd: true,
    webSeeds: true,
    natUpnp: true,
    natPmp: true,
    torrentPort: TORRENT_PORT,
    downloadLimit: config.downloadLimit,
    uploadLimit: config.uploadLimit
  };
  try {
    return new WebTorrent(Object.assign({ utp: true }, base)); // uTP if utp-native is available
  } catch (e) {
    console.warn('[client] uTP unavailable, using TCP only:', e.message || e);
    return new WebTorrent(base);
  }
}

const client = buildClient();
client.on('error', (err) => console.error('[client]', err.message || err));

// Per-torrent extras the WebTorrent object doesn't track for us.
const extra = new Map(); // infoHash -> { error, timeAdded, timer }

/* ---- input -> a torrentId WebTorrent understands ---- */
function resolveSource(raw) {
  raw = (raw || '').trim();
  if (!raw) return null;
  if (/^magnet:/i.test(raw)) return raw;
  if (/^[a-fA-F0-9]{40}$/.test(raw)) return 'magnet:?xt=urn:btih:' + raw.toLowerCase();
  if (/^[a-zA-Z2-7]{32}$/.test(raw)) return 'magnet:?xt=urn:btih:' + raw.toUpperCase();
  const hex = raw.match(/[a-fA-F0-9]{40}/);          // hash embedded in a URL/path
  if (hex) return 'magnet:?xt=urn:btih:' + hex[0].toLowerCase();
  if (/^https?:\/\//i.test(raw)) return raw;          // plain .torrent URL (Node can fetch it)
  return null;
}

function findTorrent(infoHash) {
  if (!infoHash) return null;
  infoHash = String(infoHash).toLowerCase();
  return client.torrents.find((t) => t.infoHash === infoHash) || null;
}

function statusOf(t) {
  const x = extra.get(t.infoHash);
  if (x && x.error) return 'error';
  if (t.done && t.paused) return 'completed';   // finished + not seeding => done, stopped
  if (t.paused) return 'paused';                // paused mid-download
  if (!t.ready) return 'fetching';
  if (t.done) return 'seeding';                 // finished + still uploading
  return 'downloading';
}

function serialize(t) {
  const x = extra.get(t.infoHash) || {};
  return {
    infoHash: t.infoHash,
    magnetURI: t.magnetURI,
    name: t.name || 'Fetching metadata…',
    length: t.length || 0,
    downloaded: t.downloaded || 0,
    progress: t.progress || 0,
    downloadSpeed: t.downloadSpeed || 0,
    uploadSpeed: t.uploadSpeed || 0,
    uploaded: t.uploaded || 0,
    ratio: t.downloaded ? (t.uploaded || 0) / t.downloaded : 0,
    numPeers: t.numPeers || 0,
    timeRemaining: t.timeRemaining || 0,
    status: statusOf(t),
    error: x.error || '',
    timeAdded: x.timeAdded || 0,
    savePath: t.path ? path.join(t.path, t.name || '') : '',
    files: (t.files || []).map((f, i) => ({
      index: i,
      name: f.name,
      length: f.length || 0,
      downloaded: f.downloaded || 0,
      progress: typeof f.progress === 'number' ? f.progress : (f.length ? (f.downloaded || 0) / f.length : 0),
      done: t.done || (f.length ? (f.downloaded || 0) >= f.length : false)
    }))
  };
}

function addTorrent(raw) {
  const src = resolveSource(raw);
  if (!src) return { error: 'Invalid magnet, info hash, or torrent URL' };

  const m = src.match(/btih:([a-zA-Z0-9]+)/i);
  const guessHash = m ? m[1].toLowerCase() : null;
  if (guessHash && findTorrent(guessHash)) return { error: 'Already added', duplicate: true, infoHash: guessHash };

  let torrent;
  try {
    torrent = client.add(src, { path: config.downloadDir, announce: TRACKERS });
  } catch (e) {
    return { error: e.message || 'Failed to add torrent' };
  }

  const rec = { error: null, timeAdded: Date.now(), timer: null };
  rec.timer = setTimeout(() => {
    if (!torrent.ready) rec.error = 'No peers found — check the magnet link or try again later';
  }, 60000);
  extra.set(torrent.infoHash, rec);

  torrent.on('infoHash', () => { if (!extra.has(torrent.infoHash)) extra.set(torrent.infoHash, rec); });
  torrent.on('metadata', () => { try { torrent.critical(0, 20); } catch (e) {} });
  torrent.on('ready', () => {
    const r = extra.get(torrent.infoHash);
    if (r) { if (r.timer) clearTimeout(r.timer); r.error = null; }
    try { torrent.critical(0, 20); } catch (e) {}
    console.log('[ready]', torrent.name, '-', (t => t.length)(torrent), 'bytes');
  });
  torrent.on('done', () => { console.log('[done]', torrent.name); recordHistory(torrent); applySeedingPolicy(torrent); });
  torrent.on('error', (err) => {
    const r = extra.get(torrent.infoHash) || {};
    r.error = String((err && err.message) || err);
    extra.set(torrent.infoHash, r);
    console.error('[torrent]', r.error);
  });
  torrent.on('warning', () => {});

  saveSession();
  return { ok: true, infoHash: torrent.infoHash };
}

/* ---- seeding policy + session persistence ---- */
// When a torrent finishes: stop uploading if seeding is off, or once the
// configured share ratio is reached. A 5s sweep also catches ratio limits
// for torrents that keep seeding.
// Truly stop uploading: pause() stops NEW connections, but WebTorrent keeps
// serving peers it's already connected to — so we also drop those wires. The
// 5s sweep re-drops anyone who reconnects, keeping upload at ~0.
function stopSeeding(torrent) {
  try { torrent.pause(); } catch (e) {}
  try { (torrent.wires || []).slice().forEach((w) => { try { w.destroy(); } catch (e) {} }); } catch (e) {}
}
function applySeedingPolicy(torrent) {
  if (!config.seeding) { stopSeeding(torrent); return; }
  if (config.seedRatio > 0 && torrent.downloaded > 0 && torrent.uploaded / torrent.downloaded >= config.seedRatio) stopSeeding(torrent);
}
setInterval(() => {
  for (const t of client.torrents) {
    if (!t.done) continue;
    if (!config.seeding) { stopSeeding(t); continue; }   // enforce "no seeding": drop any peers
    if (config.seedRatio > 0 && t.downloaded > 0 && t.uploaded / t.downloaded >= config.seedRatio) stopSeeding(t);
  }
}, 5000);

function saveSession() {
  if (!config.restoreSession) return;
  try {
    const uris = client.torrents.map((t) => t.magnetURI).filter(Boolean);
    fs.writeFileSync(SESSION_FILE, JSON.stringify(uris));
  } catch (e) {}
}
function restoreSession() {
  if (!config.restoreSession) return;
  let uris = [];
  try { uris = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')) || []; } catch (e) { return; }
  for (const u of uris) { try { addTorrent(u); } catch (e) {} }
  if (uris.length) console.log('[session] restored ' + uris.length + ' torrent(s)');
}

/* ---- download history ---- */
function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')) || []; } catch (e) { return []; }
}
function saveHistory(list) {
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(list.slice(0, 500))); } catch (e) {}
}
function recordHistory(torrent) {
  const list = loadHistory();
  if (list.some((h) => h.infoHash === torrent.infoHash)) return; // already logged
  list.unshift({
    infoHash: torrent.infoHash,
    name: torrent.name || 'Torrent',
    length: torrent.length || 0,
    files: (torrent.files || []).length,
    magnetURI: torrent.magnetURI || '',
    completedAt: Date.now()
  });
  saveHistory(list);
}

/* ---- scheduled downloads ---- */
function loadSchedule() {
  try { return JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8')) || []; } catch (e) { return []; }
}
function saveSchedule(list) {
  try { fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(list)); } catch (e) {}
}
function addSchedule(input, startAt) {
  const list = loadSchedule();
  const item = { id: crypto.randomBytes(6).toString('hex'), input, startAt, createdAt: Date.now() };
  list.push(item);
  saveSchedule(list);
  return item;
}
function removeSchedule(id) {
  saveSchedule(loadSchedule().filter((s) => s.id !== id));
}
// Every 15s: fire any scheduled download whose time has arrived.
setInterval(() => {
  const now = Date.now();
  const list = loadSchedule();
  const due = list.filter((s) => s.startAt <= now);
  if (!due.length) return;
  for (const s of due) { try { addTorrent(s.input); console.log('[schedule] started', s.input.slice(0, 60)); } catch (e) {} }
  saveSchedule(list.filter((s) => s.startAt > now));
}, 15000);

// Merge a settings update into the live config. Seeding changes apply
// immediately; connection/limit/folder changes take effect on next restart.
function applyConfigUpdate(body) {
  if (typeof body.language === 'string') config.language = body.language.slice(0, 8);
  if (typeof body.seeding === 'boolean') config.seeding = body.seeding;
  if (Number.isFinite(body.seedRatio) && body.seedRatio >= 0) config.seedRatio = body.seedRatio;
  if (typeof body.setupComplete === 'boolean') config.setupComplete = body.setupComplete;
  if (typeof body.restoreSession === 'boolean') config.restoreSession = body.restoreSession;
  if (typeof body.downloadDir === 'string' && body.downloadDir.trim()) {
    config.downloadDir = body.downloadDir.trim();
    try { fs.mkdirSync(config.downloadDir, { recursive: true }); } catch (e) {}
  }
  if (Number.isFinite(body.maxConns) && body.maxConns > 0) config.maxConns = Math.min(2000, Math.floor(body.maxConns));
  if (Number.isFinite(body.downloadLimit)) config.downloadLimit = body.downloadLimit;
  if (Number.isFinite(body.uploadLimit)) config.uploadLimit = body.uploadLimit;
  // Live-apply seeding: stop uploading on finished torrents if seeding was turned off.
  if (!config.seeding) { for (const t of client.torrents) { if (t.done) { try { t.pause(); } catch (e) {} } } }
}

function removeTorrent(infoHash) {
  const t = findTorrent(infoHash);
  if (!t) return { error: 'Not found' };
  const r = extra.get(t.infoHash);
  if (r && r.timer) clearTimeout(r.timer);
  extra.delete(t.infoHash);
  return new Promise((resolve) => {
    client.remove(t.infoHash, { destroyStore: true }, () => { saveSession(); resolve({ ok: true }); });
  });
}

/* ---- tiny HTTP layer ---- */
function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { resolve({}); } });
  });
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function serveStatic(res, file, type) {
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
}

/* ---- auth ---- */
function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie;
  if (!h) return out;
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function safeEqual(a, b) {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

function isAuthed(req) {
  if (!AUTH_ENABLED) return true;
  return safeEqual(parseCookies(req)[COOKIE] || '', AUTH_TOKEN);
}

function loginPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TorrentDrop — Login</title><style>
*{box-sizing:border-box}body{margin:0;height:100vh;display:grid;place-items:center;background:#0d100f;color:#e7ebe9;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.box{width:300px;background:#161a18;border:1px solid rgba(255,255,255,.1);border-radius:14px;padding:26px}
.logo{width:42px;height:42px;border-radius:11px;background:#169c79;display:grid;place-items:center;font-size:22px;margin:0 auto 14px}
h1{font-size:18px;font-weight:500;text-align:center;margin:0 0 18px}
input{width:100%;padding:11px 13px;border-radius:9px;border:1px solid rgba(255,255,255,.12);background:#1a1f1d;color:#e7ebe9;font-size:14px;outline:none}
input:focus{border-color:#169c79}
button{width:100%;margin-top:10px;padding:11px;border:0;border-radius:9px;background:#169c79;color:#fff;font-size:14px;font-weight:500;cursor:pointer}
button:hover{background:#1fc295}
.err{color:#ff6166;font-size:13px;text-align:center;min-height:18px;margin-top:8px}
</style></head><body>
<form class="box" onsubmit="return go(event)">
<div class="logo">&#129522;</div><h1>TorrentDrop</h1>
<input id="p" type="password" placeholder="Password" autofocus autocomplete="current-password"/>
<button type="submit">Unlock</button>
<div class="err" id="e"></div>
</form>
<script>
async function go(ev){ev.preventDefault();var e=document.getElementById('e');e.textContent='';
try{var r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('p').value})});
if(r.ok){location.reload();}else{e.textContent='Wrong password';}}catch(_){e.textContent='Connection error';}return false;}
</script></body></html>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  try {
    // login / logout — always reachable
    if (req.method === 'POST' && p === '/api/login') {
      const body = await readBody(req);
      if (AUTH_ENABLED && safeEqual(body.password || '', AUTH_PASSWORD)) {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': COOKIE + '=' + AUTH_TOKEN + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=' + (60 * 60 * 24 * 30)
        });
        return res.end(JSON.stringify({ ok: true }));
      }
      return json(res, 401, { error: 'Wrong password' });
    }
    if (req.method === 'POST' && p === '/api/logout') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': COOKIE + '=; HttpOnly; Path=/; Max-Age=0' });
      return res.end(JSON.stringify({ ok: true }));
    }

    // auth gate — everything below requires a valid session
    if (!isAuthed(req)) {
      if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(loginPage());
      }
      return json(res, 401, { error: 'Unauthorized' });
    }

    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      return serveStatic(res, path.join(__dirname, 'public', 'index.html'), 'text/html; charset=utf-8');
    }

    if (req.method === 'GET' && p === '/api/config') {
      return json(res, 200, { config });
    }

    if (req.method === 'POST' && p === '/api/config') {
      const body = await readBody(req);
      applyConfigUpdate(body);
      saveConfig();
      return json(res, 200, { ok: true, config });
    }

    if (req.method === 'GET' && p === '/api/history') {
      return json(res, 200, { history: loadHistory() });
    }

    if (req.method === 'POST' && p === '/api/history/clear') {
      saveHistory([]);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && p === '/api/scheduled') {
      return json(res, 200, { scheduled: loadSchedule() });
    }

    if (req.method === 'POST' && p === '/api/schedule') {
      const body = await readBody(req);
      const src = resolveSource(body.input);
      const startAt = Number(body.startAt);
      if (!src) return json(res, 400, { error: 'Invalid magnet, info hash, or torrent URL' });
      if (!Number.isFinite(startAt)) return json(res, 400, { error: 'Invalid start time' });
      if (startAt <= Date.now()) { const r = addTorrent(body.input); return json(res, 200, { ok: true, started: true, result: r }); }
      const item = addSchedule(body.input, startAt);
      return json(res, 200, { ok: true, item });
    }

    if (req.method === 'POST' && p === '/api/schedule/cancel') {
      const body = await readBody(req);
      removeSchedule(body.id);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && p === '/api/torrents') {
      return json(res, 200, { torrents: client.torrents.map(serialize) });
    }

    if (req.method === 'POST' && p === '/api/add') {
      const body = await readBody(req);
      const result = addTorrent(body.input);
      return json(res, result.error && !result.duplicate ? 400 : 200, result);
    }

    if (req.method === 'POST' && p === '/api/pause') {
      const body = await readBody(req);
      const t = findTorrent(body.infoHash);
      if (t) t.pause();
      return json(res, 200, { ok: !!t });
    }

    if (req.method === 'POST' && p === '/api/resume') {
      const body = await readBody(req);
      const t = findTorrent(body.infoHash);
      if (t) t.resume();
      return json(res, 200, { ok: !!t });
    }

    if (req.method === 'POST' && p === '/api/remove') {
      const body = await readBody(req);
      const result = await removeTorrent(body.infoHash);
      return json(res, 200, result);
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && p === '/api/download') {
      const t = findTorrent(url.searchParams.get('ih'));
      const idx = parseInt(url.searchParams.get('idx'), 10) || 0;
      const file = t && t.files && t.files[idx];
      if (!file) { res.writeHead(404); return res.end('File not found'); }

      const total = file.length;
      // Prioritize this file so its pieces stream in first — lets the browser pull
      // bytes while the torrent is still downloading, and keeps the on-disk window small.
      try { if (typeof file.select === 'function') file.select(); } catch (e) {}

      // Range support => resumable downloads, seekable media, real progress bars.
      let start = 0;
      let end = total - 1;
      let status = 200;
      const headers = {
        'Content-Type': 'application/octet-stream',
        'Accept-Ranges': 'bytes',
        'Content-Disposition': 'attachment; filename="' + encodeURIComponent(file.name) + '"'
      };

      const range = req.headers.range;
      if (range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
        if (!m || (m[1] === '' && m[2] === '')) {
          res.writeHead(416, { 'Content-Range': 'bytes */' + total }); return res.end();
        }
        if (m[1] === '') {                          // suffix: last N bytes
          start = Math.max(0, total - parseInt(m[2], 10));
        } else {
          start = parseInt(m[1], 10);
          if (m[2] !== '') end = Math.min(parseInt(m[2], 10), total - 1);
        }
        if (!Number.isFinite(start) || start > end || start >= total) {
          res.writeHead(416, { 'Content-Range': 'bytes */' + total }); return res.end();
        }
        status = 206;
        headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + total;
      }

      headers['Content-Length'] = end - start + 1;
      res.writeHead(status, headers);
      if (req.method === 'HEAD') return res.end();

      let stream;
      try {
        if (typeof file.createReadStream === 'function') stream = file.createReadStream({ start, end });
        else stream = Readable.fromWeb(file.stream());
      } catch (e) { try { res.destroy(); } catch (_) {} return; }
      stream.on('error', () => { try { res.destroy(); } catch (e) {} });
      // If the browser aborts (cancel/disconnect), stop pulling pieces for it.
      res.on('close', () => { try { stream.destroy(); } catch (e) {} });
      return stream.pipe(res);
    }

    res.writeHead(404);
    res.end('Not found');
  } catch (e) {
    json(res, 500, { error: String((e && e.message) || e) });
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('\n  Port ' + PORT + ' is already in use — TorrentDrop is probably already running.');
    console.error('  Either open the running one at http://localhost:' + PORT + ', or:');
    console.error('    • stop it:   pkill -f "node server.js"');
    console.error('    • or use a different port:   PORT=9000 npm start\n');
  } else {
    console.error('[server]', err.message || err);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  restoreSession();
  console.log('TorrentDrop engine running');
  console.log('  URL:        http://localhost:' + PORT);
  console.log('  Downloads:  ' + config.downloadDir);
  console.log('  Settings:   ' + CONFIG_FILE);
  console.log('  Seeding:    ' + (config.seeding ? (config.seedRatio > 0 ? 'on (until ratio ' + config.seedRatio + ')' : 'on') : 'off'));
  console.log('  Peer port:  ' + TORRENT_PORT + ' (forward TCP+UDP for best speed; UPnP/NAT-PMP attempted)');
  console.log('  Max peers:  ' + config.maxConns + ' per torrent');
  if (!AUTH_ENABLED && HOST !== '127.0.0.1') {
    console.log('  Warning:    no password set — set TD_PASSWORD before exposing this to the internet.');
  }
});

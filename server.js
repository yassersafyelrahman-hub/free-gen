'use strict';
/*
 * Free AI generation server — zero dependencies (Node 18+).
 *  - Images: proxied to Pollinations (free, no API key).
 *  - Videos: any public Gradio Space on Hugging Face (free ZeroGPU quota), set in config.json.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const OUTPUTS = path.join(ROOT, 'outputs');
fs.mkdirSync(OUTPUTS, { recursive: true });

const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const PORT = Number(process.env.PORT) || config.port || 3000;
const HF_TOKEN = process.env.HF_TOKEN || ''; // optional: a free HF account gives a bigger daily GPU quota

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

/* ---------- helpers ---------- */
const hits = new Map();
function limited(ip, kind, max) {
  const now = Date.now(), key = kind + ':' + ip;
  const arr = (hits.get(key) || []).filter(t => now - t < 3600e3);
  if (arr.length >= max) { hits.set(key, arr); return true; }
  arr.push(now); hits.set(key, arr); return false;
}
function clientIp(req) {
  if (config.trustProxy) {
    const xf = req.headers['x-forwarded-for'];
    if (xf) return String(xf).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}
function corsHeaders() {
  return config.allowedOrigin
    ? { 'Access-Control-Allow-Origin': config.allowedOrigin, 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }
    : {};
}
function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders() });
  res.end(JSON.stringify(obj));
}
function readJson(req, limit = 20000) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > limit) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
const clampInt = (v, min, max, def) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};
const cleanPrompt = p => String(p || '').replace(/\s+/g, ' ').trim().slice(0, config.maxPromptLength || 500);
const randSeed = () => Math.floor(Math.random() * 1e9);

/* ---------- images (Pollinations) ---------- */
let activeImages = 0;
async function handleImage(req, res, ip) {
  if (limited(ip, 'img', config.image.maxPerHour)) return send(res, 429, { error: 'RATE_IMG' });
  if (activeImages >= config.image.maxConcurrent) return send(res, 503, { error: 'BUSY' });
  const b = await readJson(req);
  const prompt = cleanPrompt(b.prompt);
  if (!prompt) return send(res, 400, { error: 'EMPTY_PROMPT' });
  const model = config.image.models.includes(b.model) ? b.model : config.image.models[0];
  const width = clampInt(b.width, 256, 1536, 1024);
  const height = clampInt(b.height, 256, 1536, 1024);
  const seed = Number.isInteger(b.seed) ? b.seed : randSeed();

  const qs = new URLSearchParams({ width, height, model, seed, nologo: 'true' });
  const url = 'https://image.pollinations.ai/prompt/' + encodeURIComponent(prompt) + '?' + qs;
  activeImages++;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(90000) });
    const type = r.headers.get('content-type') || '';
    if (!r.ok || !type.startsWith('image/')) return send(res, 502, { error: 'IMG_UPSTREAM', detail: r.status });
    const buf = Buffer.from(await r.arrayBuffer());
    const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg';
    const name = crypto.randomUUID() + '.' + ext;
    fs.writeFileSync(path.join(OUTPUTS, name), buf);
    send(res, 200, { url: '/outputs/' + name, seed });
  } catch (e) {
    send(res, 504, { error: 'IMG_TIMEOUT' });
  } finally {
    activeImages--;
  }
}

/* ---------- videos (Gradio Space on Hugging Face) ---------- */
const jobs = new Map(); // id -> {status, url, error, created}
let chain = Promise.resolve();

function fillInputs(template, prompt, seed) {
  return template.map(v => v === '{{prompt}}' ? prompt : v === '{{seed}}' ? seed : v);
}
function findFileUrl(node, base) {
  if (!node) return null;
  if (typeof node === 'string') {
    if (/^https?:\/\/.+\.(mp4|webm)(\?.*)?$/i.test(node)) return node;
    return null;
  }
  if (Array.isArray(node)) {
    for (const n of node) { const f = findFileUrl(n, base); if (f) return f; }
    return null;
  }
  if (typeof node === 'object') {
    if (typeof node.url === 'string' && node.url) return node.url.startsWith('http') ? node.url : base + node.url;
    if (typeof node.path === 'string' && /\.(mp4|webm)$/i.test(node.path)) return `${base}/gradio_api/file=${node.path}`;
    for (const k of Object.keys(node)) { const f = findFileUrl(node[k], base); if (f) return f; }
  }
  return null;
}
function authHeaders() { return HF_TOKEN ? { Authorization: 'Bearer ' + HF_TOKEN } : {}; }
function fail(code, detail) { const e = new Error(code); e.code = code; e.detail = detail; return e; }

async function gradioCall(base, apiName, data, timeoutMs) {
  const signal = AbortSignal.timeout(timeoutMs);
  let prefix = '/gradio_api';
  let r = await fetch(`${base}${prefix}/call/${apiName}`, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ data })
  });
  if (r.status === 404) { // older Gradio versions have no /gradio_api prefix
    prefix = '';
    r = await fetch(`${base}/call/${apiName}`, {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ data })
    });
  }
  if (!r.ok) throw fail('VID_REJECTED', r.status);
  const { event_id } = await r.json();
  const s = await fetch(`${base}${prefix}/call/${apiName}/${event_id}`, { signal, headers: authHeaders() });
  const text = await s.text();
  let event = null, payload = null;
  for (const block of text.split('\n\n')) {
    const ev = /^event:\s*(.+)$/m.exec(block), da = /^data:\s*(.+)$/m.exec(block);
    if (ev && ev[1].trim() === 'complete' && da) { event = 'complete'; payload = JSON.parse(da[1]); }
    if (ev && ev[1].trim() === 'error') { throw fail('VID_QUOTA'); }
  }
  if (event !== 'complete') throw fail('VID_NO_RESULT');
  return { payload, prefix };
}

async function runVideoJob(id, prompt, seed) {
  const job = jobs.get(id);
  job.status = 'running';
  try {
    const v = config.video;
    const base = v.spaceUrl.replace(/\/+$/, '');
    const apiName = v.apiName.replace(/^\/+/, '');
    const { payload } = await gradioCall(base, apiName, fillInputs(v.inputs, prompt, seed), (v.timeoutSeconds || 600) * 1000);
    const fileUrl = findFileUrl(payload, base);
    if (!fileUrl) throw fail('VID_NO_FILE');
    const r = await fetch(fileUrl, { headers: authHeaders(), signal: AbortSignal.timeout(120000) });
    if (!r.ok) throw fail('VID_DOWNLOAD');
    const ext = /webm/i.test(r.headers.get('content-type') || '') ? 'webm' : 'mp4';
    const name = crypto.randomUUID() + '.' + ext;
    fs.writeFileSync(path.join(OUTPUTS, name), Buffer.from(await r.arrayBuffer()));
    job.url = '/outputs/' + name;
    job.status = 'done';
  } catch (e) {
    job.status = 'error';
    job.error = e.code || (e.name === 'TimeoutError' ? 'VID_TIMEOUT' : 'VID_UNKNOWN');
    job.detail = e.detail;
  }
}

async function handleVideoStart(req, res, ip) {
  const v = config.video;
  if (!v.enabled || !v.spaceUrl) return send(res, 503, { error: 'VID_DISABLED' });
  if (limited(ip, 'vid', v.maxPerHour)) return send(res, 429, { error: 'RATE_VID' });
  const pending = [...jobs.values()].filter(j => j.status === 'queued' || j.status === 'running').length;
  if (pending >= v.maxQueue) return send(res, 503, { error: 'QUEUE_FULL' });
  const b = await readJson(req);
  const prompt = cleanPrompt(b.prompt);
  if (!prompt) return send(res, 400, { error: 'EMPTY_PROMPT' });
  const seed = Number.isInteger(b.seed) ? b.seed : randSeed();
  const id = crypto.randomUUID();
  jobs.set(id, { status: 'queued', created: Date.now() });
  chain = chain.then(() => runVideoJob(id, prompt, seed)).catch(() => {});
  send(res, 202, { id });
}
function handleVideoStatus(res, id) {
  const job = jobs.get(id);
  if (!job) return send(res, 404, { error: 'NOT_FOUND' });
  const ahead = [...jobs.entries()].filter(([k, j]) => j.created < job.created && (j.status === 'queued' || j.status === 'running')).length;
  send(res, 200, { status: job.status, url: job.url, error: job.error, detail: job.detail, ahead: job.status === 'queued' ? ahead : 0 });
}

/* ---------- static files ---------- */
function serveFile(res, base, rel, cache) {
  let p;
  try { p = path.normalize(path.join(base, decodeURIComponent(rel))); } catch { res.writeHead(400); return res.end(); }
  if (p !== base && !p.startsWith(base + path.sep)) { res.writeHead(403); return res.end(); }
  fs.stat(p, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(p).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': cache ? 'public, max-age=3600' : 'no-cache',
      'X-Content-Type-Options': 'nosniff'
    });
    fs.createReadStream(p).pipe(res);
  });
}

/* ---------- server ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const ip = clientIp(req);
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, corsHeaders()); return res.end(); }
    if (req.method === 'GET' && url.pathname === '/api/config') {
      return send(res, 200, {
        videoEnabled: !!(config.video.enabled && config.video.spaceUrl),
        imageModels: config.image.models,
        maxPromptLength: config.maxPromptLength,
        retentionHours: config.retentionHours
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/image') return await handleImage(req, res, ip);
    if (req.method === 'POST' && url.pathname === '/api/video') return await handleVideoStart(req, res, ip);
    const m = /^\/api\/video\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (req.method === 'GET' && m) return handleVideoStatus(res, m[1]);
    if (req.method === 'GET' && url.pathname.startsWith('/outputs/')) return serveFile(res, OUTPUTS, url.pathname.slice('/outputs/'.length), true);
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return serveFile(res, ROOT, 'index.html', false);
    res.writeHead(req.method === 'GET' ? 404 : 405); res.end();
  } catch (e) {
    if (!res.headersSent) send(res, 400, { error: 'BAD_REQUEST' });
  }
});

/* ---------- cleanup old outputs ---------- */
setInterval(() => {
  const maxAge = (config.retentionHours || 24) * 3600e3, now = Date.now();
  for (const f of fs.readdirSync(OUTPUTS)) {
    const p = path.join(OUTPUTS, f);
    try { if (now - fs.statSync(p).mtimeMs > maxAge) fs.unlinkSync(p); } catch {}
  }
  for (const [id, j] of jobs) if (now - j.created > maxAge) jobs.delete(id);
}, 30 * 60 * 1000).unref();

server.listen(PORT, () => console.log(`Free-Gen running on http://localhost:${PORT}`));

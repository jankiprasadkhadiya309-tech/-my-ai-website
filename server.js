'use strict';
/* BEYOND AI backend. Zero npm dependencies: Node 20+ and FFmpeg only. See ../README.md for deployment. */
const http = require('node:http');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

/* ---------- config (environment variables; optional backend/.env for local use) ---------- */
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch (e) { /* no .env file */ }
const env = process.env;
const list = s => (s || '').split(',').map(x => x.trim()).filter(Boolean);
const cfg = {
  port: +env.PORT || 8787,
  dataDir: path.resolve(env.DATA_DIR || path.join(__dirname, 'data')),
  maxUploadBytes: (+env.MAX_UPLOAD_MB || 1024) * 1048576,
  maxVideoSeconds: +env.MAX_VIDEO_SECONDS || 3600,
  allowedOrigins: list(env.ALLOWED_ORIGINS),
  publicUrl: (env.PUBLIC_URL || '').replace(/\/$/, ''),
  trustProxy: env.TRUST_PROXY === 'true',
  retentionMs: (+env.RETENTION_HOURS || 24) * 3600e3,
  maxJobs: Math.max(1, +env.MAX_CONCURRENT_JOBS || 1),
  plannerTimeoutMs: +env.PLANNER_TIMEOUT_MS || 20000,
  jobsPerMin: +env.JOB_RATE_PER_MIN || 6,
  anthropic: { key: env.ANTHROPIC_API_KEY || '', model: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5', baseUrl: env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com' },
  stt: { key: env.OPENAI_API_KEY || '', baseUrl: env.OPENAI_BASE_URL || 'https://api.openai.com', model: env.STT_MODEL || 'whisper-1' },
  musicDir: path.resolve(env.MUSIC_DIR || path.join(__dirname, 'assets', 'music')),
  frontendDir: path.resolve(env.FRONTEND_DIR || path.join(__dirname, '..', 'public')),
  serveFrontend: env.SERVE_FRONTEND !== 'false'
};
const media = require('./media');
const { createPlan } = require('./planner');
const { runJob, newJob } = require('./pipeline');
const { createPremium } = require('./premium');
const premium = createPremium(env, cfg.dataDir);

const UP_DIR = path.join(cfg.dataDir, 'uploads'), JOB_DIR = path.join(cfg.dataDir, 'jobs');
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EXTS = { mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' };
const uploads = new Map(), jobs = new Map(), ctls = new Map();
let caps = {};

/* ---------- small helpers ---------- */
const httpErr = (status, code, message, issues) => Object.assign(new Error(message), { status, code, issues });
function send(res, status, body, headers = {}) {
  const b = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(b);
}
function readJson(req, max = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > max) { reject(httpErr(413, 'TOO_LARGE', 'Request body is too large.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(httpErr(400, 'BAD_JSON', 'Request body is not valid JSON.')); } });
    req.on('error', reject);
  });
}
const clientIp = req => (cfg.trustProxy && (req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || 'unknown';
const hits = new Map();
function rateLimit(req, bucket, max, windowMs) {
  const k = bucket + ':' + clientIp(req), now = Date.now();
  const a = (hits.get(k) || []).filter(t => now - t < windowMs);
  if (a.length >= max) throw httpErr(429, 'RATE_LIMITED', 'Too many requests. Wait a moment and retry.');
  a.push(now); hits.set(k, a);
}
/* Brute-force guard for premium codes: 6 wrong codes from one IP within 10 minutes locks activation for that IP until the window passes. */
const failHits = new Map();
function lockoutCheck(req) {
  const a = (failHits.get(clientIp(req)) || []).filter(t => Date.now() - t < 600000);
  if (a.length >= 6) throw httpErr(429, 'TOO_MANY_ATTEMPTS', 'Too many wrong codes. Wait 10 minutes and try again.');
}
function lockoutFail(req) { const k = clientIp(req), a = (failHits.get(k) || []).filter(t => Date.now() - t < 600000); a.push(Date.now()); failHits.set(k, a); }
setInterval(() => { const now = Date.now(); for (const [k, a] of failHits) if (!a.some(t => now - t < 600000)) failHits.delete(k); }, 300000).unref();
setInterval(() => { const now = Date.now(); for (const [k, a] of hits) if (!a.some(t => now - t < 600000)) hits.delete(k); }, 300000).unref();

/* ---------- CORS ---------- */
function originAllowed(origin) {
  if (!origin) return false;
  return cfg.allowedOrigins.some(p => p === '*' || p === origin || (p.includes('*') && new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^.]+') + '$').test(origin)));
}
function cors(req, res) {
  const origin = req.headers.origin;
  res.setHeader('vary', 'Origin');
  if (originAllowed(origin)) {
    res.setHeader('access-control-allow-origin', cfg.allowedOrigins.includes('*') ? '*' : origin);
    res.setHeader('access-control-allow-methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type,x-file-name,x-premium-token');
    res.setHeader('access-control-expose-headers', 'content-length,content-range,accept-ranges,content-disposition');
    res.setHeader('access-control-max-age', '86400');
  }
}

/* ---------- persistence ---------- */
async function writeJson(file, obj) { const tmp = file + '.tmp'; await fsp.writeFile(tmp, JSON.stringify(obj)); await fsp.rename(tmp, file); }
const publicJob = j => ({ id: j.id, status: j.status, progress: j.progress, steps: j.steps, warnings: j.warnings, applied: j.applied, error: j.error, queue_position: j.status === 'queued' ? queue.indexOf(j.id) + 1 : 0,
  result: j.result ? { format: j.result.format, duration_seconds: j.result.duration_seconds, width: j.result.width, height: j.result.height, size_bytes: j.result.size_bytes, has_audio: j.result.has_audio } : null });
/* Premium accounting: an export is reserved when a job is created and kept only if the render finishes (done). Failed or cancelled jobs give it back. Idempotent. */
function settleJob(job) {
  if (!job || !job.premium) return;
  if (job.status === 'done') premium.settle(job.premium, 'done');
  else if (job.status === 'error' || job.status === 'cancelled') premium.refund(job.premium);
}
async function loadState() {
  await fsp.mkdir(UP_DIR, { recursive: true }); await fsp.mkdir(JOB_DIR, { recursive: true });
  for (const id of await fsp.readdir(UP_DIR)) { try { uploads.set(id, JSON.parse(await fsp.readFile(path.join(UP_DIR, id, 'meta.json'), 'utf8'))); } catch (e) { /* skip */ } }
  for (const id of await fsp.readdir(JOB_DIR)) {
    try {
      const j = JSON.parse(await fsp.readFile(path.join(JOB_DIR, id, 'job.json'), 'utf8'));
      if (j.status === 'queued' || j.status === 'running') { j.status = 'error'; j.error = { code: 'INTERRUPTED', message: 'The server restarted while this job was running. Please start it again.' }; }
      jobs.set(id, j); settleJob(j);
    } catch (e) { /* skip */ }
  }
}

/* ---------- uploads ---------- */
async function handleUpload(req, res, url) {
  rateLimit(req, 'upload', 10, 60000);
  let name = url.searchParams.get('name') || req.headers['x-file-name'] || 'video.mp4';
  try { name = decodeURIComponent(name); } catch (e) { /* keep raw */ }
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (!EXTS[ext]) throw httpErr(415, 'BAD_FORMAT', 'Unsupported format “.' + ext + '”. Use MP4, MOV or WebM.');
  const declared = +req.headers['content-length'] || 0;
  if (declared > cfg.maxUploadBytes) throw httpErr(413, 'TOO_LARGE', 'File is too large. The server accepts up to ' + Math.round(cfg.maxUploadBytes / 1048576) + ' MB.');
  if (declared === 0 && !req.headers['transfer-encoding']) throw httpErr(411, 'LENGTH_REQUIRED', 'The upload is empty or has no length.');
  const id = crypto.randomUUID(), dir = path.join(UP_DIR, id), file = path.join(dir, 'source.' + ext);
  await fsp.mkdir(dir, { recursive: true });
  let n = 0;
  const counter = new Transform({ transform(c, _e, cb) { n += c.length; n > cfg.maxUploadBytes ? cb(httpErr(413, 'TOO_LARGE', 'File is too large. The server accepts up to ' + Math.round(cfg.maxUploadBytes / 1048576) + ' MB.')) : cb(null, c); } });
  const cleanup = () => fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  try { await pipeline(req, counter, fs.createWriteStream(file)); }
  catch (e) { await cleanup(); throw e.status ? e : httpErr(499, 'UPLOAD_ABORTED', 'The upload was interrupted.'); }
  if (n === 0) { await cleanup(); throw httpErr(400, 'EMPTY', 'This file is empty.'); }
  let p;
  try { p = await media.probe(file); } catch (e) { await cleanup(); throw httpErr(422, 'NOT_A_VIDEO', 'The server could not read this file as a video.'); }
  if (!p.hasVideo || !(p.duration > 0)) { await cleanup(); throw httpErr(422, 'NOT_A_VIDEO', 'This file has no readable video stream.'); }
  if (p.duration > cfg.maxVideoSeconds) { await cleanup(); throw httpErr(413, 'TOO_LONG', 'This video is too long. The server accepts up to ' + Math.round(cfg.maxVideoSeconds / 60) + ' minutes.'); }
  const meta = { id, name, ext, size: n, created_at: Date.now(), probe: p };
  await writeJson(path.join(dir, 'meta.json'), meta);
  uploads.set(id, meta);
  send(res, 201, { upload_id: id, name, size_bytes: n, duration: p.duration, width: p.width, height: p.height, has_audio: p.hasAudio });
}

/* ---------- jobs ---------- */
const queue = [];
let active = 0;
function pump() {
  while (active < cfg.maxJobs && queue.length) {
    const id = queue.shift(), job = jobs.get(id);
    if (!job || job.status !== 'queued') continue;
    const up = uploads.get(job.upload_id);
    if (!up) { job.status = 'error'; job.error = { code: 'UPLOAD_NOT_FOUND', message: 'The uploaded video is no longer on the server. Upload it again.' }; settleJob(job); continue; }
    const dir = path.join(JOB_DIR, id), ac = new AbortController();
    const ctl = { child: null, cancelled: false, ac };
    ctls.set(id, ctl); active++;
    const save = () => writeJson(path.join(dir, 'job.json'), job).catch(() => {});
    const source = path.join(UP_DIR, up.id, 'source.' + up.ext);
    runJob(job, { cfg, dir, source, ctl, save, caps, signal: ac.signal })
      .catch(e => { job.status = 'error'; job.error = { code: 'INTERNAL', message: e.message || 'Unexpected error.' }; save(); })
      .finally(() => { active--; ctls.delete(id); settleJob(job); pump(); });
  }
}
async function handleCreateJob(req, res) {
  rateLimit(req, 'job', cfg.jobsPerMin, 60000);
  const body = await readJson(req);
  const { validatePlan } = require('./planSchema');
  if (!ID_RE.test(body.upload_id || '') || !uploads.has(body.upload_id)) throw httpErr(404, 'UPLOAD_NOT_FOUND', 'The uploaded video was not found on the server. Upload it again.');
  const v = validatePlan(body.plan);
  if (!v.ok) throw httpErr(422, 'INVALID_PLAN', 'The editing plan is not valid.', v.errors);
  if (!v.plan.understood) throw httpErr(422, 'INVALID_PLAN', 'The plan is not an editing instruction.');
  if (queue.length >= 20) throw httpErr(503, 'BUSY', 'The editing queue is full. Try again shortly.');
  /* Premium gate. Checked and reserved synchronously, so a double click or two tabs can never take the same export twice. */
  const ticket = premium.charge(req.headers['x-premium-token'], body.request_id);
  if (ticket.duplicate) {
    const prior = ticket.job_id && jobs.get(ticket.job_id);
    if (!prior) throw httpErr(409, 'DUPLICATE_REQUEST', 'This export request is already being started. Wait a moment.');
    return send(res, 200, { job_id: prior.id, job: publicJob(prior), duplicate: true });
  }
  const id = crypto.randomUUID();
  const job = newJob(id, body.upload_id, v.plan);
  if (ticket.tracked) job.premium = { sid: ticket.sid, request_id: ticket.request_id };
  try {
    await fsp.mkdir(path.join(JOB_DIR, id), { recursive: true });
    await writeJson(path.join(JOB_DIR, id, 'job.json'), job);
  } catch (e) { premium.refund(job.premium); throw e; }
  if (ticket.tracked) premium.attach(ticket, id);
  jobs.set(id, job); queue.push(id); pump();
  send(res, 202, { job_id: id, job: publicJob(job) });
}
function getJob(id) { if (!ID_RE.test(id) || !jobs.has(id)) throw httpErr(404, 'JOB_NOT_FOUND', 'This job was not found. It may have expired or the server was reset.'); return jobs.get(id); }

function sendFile(req, res, file, { type, downloadName }) {
  let st; try { st = fs.statSync(file); } catch (e) { throw httpErr(404, 'FILE_NOT_FOUND', 'The file is no longer available.'); }
  const h = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=3600' };
  if (downloadName) h['content-disposition'] = 'attachment; filename="' + downloadName.replace(/[^\w.\- ]/g, '_') + '"';
  let start = 0, end = st.size - 1, status = 200;
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m && (m[1] || m[2])) {
    if (m[1]) { start = +m[1]; if (m[2]) end = Math.min(+m[2], end); } else { start = Math.max(0, st.size - +m[2]); }
    if (start > end || start >= st.size) { res.writeHead(416, { ...h, 'content-range': 'bytes */' + st.size }); return res.end(); }
    status = 206; h['content-range'] = `bytes ${start}-${end}/${st.size}`;
  }
  h['content-length'] = end - start + 1;
  res.writeHead(status, h);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
}

/* ---------- static frontend (optional; lets one deployment serve both) ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function serveStatic(req, res, pathname) {
  if (!cfg.serveFrontend) throw httpErr(404, 'NOT_FOUND', 'Not found.');
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(cfg.frontendDir, rel));
  if (!file.startsWith(cfg.frontendDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) throw httpErr(404, 'NOT_FOUND', 'Not found.');
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
  fs.createReadStream(file).pipe(res);
}

/* ---------- router ---------- */
const server = http.createServer(async (req, res) => {
  cors(req, res);
  res.setHeader('x-content-type-options', 'nosniff');
  const url = new URL(req.url, 'http://x'), p = url.pathname;
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (p === '/api/health') return send(res, 200, { ok: true, service: 'beyond-ai-backend', ai_planner: !!cfg.anthropic.key, model: cfg.anthropic.model, captions_stt: !!cfg.stt.key, music_library: fs.existsSync(cfg.musicDir) ? fs.readdirSync(cfg.musicDir).filter(f => /\.(mp3|m4a|wav|ogg|aac|flac)$/i.test(f)).length : 0, premium: { required: premium.cfg.required, daily_codes: premium.counts().daily, unlimited_codes: premium.counts().unlimited }, ffmpeg: caps, cors_origins: cfg.allowedOrigins, max_upload_mb: Math.round(cfg.maxUploadBytes / 1048576) });
    if (p === '/config.js') {
      const proto = cfg.trustProxy ? (req.headers['x-forwarded-proto'] || 'http') : (req.socket.encrypted ? 'https' : 'http');
      const origin = cfg.publicUrl || proto + '://' + req.headers.host;
      return send(res, 200, 'window.BEYOND_CONFIG=' + JSON.stringify({ apiUrl: origin }) + ';\n', { 'content-type': 'text/javascript; charset=utf-8' });
    }
    if (p === '/api/uploads' && (req.method === 'POST' || req.method === 'PUT')) return await handleUpload(req, res, url);
    if (p === '/api/plan' && req.method === 'POST') {
      rateLimit(req, 'plan', 15, 60000);
      const body = await readJson(req);
      const ac = new AbortController(); res.on('close', () => { if (!res.writableEnded) ac.abort(); });
      const up = body && ID_RE.test(body.upload_id || '') ? uploads.get(body.upload_id) : null;
      const plan = await createPlan(body, { cfg, signal: ac.signal, probed: up ? up.probe : null });
      return send(res, 200, { plan });
    }
    if (p === '/api/premium/status' && req.method === 'GET') {
      rateLimit(req, 'pstatus', 120, 60000);
      return send(res, 200, { status: premium.status(req.headers['x-premium-token']) });
    }
    if (p === '/api/premium/activate' && req.method === 'POST') {
      rateLimit(req, 'pactivate', 20, 60000);
      lockoutCheck(req);
      const body = await readJson(req, 4096);
      try { return send(res, 200, await premium.activate(req.headers['x-premium-token'], body.mode, body.code)); }
      catch (e) { if (e.code === 'INVALID_CODE' || e.code === 'WRONG_CODE_TYPE') lockoutFail(req); throw e; }
    }
    if (p === '/api/jobs' && req.method === 'POST') return await handleCreateJob(req, res);
    let m;
    if ((m = /^\/api\/jobs\/([^/]+)$/.exec(p)) && req.method === 'GET') return send(res, 200, { job: publicJob(getJob(m[1])) });
    if ((m = /^\/api\/jobs\/([^/]+)\/cancel$/.exec(p)) && req.method === 'POST') {
      const j = getJob(m[1]);
      if (j.status === 'queued') { j.status = 'cancelled'; j.error = { code: 'CANCELLED', message: 'The job was cancelled.' }; const i = queue.indexOf(j.id); if (i >= 0) queue.splice(i, 1); settleJob(j); }
      else if (j.status === 'running') { const c = ctls.get(j.id); if (c) { c.cancelled = true; c.ac.abort(); if (c.child) c.child.kill('SIGKILL'); } }
      return send(res, 200, { job: publicJob(j) });
    }
    if ((m = /^\/api\/jobs\/([^/]+)\/output$/.exec(p)) && (req.method === 'GET' || req.method === 'HEAD')) {
      const j = getJob(m[1]);
      if (j.status !== 'done' || !j.result) throw httpErr(409, 'NOT_READY', 'The video is not ready yet.');
      const base = ((uploads.get(j.upload_id) || {}).name || 'video').replace(/\.[^.]+$/, '');
      return sendFile(req, res, path.join(JOB_DIR, j.id, j.result.file), { type: EXTS[j.result.format], downloadName: url.searchParams.get('download') ? base + '-beyond-ai.' + j.result.format : null });
    }
    if (p.startsWith('/api/')) throw httpErr(404, 'NOT_FOUND', 'Unknown API route.');
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, p);
    throw httpErr(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
  } catch (e) {
    if (res.headersSent) return res.destroy();
    const status = e.status || 500;
    if (status === 500) console.error('[error]', req.method, p, e);
    send(res, status, { error: { code: e.code || 'INTERNAL', message: status === 500 ? 'Internal server error.' : e.message, issues: e.issues, resets_at: e.resets_at } });
  }
});
server.requestTimeout = 0; /* large uploads may take a long time */
server.headersTimeout = 30000;

/* ---------- retention sweep ---------- */
async function sweep() {
  const now = Date.now(), busy = new Set([...jobs.values()].filter(j => j.status === 'queued' || j.status === 'running').map(j => j.upload_id));
  for (const [id, j] of jobs) if (now - j.updated_at > cfg.retentionMs && j.status !== 'running' && j.status !== 'queued') { jobs.delete(id); await fsp.rm(path.join(JOB_DIR, id), { recursive: true, force: true }).catch(() => {}); }
  for (const [id, u] of uploads) if (now - u.created_at > cfg.retentionMs && !busy.has(id)) { uploads.delete(id); await fsp.rm(path.join(UP_DIR, id), { recursive: true, force: true }).catch(() => {}); }
}

async function main() {
  caps = await media.capabilities();
  await premium.load();
  await loadState();
  setInterval(() => sweep().catch(() => {}), 600000).unref();
  server.listen(cfg.port, '0.0.0.0', () => {
    console.log(`BEYOND AI backend listening on :${cfg.port}`);
    console.log(`  ffmpeg: ${caps.ffmpeg ? 'ok' : 'MISSING'} · ai planner: ${cfg.anthropic.key ? 'configured (' + cfg.anthropic.model + ')' : 'NOT configured (ANTHROPIC_API_KEY)'} · captions STT: ${cfg.stt.key ? 'configured' : 'not configured'}`);
    { const c = premium.counts(); console.log(`  premium: ${premium.cfg.required ? 'REQUIRED for exports' : 'not required'} · ${c.daily} daily code(s), ${c.unlimited} unlimited code(s)` + (premium.cfg.required && !c.daily && !c.unlimited ? '  <-- WARNING: no codes configured (PREMIUM_DAILY_CODES / PREMIUM_UNLIMITED_CODES), so nobody can export' : '')); }
    console.log(`  CORS origins: ${cfg.allowedOrigins.length ? cfg.allowedOrigins.join(', ') : '(none: only same-origin browsers can call this API; set ALLOWED_ORIGINS)'}`);
  });
}
if (require.main === module) main(); else module.exports = { main, server, cfg };

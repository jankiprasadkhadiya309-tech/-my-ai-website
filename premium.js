'use strict';
/* premium.js: server-side Premium for BEYOND AI. Zero dependencies.
   The browser never sees a code list. It sends a code once, gets back an opaque session token, and sends that token in the
   `x-premium-token` header. Everything (activation time, expiry, export count) is stored on the server in DATA_DIR/premium.json,
   so a page refresh or a server restart never resets it.

   Codes come from the environment (or an optional JSON file that is re-read when it changes, so a code can be revoked without a restart):
     PREMIUM_DAILY_CODES=CODE1,CODE2         daily codes   -> 24 h window with 1 export (PREMIUM_DAILY_HOURS / PREMIUM_DAILY_EXPORTS)
     PREMIUM_UNLIMITED_CODES=CODE3           unlimited     -> no export limit for PREMIUM_UNLIMITED_DAYS days (default 30)
     PREMIUM_CODES_FILE=/data/codes.json     {"daily":["..."],"unlimited":["..."]}
   Each entry may be plain text or "sha256:<hex of the UPPERCASED code>" so the secret itself need not sit in the environment.
   PREMIUM_REQUIRED=true (default) means exporting needs an active Premium. false = exports are open, Premium still tracked. */
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const norm = s => String(s || '').trim().toUpperCase();
const list = s => (s || '').split(',').map(x => x.trim()).filter(Boolean);
const err = (status, code, message, extra) => Object.assign(new Error(message), { status, code }, extra || {});
const REQ_ID = /^[A-Za-z0-9_-]{8,100}$/;

function createPremium(env, dataDir, now = () => Date.now()) {
  const cfg = {
    required: env.PREMIUM_REQUIRED !== 'false',
    dailyMs: (+env.PREMIUM_DAILY_HOURS || 24) * 3600e3,
    dailyLimit: Math.max(1, +env.PREMIUM_DAILY_EXPORTS || 1),
    unlimitedMs: (+env.PREMIUM_UNLIMITED_DAYS || 30) * 86400e3,
    codesFile: env.PREMIUM_CODES_FILE ? path.resolve(env.PREMIUM_CODES_FILE) : '',
  };
  const file = path.join(dataDir, 'premium.json');
  let db = { sessions: {} };           /* key = sha256(token) */
  let fileCodes = { mtime: 0, daily: [], unlimited: [] };
  let writing = Promise.resolve();

  /* ---- codes ---- */
  const toHashes = arr => new Set(arr.map(x => /^sha256:[0-9a-f]{64}$/i.test(x) ? x.slice(7).toLowerCase() : sha(norm(x))));
  function codeSets() {
    if (cfg.codesFile) {
      try {
        const st = fs.statSync(cfg.codesFile);
        if (st.mtimeMs !== fileCodes.mtime) {
          const j = JSON.parse(fs.readFileSync(cfg.codesFile, 'utf8'));
          fileCodes = { mtime: st.mtimeMs, daily: Array.isArray(j.daily) ? j.daily.map(String) : [], unlimited: Array.isArray(j.unlimited) ? j.unlimited.map(String) : [] };
        }
      } catch (e) { fileCodes = { mtime: 0, daily: [], unlimited: [] }; }   /* unreadable file = no file codes (fail closed) */
    }
    return { daily: toHashes([...list(env.PREMIUM_DAILY_CODES), ...fileCodes.daily]), unlimited: toHashes([...list(env.PREMIUM_UNLIMITED_CODES), ...fileCodes.unlimited]) };
  }
  /* constant-time membership test */
  function has(set, h) {
    let found = false; const a = Buffer.from(h, 'hex');
    for (const x of set) { const b = Buffer.from(x, 'hex'); if (b.length === a.length && crypto.timingSafeEqual(a, b)) found = true; }
    return found;
  }

  /* ---- persistence ---- */
  async function load() {
    await fsp.mkdir(dataDir, { recursive: true });
    try { const j = JSON.parse(await fsp.readFile(file, 'utf8')); if (j && typeof j.sessions === 'object') db = j; } catch (e) { /* first run */ }
  }
  function persist() {
    const snap = JSON.stringify(db), tmp = file + '.tmp';
    writing = writing.then(() => fsp.writeFile(tmp, snap).then(() => fsp.rename(tmp, file))).catch(() => {});
    return writing;
  }

  /* ---- status ---- */
  const used = s => Object.values(s.charges || {}).filter(c => c.state !== 'refunded').length;
  const finished = s => s.finished_total || 0;
  function state(s) {
    if (!s || !s.mode || !s.code_hash) return 'none';
    const sets = codeSets();
    if (!has(s.mode === 'unlimited' ? sets.unlimited : sets.daily, s.code_hash)) return 'revoked';
    return now() >= s.expires_at ? 'expired' : 'active';
  }
  function statusOf(s) {
    const t = now(), st = state(s);
    const out = { state: st, mode: s ? s.mode : null, premium_required: cfg.required, server_time: t, activated_at: s ? s.activated_at : null, expires_at: s ? s.expires_at : null, exports_used: s ? finished(s) : 0, daily_limit: cfg.dailyLimit, remaining_exports: null, limit_reached: false, resets_at: null };
    if (s && s.mode === 'daily') { out.remaining_exports = st === 'active' ? Math.max(0, cfg.dailyLimit - used(s)) : 0; out.limit_reached = st === 'active' && out.remaining_exports === 0; out.resets_at = s.expires_at; }
    return out;
  }
  const find = token => (typeof token === 'string' && token.length >= 32 && token.length <= 128) ? db.sessions[sha(token)] : undefined;
  const status = token => statusOf(find(token));

  /* ---- activation ---- */
  async function activate(token, mode, code) {
    if (mode !== 'daily' && mode !== 'unlimited') throw err(400, 'BAD_MODE', 'Choose Daily or Unlimited.');
    if (typeof code !== 'string' || norm(code).length < 4 || code.length > 128) throw err(400, 'BAD_CODE', 'Enter your premium code first.');
    const h = sha(norm(code)), sets = codeSets();
    const isDaily = has(sets.daily, h), isUnl = has(sets.unlimited, h);
    if (!isDaily && !isUnl) throw err(403, 'INVALID_CODE', 'That code is not valid.');
    if (mode === 'daily' && !isDaily) throw err(403, 'WRONG_CODE_TYPE', 'That is not a Daily code. Use the Unlimited box for it.');
    if (mode === 'unlimited' && !isUnl) throw err(403, 'WRONG_CODE_TYPE', 'That is not an Unlimited code. Use the Daily box for it.');

    let s = find(token), tok = null;
    if (!s) { tok = crypto.randomBytes(32).toString('hex'); s = { mode: null, finished_total: 0, charges: {} }; }
    const st = state(s), t = now();
    let message, already = false;
    if (st === 'active' && s.mode === 'unlimited' && mode === 'daily') throw err(409, 'ALREADY_UNLIMITED', 'Unlimited Premium is already active, so the Daily code is not needed.');
    if (st === 'active' && s.mode === mode) { already = true; message = (mode === 'unlimited' ? 'Unlimited' : 'Daily') + ' Premium is already active.'; }
    else {
      s.mode = mode; s.code_hash = h; s.activated_at = t; s.charges = {};
      s.expires_at = t + (mode === 'daily' ? cfg.dailyMs : cfg.unlimitedMs);
      message = mode === 'daily' ? `Daily Premium activated. ${cfg.dailyLimit} video export${cfg.dailyLimit > 1 ? 's' : ''} available for the next ${Math.round(cfg.dailyMs / 3600e3)} hours.` : 'Unlimited Premium activated. Unlimited video exports until it expires.';
    }
    if (tok) db.sessions[sha(tok)] = s;   /* a session is stored only once a code has really been accepted */
    await persist();
    return { token: tok, status: statusOf(s), message, already_active: already };
  }

  /* ---- export accounting ---- */
  /* Called synchronously (no await between check and write) so two simultaneous requests cannot both take the last export.
     Returns {tracked:false} when Premium is not required and no session exists. */
  function charge(token, requestId) {
    const s = find(token), st = state(s);
    const rid = REQ_ID.test(requestId || '') ? requestId : crypto.randomUUID();
    if (!s || st === 'none') {
      if (cfg.required) throw err(402, 'PREMIUM_REQUIRED', 'Exporting needs Premium. Enter your premium code to unlock exports.');
      return { tracked: false };
    }
    const prior = s.charges[rid];
    if (prior && prior.state !== 'refunded') return { tracked: true, duplicate: true, job_id: prior.job_id, sid: sha(token), request_id: rid };
    if (st === 'revoked') { if (cfg.required) throw err(402, 'PREMIUM_REVOKED', 'Your premium code is no longer valid.'); return { tracked: false }; }
    if (st === 'expired') { if (cfg.required) throw err(402, 'PREMIUM_EXPIRED', 'Your Premium has ended. Enter a code to export.'); return { tracked: false }; }
    if (s.mode === 'daily' && used(s) >= cfg.dailyLimit) throw err(429, 'DAILY_LIMIT_REACHED', 'Daily Export Limit Reached', { resets_at: s.expires_at });
    s.charges[rid] = { state: 'charged', job_id: null, at: now() };
    persist();
    return { tracked: true, sid: sha(token), request_id: rid };
  }
  function attach(ticket, jobId) { const s = db.sessions[ticket.sid]; if (s && s.charges[ticket.request_id]) { s.charges[ticket.request_id].job_id = jobId; persist(); } }
  /* outcome: 'done' keeps the export, anything else gives it back. Idempotent. */
  function settle(ticket, outcome) {
    if (!ticket || !ticket.sid) return;
    const s = db.sessions[ticket.sid], c = s && s.charges[ticket.request_id];
    if (!c || c.state !== 'charged') return;
    if (outcome === 'done') { c.state = 'final'; s.finished_total = finished(s) + 1; } else c.state = 'refunded';
    persist();
  }
  const refund = ticket => settle(ticket, 'refund');

  return { cfg, load, status, activate, charge, attach, settle, refund, counts: () => { const c = codeSets(); return { daily: c.daily.size, unlimited: c.unlimited.size }; } };
}

module.exports = { createPremium, REQ_ID };

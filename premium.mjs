/* Premium end-to-end test against the REAL backend process (no mocks needed: jobs here never call the AI planner).
   Covers: codes checked server-side, daily 24h window + 1 export, unlimited, duplicate request_id, simultaneous exports,
   refund on cancel, persistence across a restart, expiry, revocation, brute-force lockout, CORS header. Run: node test/premium.mjs */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const here = path.dirname(new URL(import.meta.url).pathname);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-prem-'));
const results = []; const ok = n => { results.push(n); console.log('  ✓ ' + n); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const clip = (name, secs, size) => { const f = path.join(tmp, name); const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=${size}:r=30:d=${secs}`, '-f', 'lavfi', '-i', `sine=f=440:d=${secs}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f]); assert.equal(r.status, 0, 'ffmpeg could not make the sample clip'); return fs.readFileSync(f); };
const small = clip('small.mp4', 2, '320x180'), big = clip('big.mp4', 25, '1280x720');
const PLAN = { understood: true, language: 'en', summary: 'test', style: 'cinematic', aspect_ratio: '16:9', resolution: '720p', remove_silence: false, max_duration_seconds: null, captions: false, caption_language: null, music: false, music_mood: null, transitions: false, transition_style: null, effects: [], output_format: 'mp4' };
const HEAVY = { ...PLAN, resolution: '1080p', effects: ['stabilization', 'noise_reduction', 'cinematic_grade'] };

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
async function start(port, env = {}, dataName = 'd' + port) {
  const e = { ...process.env, PORT: String(port), DATA_DIR: path.join(tmp, dataName), SERVE_FRONTEND: 'false', JOB_RATE_PER_MIN: '200', ALLOWED_ORIGINS: 'https://my-site.netlify.app', ...env };
  const p = spawn('node', [path.join(here, '..', 'server.js')], { env: e, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; p.stdout.on('data', d => log += d); p.stderr.on('data', d => log += d);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/api/health')).ok) return { p, base, log: () => log }; } catch (x) { /* wait */ } await sleep(100); }
  throw new Error('backend did not start: ' + log);
}
const stop = async b => { b.p.kill(); await new Promise(r => b.p.once('exit', r)); };
const api = (b, token) => async (method, url, body, extra = {}) => {
  const r = await fetch(b.base + url, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { 'x-premium-token': token } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null), headers: r.headers };
};
const upload = async (b, buf) => (await (await fetch(b.base + '/api/uploads?name=c.mp4', { method: 'POST', headers: { 'content-type': 'video/mp4' }, body: buf })).json()).upload_id;
const waitDone = async (b, id, timeoutMs = 90000) => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const response = await fetch(b.base + '/api/jobs/' + id);
    if (!response.ok) throw new Error('job lookup failed: HTTP ' + response.status);
    const j = (await response.json()).job;
    if (j && ['done', 'error', 'cancelled'].includes(j.status)) return j;
    await sleep(100);
  }
  const last = (await (await fetch(b.base + '/api/jobs/' + id)).json()).job;
  throw new Error('job timeout after ' + timeoutMs + 'ms; last status=' + (last && last.status));
};
const rid = () => crypto.randomUUID();

const HASHED = 'hashed-unl-777';
const servers = [];
try {
  console.log('Premium e2e');
  const A = await start(18791, { PREMIUM_DAILY_CODES: 'DAILY-TEST-1', PREMIUM_UNLIMITED_CODES: 'UNL-TEST-1,sha256:' + sha(HASHED.toUpperCase()) }); servers.push(A);
  const call = api(A);
  const up = await upload(A, small);

  let h = await call('GET', '/api/health'); assert.equal(h.body.premium.required, true); assert.equal(h.body.premium.daily_codes, 1); assert.equal(h.body.premium.unlimited_codes, 2);
  assert.ok(!JSON.stringify(h.body).includes('DAILY-TEST-1') && !JSON.stringify(h.body).includes('UNL-TEST-1')); ok('health reports code counts only, never the codes');
  const pf = await fetch(A.base + '/api/jobs', { method: 'OPTIONS', headers: { origin: 'https://my-site.netlify.app', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-premium-token' } });
  assert.match(pf.headers.get('access-control-allow-headers'), /x-premium-token/); ok('CORS preflight allows the x-premium-token header');

  let s = await call('GET', '/api/premium/status'); assert.equal(s.body.status.state, 'none'); assert.equal(s.body.status.premium_required, true); assert.ok(Math.abs(s.body.status.server_time - Date.now()) < 5000); ok('no token = state "none", premium required');
  let r = await call('POST', '/api/jobs', { upload_id: up, plan: PLAN, request_id: rid() }); assert.equal(r.status, 402); assert.equal(r.body.error.code, 'PREMIUM_REQUIRED'); ok('export without Premium is refused (402 PREMIUM_REQUIRED), nothing renders');

  r = await call('POST', '/api/premium/activate', { mode: 'daily', code: 'nope-nope' }); assert.equal(r.status, 403); assert.equal(r.body.error.code, 'INVALID_CODE'); ok('wrong code rejected');
  r = await call('POST', '/api/premium/activate', { mode: 'daily', code: 'UNL-TEST-1' }); assert.equal(r.status, 403); assert.equal(r.body.error.code, 'WRONG_CODE_TYPE'); ok('an Unlimited code cannot be used in the Daily box');
  r = await call('POST', '/api/premium/activate', { mode: 'daily', code: 'ab' }); assert.equal(r.status, 400); ok('too-short code rejected');

  r = await call('POST', '/api/premium/activate', { mode: 'daily', code: ' daily-test-1 ' });   /* trimmed + case-insensitive */
  assert.equal(r.status, 200); assert.match(r.body.token, /^[0-9a-f]{64}$/); const T = r.body.token, st = r.body.status;
  assert.equal(st.state, 'active'); assert.equal(st.mode, 'daily'); assert.equal(st.remaining_exports, 1); assert.equal(st.daily_limit, 1);
  assert.ok(Math.abs(st.expires_at - st.activated_at - 24 * 3600e3) < 1000); ok('Daily code activates a 24-hour window with 1 export (server returns an opaque token)');
  const a2 = await api(A, T)('POST', '/api/premium/activate', { mode: 'daily', code: 'DAILY-TEST-1' }); assert.equal(a2.body.already_active, true); assert.equal(a2.body.status.expires_at, st.expires_at); assert.equal(a2.body.token, null); ok('re-entering the code does not restart the window (already_active)');
  const raw = fs.readFileSync(path.join(tmp, 'd18791', 'premium.json'), 'utf8'); assert.ok(!raw.includes(T) && !raw.includes('DAILY-TEST-1') && !raw.toLowerCase().includes('daily-test-1')); ok('premium.json stores neither the token nor the code, only hashes');

  const D = api(A, T), id1 = rid();
  r = await D('POST', '/api/jobs', { upload_id: up, plan: PLAN, request_id: id1 }); assert.equal(r.status, 202); const job1 = r.body.job_id;
  r = await D('POST', '/api/jobs', { upload_id: up, plan: PLAN, request_id: id1 }); assert.equal(r.status, 200); assert.equal(r.body.job_id, job1); assert.equal(r.body.duplicate, true); ok('double click / retry with the same request_id returns the same job and is counted once');
  r = await D('POST', '/api/jobs', { upload_id: up, plan: PLAN, request_id: rid() }); assert.equal(r.status, 429); assert.equal(r.body.error.code, 'DAILY_LIMIT_REACHED'); assert.equal(r.body.error.resets_at, st.expires_at); ok('second export in the window is refused with DAILY_LIMIT_REACHED and the reset time');
  s = await D('GET', '/api/premium/status'); assert.equal(s.body.status.remaining_exports, 0); assert.equal(s.body.status.limit_reached, true); ok('status shows 0 remaining / limit reached');
  const j1 = await waitDone(A, job1); assert.equal(j1.status, 'done', JSON.stringify(j1.error));
  s = await D('GET', '/api/premium/status'); assert.equal(s.body.status.exports_used, 1); assert.equal(s.body.status.remaining_exports, 0); ok('finished render stays counted (exports_used 1, remaining 0)');

  /* unlimited */
  r = await call('POST', '/api/premium/activate', { mode: 'unlimited', code: HASHED }); assert.equal(r.status, 200); const U = r.body.token; assert.equal(r.body.status.mode, 'unlimited'); assert.ok(Math.abs(r.body.status.expires_at - r.body.status.activated_at - 30 * 86400e3) < 1000); ok('Unlimited code (stored only as a sha256 in the server env) activates for 30 days');
  const UA = api(A, U), ids = [];
  for (let i = 0; i < 3; i++) { r = await UA('POST', '/api/jobs', { upload_id: up, plan: PLAN, request_id: rid() }); assert.equal(r.status, 202); ids.push(r.body.job_id); }
  for (const i of ids) assert.equal((await waitDone(A, i)).status, 'done');
  s = await UA('GET', '/api/premium/status'); assert.equal(s.body.status.exports_used, 3); assert.equal(s.body.status.remaining_exports, null); ok('Unlimited allows many exports (3 done, no limit)');
  r = await UA('POST', '/api/premium/activate', { mode: 'daily', code: 'DAILY-TEST-1' }); assert.equal(r.status, 409); assert.equal(r.body.error.code, 'ALREADY_UNLIMITED'); ok('Daily code is refused while Unlimited is active');

  /* simultaneous exports cannot take the last slot twice */
  r = await call('POST', '/api/premium/activate', { mode: 'daily', code: 'DAILY-TEST-1' }); const T2 = r.body.token; const D2 = api(A, T2);
  const burst = await Promise.all(Array.from({ length: 6 }, () => D2('POST', '/api/jobs', { upload_id: up, plan: PLAN, request_id: rid() })));
  assert.equal(burst.filter(x => x.status === 202).length, 1); assert.equal(burst.filter(x => x.status === 429).length, 5); ok('6 simultaneous export requests on a 1-export window: exactly 1 accepted, 5 refused');
  await waitDone(A, burst.find(x => x.status === 202).body.job_id);

  /* persistence across restart */
  const before = (await D('GET', '/api/premium/status')).body.status;
  await stop(A); servers.pop();
  const A2 = await start(18791, { PREMIUM_DAILY_CODES: 'DAILY-TEST-1', PREMIUM_UNLIMITED_CODES: 'UNL-TEST-1,sha256:' + sha(HASHED.toUpperCase()) }); servers.push(A2);
  const after = (await api(A2, T)('GET', '/api/premium/status')).body.status;
  assert.equal(after.state, 'active'); assert.equal(after.expires_at, before.expires_at); assert.equal(after.exports_used, before.exports_used); assert.equal(after.limit_reached, true); ok('activation, expiry and export count survive a server restart');
  r = await api(A2, T)('POST', '/api/jobs', { upload_id: up, plan: PLAN, request_id: rid() }); assert.equal(r.status, 429); ok('the used-up daily export is still used up after the restart');
  await stop(A2); servers.pop();

  /* refund: cancelled queued job gives the export back */
  const C = await start(18792, { PREMIUM_DAILY_CODES: 'DAILY-TEST-1', PREMIUM_DAILY_EXPORTS: '2' }); servers.push(C);
  const bigUp = await upload(C, big), tok = (await api(C)('POST', '/api/premium/activate', { mode: 'daily', code: 'DAILY-TEST-1' })).body.token, CA = api(C, tok);
  const first = await CA('POST', '/api/jobs', { upload_id: bigUp, plan: HEAVY, request_id: rid() }); assert.equal(first.status, 202);
  const second = await CA('POST', '/api/jobs', { upload_id: bigUp, plan: PLAN, request_id: rid() }); assert.equal(second.status, 202); assert.equal(second.body.job.status, 'queued');
  assert.equal((await CA('GET', '/api/premium/status')).body.status.remaining_exports, 0);
  await CA('POST', `/api/jobs/${second.body.job_id}/cancel`);
  assert.equal((await CA('GET', '/api/premium/status')).body.status.remaining_exports, 1); ok('cancelling a queued job gives the export back (0 -> 1 remaining)');
  await CA('POST', `/api/jobs/${first.body.job_id}/cancel`);
  const cancelledRunning = await waitDone(C, first.body.job_id, 15000);
  assert.equal(cancelledRunning.status, 'cancelled', JSON.stringify(cancelledRunning));
  s = await CA('GET', '/api/premium/status'); assert.equal(s.body.status.remaining_exports, 2); assert.equal(s.body.status.exports_used, 0); ok('cancelling a running render also refunds it (nothing counted as exported)');
  await stop(C); servers.pop();

  /* expiry + new window */
  const E = await start(18793, { PREMIUM_DAILY_CODES: 'DAILY-TEST-1', PREMIUM_DAILY_HOURS: '0.0004' }); servers.push(E);
  const eUp = await upload(E, small), eTok = (await api(E)('POST', '/api/premium/activate', { mode: 'daily', code: 'DAILY-TEST-1' })).body.token, EA = api(E, eTok);
  await sleep(1700);
  s = await EA('GET', '/api/premium/status'); assert.equal(s.body.status.state, 'expired');
  r = await EA('POST', '/api/jobs', { upload_id: eUp, plan: PLAN, request_id: rid() }); assert.equal(r.status, 402); assert.equal(r.body.error.code, 'PREMIUM_EXPIRED'); ok('after the window ends: status "expired" and exports are refused (PREMIUM_EXPIRED)');
  r = await EA('POST', '/api/premium/activate', { mode: 'daily', code: 'DAILY-TEST-1' }); assert.equal(r.body.status.state, 'active'); assert.equal(r.body.status.remaining_exports, 1); assert.equal(r.body.already_active, false); ok('entering the Daily code again starts a fresh window with the allowance reset');
  await stop(E); servers.pop();

  /* revocation without restart, via the codes file */
  const cf = path.join(tmp, 'codes.json'); fs.writeFileSync(cf, JSON.stringify({ daily: ['FILE-DAILY-9'], unlimited: [] }));
  const R = await start(18794, { PREMIUM_CODES_FILE: cf }); servers.push(R);
  const rUp = await upload(R, small), rTok = (await api(R)('POST', '/api/premium/activate', { mode: 'daily', code: 'file-daily-9' })).body.token, RA = api(R, rTok);
  assert.equal((await RA('GET', '/api/premium/status')).body.status.state, 'active');
  fs.writeFileSync(cf, JSON.stringify({ daily: [], unlimited: [] })); const t = new Date(Date.now() + 5000); fs.utimesSync(cf, t, t);
  assert.equal((await RA('GET', '/api/premium/status')).body.status.state, 'revoked');
  r = await RA('POST', '/api/jobs', { upload_id: rUp, plan: PLAN, request_id: rid() }); assert.equal(r.status, 402); assert.equal(r.body.error.code, 'PREMIUM_REVOKED'); ok('removing a code from the codes file revokes live sessions immediately (no restart)');
  await stop(R); servers.pop();

  /* premium not required: exports open */
  const O = await start(18795, { PREMIUM_REQUIRED: 'false' }); servers.push(O);
  const oUp = await upload(O, small); r = await api(O)('POST', '/api/jobs', { upload_id: oUp, plan: PLAN }); assert.equal(r.status, 202); assert.equal((await api(O)('GET', '/api/premium/status')).body.status.premium_required, false); ok('PREMIUM_REQUIRED=false leaves exports open and tells the UI so');
  await stop(O); servers.pop();

  /* brute force lockout */
  const L = await start(18796, { PREMIUM_DAILY_CODES: 'DAILY-TEST-1' }); servers.push(L);
  for (let i = 0; i < 6; i++) { r = await api(L)('POST', '/api/premium/activate', { mode: 'daily', code: 'wrong-code-' + i }); assert.equal(r.status, 403); }
  r = await api(L)('POST', '/api/premium/activate', { mode: 'daily', code: 'DAILY-TEST-1' }); assert.equal(r.status, 429); assert.equal(r.body.error.code, 'TOO_MANY_ATTEMPTS'); ok('6 wrong codes lock activation for that IP (even the right code is refused until the window passes)');
  await stop(L); servers.pop();

  console.log(`\nAll ${results.length} premium checks passed.`);
} catch (e) {
  console.error('\nFAILED:', e.stack || e.message); for (const s of servers) console.error(s.log().split('\n').slice(-12).join('\n')); process.exitCode = 1;
} finally { for (const s of servers) s.p.kill(); fs.rmSync(tmp, { recursive: true, force: true }); }

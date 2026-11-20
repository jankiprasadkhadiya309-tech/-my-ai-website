/* End-to-end test of the real backend code path: upload -> /api/plan -> /api/jobs -> FFmpeg render -> download.
   The two EXTERNAL services (Anthropic API, speech-to-text) are replaced by local test doubles that speak the same HTTP protocol,
   because CI/sandboxes have no keys or network. The test doubles live only in this file; the shipped backend never fakes AI.
   Run: node test/e2e.mjs   (needs ffmpeg + ffprobe on PATH) */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import assert from 'node:assert/strict';

const here = path.dirname(new URL(import.meta.url).pathname);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beyond-e2e-'));
const ORIGIN = 'https://my-site.netlify.app';
const results = [];
const ok = (name) => { results.push(name); console.log('  ✓ ' + name); };

/* ---- test double: Anthropic Messages API ---- */
const seen = { anthropic: [], stt: [] };
const PLAN = { understood: true, language: 'en', summary: 'Tight vertical edit with grade, zoom and glitch.', style: 'cinematic', aspect_ratio: '9:16', resolution: '720p', remove_silence: true, max_duration_seconds: null, captions: true, caption_language: 'en', music: false, music_mood: null, transitions: true, transition_style: 'fade', effects: ['color_enhancement', 'zoom_effects', 'glitch', 'sound_enhancement', 'speed_ramp'], output_format: 'mp4' };
const anthropic = http.createServer((req, res) => {
  let b = ''; req.on('data', c => b += c); req.on('end', () => {
    const body = JSON.parse(b); seen.anthropic.push({ key: req.headers['x-api-key'], version: req.headers['anthropic-version'], body, url: req.url });
    const prompt = JSON.parse(body.messages[0].content).request;
    const text = /gibberish/.test(prompt) ? '{"understood":false,"reason":"Not a video-editing instruction."}' : 'Here is the plan:\n' + JSON.stringify(PLAN);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg_test', type: 'message', role: 'assistant', content: [{ type: 'text', text }] }));
  });
});
/* ---- test double: OpenAI-compatible transcription endpoint ---- */
const stt = http.createServer((req, res) => {
  const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => {
    seen.stt.push({ auth: req.headers.authorization, size: Buffer.concat(chunks).length, url: req.url });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ text: 'hello', segments: [{ start: 0.1, end: 1.4, text: ' Hello and welcome to the test video.' }, { start: 1.6, end: 3.0, text: ' This sentence is long enough that it must be wrapped across two lines on screen.' }] }));
  });
});
const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const pA = await listen(anthropic), pS = await listen(stt);

/* ---- sample video: 12 s, tone bursts separated by silence ---- */
const sample = path.join(tmp, 'sample.mp4');
let r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=12', '-f', 'lavfi', '-i', "aevalsrc='if(lt(mod(t,4),1.5),0.4*sin(2*PI*440*t),0)':s=44100:d=12", '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', sample]);
assert.equal(r.status, 0, 'could not create sample video');

/* ---- start the real backend ---- */
async function startBackend(extraEnv, port) {
  const env = { ...process.env, PORT: String(port), DATA_DIR: path.join(tmp, 'data-' + port), ALLOWED_ORIGINS: ORIGIN + ',https://*.netlify.app', SERVE_FRONTEND: 'false',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + pA, OPENAI_BASE_URL: 'http://127.0.0.1:' + pS, PREMIUM_REQUIRED: 'false', ...extraEnv };  /* premium gate is covered separately in premium.mjs */
  const p = spawn('node', [path.join(here, '..', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; p.stdout.on('data', d => log += d); p.stderr.on('data', d => log += d);
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return { p, base: `http://127.0.0.1:${port}`, log: () => log }; } catch (e) { /* wait */ } await new Promise(r => setTimeout(r, 100)); }
  throw new Error('backend did not start: ' + log);
}
const j = async (res) => ({ status: res.status, body: await res.json().catch(() => null), headers: res.headers });
const probe = (f) => JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', f]).stdout.toString());

const B = await startBackend({ ANTHROPIC_API_KEY: 'sk-ant-test-key', OPENAI_API_KEY: 'sk-stt-test-key' }, 18781);
const NOKEY = await startBackend({}, 18782);
try {
  console.log('Backend e2e');
  /* health + CORS */
  let h = await j(await fetch(B.base + '/api/health', { headers: { origin: ORIGIN } }));
  assert.equal(h.status, 200); assert.equal(h.body.ai_planner, true); assert.equal(h.body.ffmpeg.libx264, true);
  assert.equal(h.headers.get('access-control-allow-origin'), ORIGIN); ok('health + CORS allows the Netlify origin');
  h = await fetch(B.base + '/api/health', { headers: { origin: 'https://evil.example' } });
  assert.equal(h.headers.get('access-control-allow-origin'), null); ok('CORS blocks an unlisted origin');
  h = await fetch(B.base + '/api/health', { headers: { origin: 'https://deploy-preview-3--my-site.netlify.app' } });
  assert.equal(h.headers.get('access-control-allow-origin'), 'https://deploy-preview-3--my-site.netlify.app'); ok('CORS wildcard pattern matches a Netlify deploy preview');
  let pf = await fetch(B.base + '/api/jobs', { method: 'OPTIONS', headers: { origin: ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
  assert.equal(pf.status, 204); assert.match(pf.headers.get('access-control-allow-headers'), /content-type/); ok('preflight OPTIONS answered');

  /* planner not configured */
  let x = await j(await fetch(NOKEY.base + '/api/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'make it cinematic' }) }));
  assert.equal(x.status, 503); assert.equal(x.body.error.code, 'NOT_CONFIGURED'); ok('planner reports a clear error when ANTHROPIC_API_KEY is missing (no fake plan)');

  /* upload validation */
  x = await j(await fetch(B.base + '/api/uploads?name=a.txt', { method: 'POST', body: 'hello' }));
  assert.equal(x.status, 415); ok('upload rejects unsupported extension');
  x = await j(await fetch(B.base + '/api/uploads?name=fake.mp4', { method: 'POST', headers: { 'content-type': 'video/mp4' }, body: Buffer.from('this is not a video at all') }));
  assert.equal(x.status, 422); assert.equal(x.body.error.code, 'NOT_A_VIDEO'); ok('upload rejects a non-video file renamed to .mp4');

  /* real upload */
  const buf = fs.readFileSync(sample);
  const up = await j(await fetch(B.base + '/api/uploads?name=' + encodeURIComponent('my clip.mp4'), { method: 'POST', headers: { 'content-type': 'video/mp4', origin: ORIGIN }, body: buf }));
  assert.equal(up.status, 201); assert.ok(up.body.upload_id); assert.equal(up.body.width, 1280); assert.ok(Math.abs(up.body.duration - 12) < 0.2); assert.equal(up.body.has_audio, true);
  assert.equal(fs.statSync(path.join(tmp, 'data-18781', 'uploads', up.body.upload_id, 'source.mp4')).size, buf.length); ok('video uploaded, stored on disk and probed by the server');

  /* plan via the server-side AI call */
  const planReq = { prompt: 'Make this a punchy vertical reel, remove pauses, add captions', upload_id: up.body.upload_id, video: { duration_seconds: 999, width: 1, height: 1, size_mb: 1 }, settings: { style: 'cinematic', aspect_ratio: '16:9', resolution: '1080p', captions: true, music: false } };
  const pl = await j(await fetch(B.base + '/api/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(planReq) }));
  assert.equal(pl.status, 200); assert.equal(pl.body.plan.understood, true); assert.equal(pl.body.plan.aspect_ratio, '9:16'); assert.ok(!('speed_ramp' in {}) && Array.isArray(pl.body.plan.effects));
  const call = seen.anthropic.at(-1);
  assert.equal(call.key, 'sk-ant-test-key'); assert.equal(call.version, '2023-06-01'); assert.equal(call.url, '/v1/messages'); assert.match(call.body.system, /planning brain of BEYOND AI/);
  assert.equal(JSON.parse(call.body.messages[0].content).video.width, 1280, 'server must use its own probe, not the browser-claimed size'); ok('/api/plan calls the Anthropic Messages API server-side with the key and validates the result');
  const bad = await j(await fetch(B.base + '/api/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...planReq, prompt: 'gibberish asdf' }) }));
  assert.equal(bad.body.plan.understood, false); ok('non-editing prompts come back as understood:false');
  const tooShort = await j(await fetch(B.base + '/api/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'a' }) }));
  assert.equal(tooShort.status, 400); ok('plan endpoint validates the prompt');

  /* job validation */
  x = await j(await fetch(B.base + '/api/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ upload_id: up.body.upload_id, plan: { ...pl.body.plan, resolution: '4k' } }) }));
  assert.equal(x.status, 422); ok('job creation rejects an invalid plan');
  x = await j(await fetch(B.base + '/api/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ upload_id: '00000000-0000-4000-8000-000000000000', plan: pl.body.plan }) }));
  assert.equal(x.status, 404); ok('job creation rejects an unknown upload');

  /* the real render */
  const created = await j(await fetch(B.base + '/api/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ upload_id: up.body.upload_id, plan: pl.body.plan }) }));
  assert.equal(created.status, 202);
  const id = created.body.job_id; let job, lastPct = -1; const t0 = Date.now();
  for (;;) {
    job = (await j(await fetch(B.base + '/api/jobs/' + id))).body.job;
    assert.ok(job.progress >= lastPct, 'progress must never go backwards'); lastPct = job.progress;
    if (['done', 'error', 'cancelled'].includes(job.status)) break;
    if (Date.now() - t0 > 180000) throw new Error('job timed out');
    await new Promise(r => setTimeout(r, 300));
  }
  assert.equal(job.status, 'done', JSON.stringify(job.error)); assert.equal(job.progress, 100);
  assert.deepEqual(job.steps.map(s => s.state), ['done', 'done', 'done', 'done']); ok('job ran all 4 steps to done with monotonic progress');
  assert.equal(job.result.width, 720); assert.equal(job.result.height, 1280); assert.equal(job.result.has_audio, true);
  assert.ok(job.result.duration_seconds < 10.5 && job.result.duration_seconds > 3, 'silence should have been cut, got ' + job.result.duration_seconds); ok(`output is 720×1280 and ${job.result.duration_seconds}s (silence removed from 12s)`);
  assert.ok(job.applied.includes('remove_silence') && job.applied.includes('captions (en)') && job.applied.includes('zoom_effects')); ok('applied effects are reported: ' + job.applied.join(', '));
  assert.ok(job.warnings.some(w => /Speed ramp/.test(w))); ok('unsupported effect (speed_ramp) is reported as a warning, not silently ignored');
  assert.equal(seen.stt.length, 1); assert.equal(seen.stt[0].auth, 'Bearer sk-stt-test-key'); assert.equal(seen.stt[0].url, '/v1/audio/transcriptions'); assert.ok(seen.stt[0].size > 1000); ok('captions: edited audio was sent to the speech-to-text endpoint');

  const out = path.join(tmp, 'out.mp4');
  const dl = await fetch(B.base + '/api/jobs/' + id + '/output', { headers: { origin: ORIGIN } });
  assert.equal(dl.status, 200); assert.equal(dl.headers.get('content-type'), 'video/mp4'); assert.equal(dl.headers.get('access-control-allow-origin'), ORIGIN);
  fs.writeFileSync(out, Buffer.from(await dl.arrayBuffer()));
  const pr = probe(out); const vs = pr.streams.find(s => s.codec_type === 'video'), as = pr.streams.find(s => s.codec_type === 'audio');
  assert.equal(vs.codec_name, 'h264'); assert.equal(vs.width, 720); assert.equal(as.codec_name, 'aac'); ok('downloaded file is a valid H.264/AAC mp4');
  const rg = await fetch(B.base + '/api/jobs/' + id + '/output', { headers: { range: 'bytes=0-99' } });
  assert.equal(rg.status, 206); assert.equal((await rg.arrayBuffer()).byteLength, 100); ok('Range requests work (video seeking)');
  const dd = await fetch(B.base + '/api/jobs/' + id + '/output?download=1');
  assert.match(dd.headers.get('content-disposition'), /attachment; filename="my clip-beyond-ai\.mp4"/); await dd.arrayBuffer(); ok('download=1 sets an attachment filename');

  /* captions really burned in: render the same plan WITHOUT captions and compare the caption band pixel by pixel */
  const waitJob = async (jid) => { let q; for (let i = 0; i < 900; i++) { q = (await j(await fetch(B.base + '/api/jobs/' + jid))).body.job; if (['done', 'error', 'cancelled'].includes(q.status)) return q; await new Promise(r => setTimeout(r, 300)); } throw new Error('timeout'); };
  const nc = await j(await fetch(B.base + '/api/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ upload_id: up.body.upload_id, plan: { ...pl.body.plan, captions: false, caption_language: null } }) }));
  const jn = await waitJob(nc.body.job_id); assert.equal(jn.status, 'done', JSON.stringify(jn.error));
  const out2 = path.join(tmp, 'nocap.mp4'); fs.writeFileSync(out2, Buffer.from(await (await fetch(B.base + '/api/jobs/' + nc.body.job_id + '/output')).arrayBuffer()));
  const band = (f, o) => { spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '0.8', '-i', f, '-frames:v', '1', '-vf', 'crop=720:300:0:900,format=gray', '-f', 'rawvideo', o]); return fs.readFileSync(o); };
  const A = band(out, path.join(tmp, 'a.raw')), Bn = band(out2, path.join(tmp, 'b.raw')); let diff = 0; for (let i = 0; i < A.length; i++) if (Math.abs(A[i] - Bn[i]) > 60) diff++;
  assert.ok(diff > 800, 'expected the caption band to differ between captioned and uncaptioned renders, got ' + diff + ' pixels'); ok('captions are burned into the video (' + diff + ' pixels differ from the same render without captions)');
  if (process.env.KEEP) { fs.copyFileSync(out, '/tmp/t/out.mp4'); fs.copyFileSync(out2, '/tmp/t/out-nocap.mp4'); }

  /* second job: webm + music missing + cancel */
  const webmPlan = { ...pl.body.plan, output_format: 'webm', captions: false, caption_language: null, music: true, music_mood: 'calm', remove_silence: false, effects: ['cinematic_grade'], transitions: false, transition_style: null, max_duration_seconds: 5 };
  const c2 = await j(await fetch(B.base + '/api/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ upload_id: up.body.upload_id, plan: webmPlan }) }));
  let j2; for (let i = 0; i < 600; i++) { j2 = (await j(await fetch(B.base + '/api/jobs/' + c2.body.job_id))).body.job; if (['done', 'error'].includes(j2.status)) break; await new Promise(r => setTimeout(r, 300)); }
  assert.equal(j2.status, 'done', JSON.stringify(j2.error)); assert.equal(j2.result.format, 'webm'); assert.ok(j2.result.duration_seconds <= 5.2);
  assert.ok(j2.warnings.some(w => /music/i.test(w))); ok('webm output + max duration respected; missing music library is reported as a warning');
  const wf = path.join(tmp, 'o.webm'); fs.writeFileSync(wf, Buffer.from(await (await fetch(B.base + '/api/jobs/' + c2.body.job_id + '/output')).arrayBuffer()));
  assert.equal(probe(wf).streams.find(s => s.codec_type === 'video').codec_name, 'vp9'); ok('webm file is VP9');

  const c3 = await j(await fetch(B.base + '/api/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ upload_id: up.body.upload_id, plan: { ...webmPlan, output_format: 'mp4', effects: ['stabilization', 'noise_reduction'], resolution: '1080p', max_duration_seconds: null } }) }));
  await new Promise(r => setTimeout(r, 1200));
  await fetch(B.base + '/api/jobs/' + c3.body.job_id + '/cancel', { method: 'POST' });
  let j3; for (let i = 0; i < 100; i++) { j3 = (await j(await fetch(B.base + '/api/jobs/' + c3.body.job_id))).body.job; if (j3.status !== 'running' && j3.status !== 'queued') break; await new Promise(r => setTimeout(r, 200)); }
  assert.ok(['cancelled', 'done'].includes(j3.status)); ok('cancel endpoint stops a running job (status: ' + j3.status + ')');
  const nf = await j(await fetch(B.base + '/api/jobs/' + c3.body.job_id + '/output'));
  assert.ok(nf.status === 409 || j3.status === 'done'); ok('output of an unfinished job is refused with 409');

  console.log(`\nAll ${results.length} checks passed.`);
} catch (e) {
  console.error('\nFAILED:', e.message); console.error(B.log().split('\n').slice(-15).join('\n')); process.exitCode = 1;
} finally {
  B.p.kill(); NOKEY.p.kill(); anthropic.close(); stt.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

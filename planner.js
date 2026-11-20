'use strict';
/* planner.js: the AI editing planner. Calls the Anthropic Messages API from the server (the key never reaches the browser),
   then validates the result with the same schema the frontend uses. */
const { PLAN_SYSTEM_PROMPT, PLAN_ENUMS, checkPrompt, extractJson, validatePlan } = require('./planSchema');

const err = (code, message, status, issues) => Object.assign(new Error(message), { code, status, issues });

function cleanInput(input, probed) {
  if (!input || typeof input !== 'object') throw err('BAD_REQUEST', 'Request body must be a JSON object.', 400);
  const bad = checkPrompt(input.prompt);
  if (bad) throw err('BAD_PROMPT', bad, 400);
  const s = input.settings && typeof input.settings === 'object' ? input.settings : {};
  const E = PLAN_ENUMS;
  const settings = {
    style: E.style.includes(s.style) ? s.style : 'cinematic',
    aspect_ratio: E.aspect_ratio.includes(s.aspect_ratio) ? s.aspect_ratio : '16:9',
    resolution: E.resolution.includes(s.resolution) ? s.resolution : '1080p',
    captions: s.captions === true,
    music: s.music === true
  };
  const v = input.video && typeof input.video === 'object' ? input.video : {};
  const num = x => (Number.isFinite(+x) ? +x : 0);
  /* Prefer what the server measured on the uploaded file over what the browser claimed. */
  const video = probed
    ? { duration_seconds: Math.round(probed.duration), width: probed.width, height: probed.height, size_mb: +(probed.sizeBytes / 1048576).toFixed(1) }
    : { duration_seconds: num(v.duration_seconds), width: num(v.width), height: num(v.height), size_mb: num(v.size_mb) };
  return { request: input.prompt.trim(), video, current_settings: settings };
}

async function callAnthropic(cfg, messages, signal) {
  const a = cfg.anthropic;
  const sig = AbortSignal.any([signal, AbortSignal.timeout(cfg.plannerTimeoutMs)]);
  let r;
  try {
    r = await fetch(a.baseUrl.replace(/\/$/, '') + '/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': a.key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: a.model, max_tokens: 1024, system: PLAN_SYSTEM_PROMPT, messages }),
      signal: sig
    });
  } catch (e) {
    if (signal.aborted) throw err('CANCELLED', 'Cancelled.', 499);
    if (e && e.name === 'TimeoutError') throw err('TIMEOUT', 'The AI took too long to respond. Please retry.', 504);
    throw err('AI_UNREACHABLE', 'The server could not reach the Anthropic API: ' + (e.message || e), 502);
  }
  const d = await r.json().catch(() => null);
  if (!r.ok) {
    const m = d && d.error && d.error.message ? d.error.message : 'HTTP ' + r.status;
    if (r.status === 401 || r.status === 403) throw err('AI_AUTH', 'The Anthropic API key configured on the server was rejected. (' + m + ')', 502);
    if (r.status === 429) throw err('RATE_LIMITED', 'The AI is busy right now. Wait a moment and retry.', 429);
    throw err('AI_UPSTREAM', 'The Anthropic API returned an error: ' + m, 502);
  }
  return (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
}

async function createPlan(input, { cfg, signal, probed }) {
  if (!cfg.anthropic.key) throw err('NOT_CONFIGURED', 'The AI planner is not configured on the server: set ANTHROPIC_API_KEY.', 503);
  const body = cleanInput(input, probed);
  const messages = [{ role: 'user', content: JSON.stringify(body) }];
  let text = await callAnthropic(cfg, messages, signal), issues = ['The reply did not contain a JSON object.'];
  for (let attempt = 0; attempt < 2; attempt++) {
    const obj = extractJson(text);
    if (obj) {
      const v = validatePlan(obj);
      if (v.ok) return v.plan;
      issues = v.errors;
    }
    if (attempt === 1) break;
    messages.push({ role: 'assistant', content: text || '{}' }, { role: 'user', content: 'That JSON failed validation: ' + issues.join('; ') + '. Return ONLY the corrected JSON object.' });
    text = await callAnthropic(cfg, messages, signal);
  }
  throw err('INVALID_RESPONSE', 'The AI returned a plan that failed validation, so it was not used.', 502, issues);
}

module.exports = { createPlan, cleanInput };

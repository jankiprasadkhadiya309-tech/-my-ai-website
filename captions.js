'use strict';
/* captions.js: real speech-to-text via an OpenAI-compatible /v1/audio/transcriptions endpoint, then SRT generation. */
const fs = require('node:fs');

function sttConfigured(cfg) { return !!(cfg.stt && cfg.stt.key); }

/* Returns [{start,end,text}] */
async function transcribe(audioPath, { cfg, language, signal }) {
  const fd = new FormData();
  fd.append('file', await fs.openAsBlob(audioPath, { type: 'audio/mpeg' }), 'audio.mp3');
  fd.append('model', cfg.stt.model);
  fd.append('response_format', 'verbose_json');
  fd.append('timestamp_granularities[]', 'segment');
  if (language === 'en') fd.append('language', 'en');
  if (language === 'hi') fd.append('language', 'hi');
  if (language === 'hinglish') { fd.append('language', 'hi'); fd.append('prompt', 'Yeh ek Hinglish video hai. Hindi aur English dono Roman script mein likhe jaate hain, jaise: aaj hum ek naya video dekhenge.'); }
  const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(180000)]) : AbortSignal.timeout(180000);
  let r;
  try {
    r = await fetch(cfg.stt.baseUrl.replace(/\/$/, '') + '/v1/audio/transcriptions', { method: 'POST', headers: { authorization: 'Bearer ' + cfg.stt.key }, body: fd, signal: sig });
  } catch (e) {
    if (signal && signal.aborted) throw Object.assign(new Error('Cancelled'), { code: 'CANCELLED' });
    throw Object.assign(new Error('Could not reach the speech-to-text service: ' + (e.message || e)), { code: 'STT_UNREACHABLE' });
  }
  const d = await r.json().catch(() => null);
  if (!r.ok) throw Object.assign(new Error('Speech-to-text failed (' + r.status + ')' + (d && d.error && d.error.message ? ': ' + d.error.message : '')), { code: 'STT_FAILED' });
  const segs = (d && d.segments) || [];
  return segs.map(s => ({ start: +s.start, end: +s.end, text: String(s.text || '').trim() })).filter(s => s.text && s.end > s.start);
}

const len = s => [...s].length;
function wrapLines(text, maxChars) {
  const words = text.split(/\s+/).filter(Boolean), lines = []; let cur = '';
  for (const w of words) {
    if (cur && len(cur) + 1 + len(w) > maxChars) { lines.push(cur); cur = w; } else cur = cur ? cur + ' ' + w : w;
  }
  if (cur) lines.push(cur);
  return lines;
}
const ts = t => { t = Math.max(0, t); const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = Math.floor(t % 60), ms = Math.round((t % 1) * 1000); const p = (n, k = 2) => String(n).padStart(k, '0'); return `${p(h)}:${p(m)}:${p(s)},${p(ms >= 1000 ? 999 : ms, 3)}`; };

/* Splits long segments into short on-screen chunks (max 2 lines) with time shared in proportion to text length. */
function toSrt(segments, { maxChars = 32, maxLines = 2, totalSec = Infinity } = {}) {
  const cues = [];
  for (const seg of segments) {
    const lines = wrapLines(seg.text, maxChars), groups = [];
    for (let i = 0; i < lines.length; i += maxLines) groups.push(lines.slice(i, i + maxLines));
    const total = groups.reduce((n, g) => n + len(g.join(' ')), 0) || 1;
    let t = seg.start;
    for (const g of groups) {
      const d = (seg.end - seg.start) * (len(g.join(' ')) / total);
      cues.push({ start: t, end: Math.min(t + d, totalSec), text: g.join('\n') });
      t += d;
    }
  }
  return cues.filter(c => c.end > c.start).map((c, i) => `${i + 1}\n${ts(c.start)} --> ${ts(c.end)}\n${c.text}\n`).join('\n');
}

module.exports = { sttConfigured, transcribe, toSrt, wrapLines };

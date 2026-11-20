'use strict';
/* media.js: thin, dependency-free wrappers around ffprobe / ffmpeg. No shell is ever used; arguments are passed as arrays. */
const { spawn } = require('node:child_process');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

function collect(cmd, args, { cwd, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    let out = '', err = '';
    const c = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const t = setTimeout(() => { c.kill('SIGKILL'); }, timeoutMs);
    c.stdout.on('data', d => { out += d; if (out.length > 5e6) out = out.slice(-5e6); });
    c.stderr.on('data', d => { err += d; if (err.length > 5e6) err = err.slice(-5e6); });
    c.on('error', e => { clearTimeout(t); reject(e); });
    c.on('close', code => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

/* Returns {duration,width,height,fps,hasAudio,hasVideo,videoCodec,sizeBytes}. Throws if ffprobe cannot read the file. */
async function probe(file) {
  const r = await collect(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  if (r.code !== 0) throw new Error('ffprobe could not read this file');
  let j; try { j = JSON.parse(r.out); } catch (e) { throw new Error('ffprobe returned invalid output'); }
  const streams = j.streams || [];
  const v = streams.find(s => s.codec_type === 'video' && s.disposition && s.disposition.attached_pic !== 1) || streams.find(s => s.codec_type === 'video');
  const a = streams.find(s => s.codec_type === 'audio');
  let w = v ? +v.width || 0 : 0, h = v ? +v.height || 0 : 0;
  if (v) {
    let rot = 0;
    if (v.tags && v.tags.rotate) rot = +v.tags.rotate;
    for (const sd of v.side_data_list || []) if (sd.rotation !== undefined) rot = +sd.rotation;
    if (Math.abs(rot) % 180 === 90) [w, h] = [h, w]; /* ffmpeg autorotates, so effective size is swapped */
  }
  let fps = 0;
  if (v && v.avg_frame_rate && v.avg_frame_rate.includes('/')) { const [n, d] = v.avg_frame_rate.split('/').map(Number); fps = d ? n / d : 0; }
  const dur = parseFloat((j.format && j.format.duration) || (v && v.duration) || '0') || 0;
  return { duration: dur, width: w, height: h, fps, hasVideo: !!v, hasAudio: !!a, videoCodec: v ? v.codec_name : null, sizeBytes: +((j.format && j.format.size) || 0) };
}

/* Runs ffmpeg with machine-readable progress. ctl: {child, cancelled}. onProgress(fraction 0..1). */
function runFfmpeg(args, { cwd, totalSec, onProgress, ctl } = {}) {
  return new Promise((resolve, reject) => {
    if (ctl && ctl.cancelled) {
      return reject(Object.assign(new Error('Cancelled'), { code: 'CANCELLED' }));
    }
    const full = ['-hide_banner', '-nostdin', '-y', '-progress', 'pipe:1', '-nostats', ...args];
    const c = spawn(FFMPEG, full, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    if (ctl) ctl.child = c;
    let tail = '', buf = '', settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (ctl && ctl.child === c) ctl.child = null;
      fn(value);
    };
    c.stderr.on('data', d => { tail = (tail + d).slice(-4000); });
    c.stdout.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
        if (m && totalSec > 0 && onProgress) onProgress(Math.max(0, Math.min(1, Number(m[1]) / 1e6 / totalSec)));
      }
    });
    c.on('error', e => finish(reject, Object.assign(new Error('Could not start ffmpeg: ' + e.message), { code: 'FFMPEG_MISSING' })));
    c.on('close', (code, sig) => {
      if (ctl && ctl.cancelled) return finish(reject, Object.assign(new Error('Cancelled'), { code: 'CANCELLED' }));
      if (code === 0) return finish(resolve);
      finish(reject, Object.assign(new Error('ffmpeg exited with ' + (sig || code)), { code: 'FFMPEG_FAILED', detail: tail.trim().split('\n').slice(-6).join('\n') }));
    });
  });
}

/* Detects silent stretches in the audio track. Returns [{start,end}] in seconds. */
async function detectSilences(file, duration, { noiseDb = -35, minSec = 0.6, ctl } = {}) {
  const r = await new Promise((resolve, reject) => {
    const c = spawn(FFMPEG, ['-hide_banner', '-nostdin', '-i', file, '-vn', '-af', `silencedetect=noise=${noiseDb}dB:d=${minSec}`, '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] });
    if (ctl) ctl.child = c;
    let err = '';
    c.stderr.on('data', d => { err += d; });
    c.on('error', reject);
    c.on('close', code => { if (ctl) ctl.child = null; code === 0 ? resolve(err) : (ctl && ctl.cancelled) ? reject(Object.assign(new Error('Cancelled'), { code: 'CANCELLED' })) : reject(Object.assign(new Error('Silence analysis failed'), { code: 'FFMPEG_FAILED', detail: err.slice(-600) })); });
  });
  const out = []; let start = null;
  for (const line of r.split('\n')) {
    let m;
    if ((m = /silence_start:\s*(-?[\d.]+)/.exec(line))) start = Math.max(0, parseFloat(m[1]));
    else if ((m = /silence_end:\s*(-?[\d.]+)/.exec(line)) && start !== null) { out.push({ start, end: Math.min(duration, parseFloat(m[1])) }); start = null; }
  }
  if (start !== null && duration > start) out.push({ start, end: duration });
  return out;
}

/* Turns silences into the list of segments to KEEP. Leaves `pad` seconds of breathing room around speech. */
function keepSegments(duration, silences, { pad = 0.12, minKeep = 0.25, maxCuts = 300 } = {}) {
  let cuts = silences.map(s => ({ start: s.start + pad, end: s.end - pad })).filter(c => c.end - c.start >= 0.15);
  if (cuts.length > maxCuts) cuts = cuts.sort((a, b) => (b.end - b.start) - (a.end - a.start)).slice(0, maxCuts);
  cuts.sort((a, b) => a.start - b.start);
  const keep = []; let pos = 0;
  for (const c of cuts) { if (c.start > pos) keep.push({ start: pos, end: c.start }); pos = Math.max(pos, c.end); }
  if (pos < duration) keep.push({ start: pos, end: duration });
  return keep.filter(k => k.end - k.start >= minKeep);
}

async function capabilities() {
  const cap = { ffmpeg: false, ffprobe: false, libx264: false, vp9: false, subtitles: false };
  try {
    const v = await collect(FFMPEG, ['-hide_banner', '-version']); cap.ffmpeg = v.code === 0;
    const p = await collect(FFPROBE, ['-hide_banner', '-version']); cap.ffprobe = p.code === 0;
    if (cap.ffmpeg) {
      const enc = (await collect(FFMPEG, ['-hide_banner', '-encoders'])).out;
      const fil = (await collect(FFMPEG, ['-hide_banner', '-filters'])).out;
      cap.libx264 = /libx264/.test(enc); cap.vp9 = /libvpx-vp9/.test(enc); cap.subtitles = /\ssubtitles\s/.test(fil);
    }
  } catch (e) { /* leave false */ }
  return cap;
}

module.exports = { probe, runFfmpeg, detectSilences, keepSegments, capabilities, collect };

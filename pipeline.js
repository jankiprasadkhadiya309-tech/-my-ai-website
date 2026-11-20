'use strict';
/* pipeline.js: executes a validated editing plan with FFmpeg. Four steps, matching the four stages shown in the UI:
   0 analysis (probe + silence detection) -> 1 edit pass (cuts, reframe, effects) -> 2 captions/music prep -> 3 final render. */
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const media = require('./media');
const captions = require('./captions');

const STEP_LABELS = ['Upload and analysis', 'Applying edit instructions', 'Captions and audio', 'Rendering final video'];
const MUSIC_EXT = /\.(mp3|m4a|wav|ogg|aac|flac)$/i;
const UNSUPPORTED = {
  speed_ramp: 'Speed ramp is not supported by the processing engine yet, so it was skipped.',
  text_overlays: 'Text overlays need the on-screen text, which the plan does not contain, so they were skipped.',
  highlight_detection: 'Highlight detection is not supported by the processing engine yet, so it was skipped.'
};

function newJob(id, uploadId, plan) {
  return {
    id, upload_id: uploadId, plan, status: 'queued', progress: 0,
    steps: STEP_LABELS.map((label, i) => ({ key: i, label, state: 'pending', note: '' })),
    warnings: [], applied: [], error: null, result: null,
    created_at: Date.now(), updated_at: Date.now()
  };
}

function targetSize(aspect, res) {
  const long = res === '1080p' ? 1920 : 1280, short = res === '1080p' ? 1080 : 720;
  return aspect === '9:16' ? [short, long] : aspect === '16:9' ? [long, short] : [short, short];
}
const f3 = n => (+n).toFixed(3);
const fmtDur = s => { s = Math.round(s); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

function pickMusic(dir, mood) {
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => MUSIC_EXT.test(f)).sort(); } catch (e) { /* no dir */ }
  if (!files.length) return null;
  const m = (mood || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2);
  const hit = files.find(f => m.some(w => f.toLowerCase().includes(w)));
  return path.join(dir, hit || files[0]);
}

async function runJob(job, ctx) {
  const { cfg, dir, source, ctl, save } = ctx;
  const plan = job.plan;
  const step = (i, state, note) => { const s = job.steps[i]; s.state = state; if (note !== undefined) s.note = note; job.updated_at = Date.now(); save(); };
  const progress = p => { job.progress = Math.max(job.progress, Math.round(Math.min(100, p) * 10) / 10); job.updated_at = Date.now(); };
  const warn = m => { if (!job.warnings.includes(m)) job.warnings.push(m); };
  const applied = job.applied;
  let current = 0;
  const fail = (code, message, detail) => Object.assign(new Error(message), { code, detail });
  const abs = f => path.join(dir, f);
  const checkCancelled = () => { if (ctl && ctl.cancelled) throw Object.assign(new Error('Cancelled'), { code: 'CANCELLED' }); };

  try {
    checkCancelled();
    job.status = 'running'; save();

    /* ---- 0. analysis ---- */
    current = 0; step(0, 'running', 'Reading the uploaded video');
    const src = await media.probe(source);
    checkCancelled();
    if (!src.hasVideo || !(src.duration > 0)) throw fail('NOT_A_VIDEO', 'The uploaded file has no readable video stream.');
    progress(2);
    let keep = null, total = src.duration, note0 = fmtDur(src.duration) + ' · ' + src.width + '×' + src.height;
    if (plan.remove_silence) {
      if (!src.hasAudio) warn('Remove silence was skipped: the video has no audio track.');
      else {
        step(0, 'running', 'Detecting silent pauses');
        const sil = await media.detectSilences(source, src.duration, { ctl });
        checkCancelled();
        const segs = media.keepSegments(src.duration, sil);
        const kept = segs.reduce((n, s) => n + s.end - s.start, 0);
        if (!sil.length || !segs.length) warn(sil.length ? 'Remove silence was skipped: the video is almost entirely silent.' : 'No silent pauses long enough to remove were found.');
        else if (src.duration - kept < 0.3) warn('No silent pauses long enough to remove were found.');
        else { keep = segs; total = kept; applied.push('remove_silence'); note0 += ' · ' + (src.duration - kept).toFixed(1) + ' s of silence marked for removal'; }
      }
    }
    step(0, 'done', note0); progress(6);

    /* ---- 1. edit pass ---- */
    current = 1; step(1, 'running', 'Cutting, reframing and applying effects');
    const fx = new Set(plan.effects);
    if (!fx.has('color_enhancement') && !fx.has('cinematic_grade')) {
      if (plan.style === 'cinematic') { fx.add('cinematic_grade'); applied.push('style:cinematic → cinematic_grade'); }
      else if (plan.style === 'gaming' || plan.style === 'vlog') { fx.add('color_enhancement'); applied.push('style:' + plan.style + ' → color_enhancement'); }
    }
    for (const k of Object.keys(UNSUPPORTED)) if (fx.has(k)) warn(UNSUPPORTED[k]);
    const [W, H] = targetSize(plan.aspect_ratio, plan.resolution);
    const needCrop = Math.abs((src.width / src.height) / (W / H) - 1) >= 0.02;
    if (fx.has('auto_reframe') && needCrop) warn('Auto reframe uses a centered crop; subject tracking is not available.');
    const slow = fx.has('slow_motion');

    const v = [];
    if (keep) {
      const fps = src.fps >= 10 && src.fps <= 120 ? Math.round(src.fps * 1000) / 1000 : 30;
      v.push(`fps=${fps}`, `select='${keep.map(k => `between(t,${f3(k.start)},${f3(k.end)})`).join('+')}'`, 'setpts=N/FRAME_RATE/TB');
    }
    if (fx.has('stabilization')) v.push('deshake');
    if (fx.has('noise_reduction')) v.push('hqdn3d=3:2:5:4');
    v.push(needCrop ? `scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H}` : `scale=${W}:${H}:flags=lanczos`, 'setsar=1');
    if (slow) v.push('setpts=2.0*PTS');
    if (fx.has('color_enhancement')) v.push('eq=contrast=1.06:saturation=1.18:brightness=0.01', 'unsharp=5:5:0.5:5:5:0.0');
    if (fx.has('cinematic_grade')) v.push('eq=contrast=1.08:saturation=0.92:gamma=0.98', 'colorbalance=rs=0.04:bs=-0.02:rm=0.02:bm=0.03:rh=0.06:bh=-0.05', 'curves=preset=medium_contrast', 'vignette=angle=PI/5');
    if (fx.has('zoom_effects')) v.push(`scale=w='ceil(${W}*(1+0.06*abs(sin(t*0.9)))/2)*2':h='ceil(${H}*(1+0.06*abs(sin(t*0.9)))/2)*2':eval=frame`, `crop=${W}:${H}`);
    if (fx.has('glitch')) v.push(`rgbashift=rh=6:bh=-6:enable='lt(mod(t,3.5),0.18)'`, `noise=alls=18:allf=t:enable='lt(mod(t,3.5),0.18)'`);
    v.push('format=yuv420p');
    for (const k of ['color_enhancement', 'cinematic_grade', 'stabilization', 'noise_reduction', 'zoom_effects', 'glitch', 'slow_motion', 'sound_enhancement', 'auto_reframe']) if (fx.has(k) && !(k === 'sound_enhancement' && !src.hasAudio) && !(k === 'auto_reframe' && !needCrop)) applied.push(k);

    const a = [];
    if (src.hasAudio) {
      if (keep) a.push(`aselect='${keep.map(k => `between(t,${f3(k.start)},${f3(k.end)})`).join('+')}'`, 'asetpts=N/SR/TB');
      if (fx.has('sound_enhancement')) a.push('highpass=f=80', 'afftdn=nf=-28', 'loudnorm=I=-16:TP=-1.5:LRA=11');
      if (slow) a.push('atempo=0.5');
      a.push('aresample=48000', 'aformat=channel_layouts=stereo');
    } else if (fx.has('sound_enhancement')) warn('Sound enhancement was skipped: the video has no audio track.');

    const graph = ['[0:v]' + v.join(',') + '[vout]'];
    if (src.hasAudio) graph.push('[0:a]' + a.join(',') + '[aout]');
    await fsp.writeFile(abs('pass1.fgraph'), graph.join(';\n'));

    const limit = plan.max_duration_seconds && plan.max_duration_seconds < total * (slow ? 2 : 1) ? plan.max_duration_seconds : null;
    if (limit) applied.push('max_duration ' + limit + ' s');
    const expected = limit || total * (slow ? 2 : 1);
    checkCancelled();
    await media.runFfmpeg(['-i', source, '-filter_complex_script', 'pass1.fgraph', '-map', '[vout]', ...(src.hasAudio ? ['-map', '[aout]'] : []),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-pix_fmt', 'yuv420p', ...(src.hasAudio ? ['-c:a', 'aac', '-b:a', '192k'] : []),
      '-movflags', '+faststart', ...(limit ? ['-t', String(limit)] : []), 'edit.mp4'],
    { cwd: dir, totalSec: expected, ctl, onProgress: p => progress(6 + p * 39) });
    checkCancelled();
    const ed = await media.probe(abs('edit.mp4'));
    checkCancelled();
    if (!(ed.duration > 0)) throw fail('EMPTY_OUTPUT', 'The edit pass produced an empty video.');
    step(1, 'done', W + '×' + H + ' · ' + fmtDur(ed.duration)); progress(45);

    /* ---- 2. captions + music prep ---- */
    current = 2; step(2, 'running', 'Preparing captions and audio');
    let srt = false, music = null;
    if (plan.captions) {
      if (!ed.hasAudio) warn('Captions were skipped: the video has no audio to transcribe.');
      else if (!captions.sttConfigured(cfg)) warn('Captions were skipped: speech-to-text is not configured on the server (set OPENAI_API_KEY).');
      else if (!ctx.caps.subtitles) warn('Captions were skipped: this FFmpeg build has no subtitles filter (libass).');
      else {
        try {
          step(2, 'running', 'Transcribing speech');
          checkCancelled();
          await media.runFfmpeg(['-i', 'edit.mp4', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '48k', 'audio.mp3'], { cwd: dir, ctl });
          progress(50);
          if ((await fsp.stat(abs('audio.mp3'))).size > 24 * 1048576) warn('Captions were skipped: the edited audio is too long for one transcription request (about 65 minutes maximum).');
          else {
            checkCancelled();
            const segs = await captions.transcribe(abs('audio.mp3'), { cfg, language: plan.caption_language, signal: ctx.signal });
            checkCancelled();
            if (!segs.length) warn('No speech was detected, so no captions were added.');
            else { await fsp.writeFile(abs('captions.srt'), captions.toSrt(segs, { maxChars: plan.aspect_ratio === '16:9' ? 42 : 28, totalSec: ed.duration })); srt = true; applied.push('captions (' + plan.caption_language + ')'); }
          }
        } catch (e) {
          if (e.code === 'CANCELLED') throw e;
          warn('Captions were skipped: ' + (e.message || 'transcription failed') + '.');
        }
      }
    }
    if (plan.music) {
      music = pickMusic(cfg.musicDir, plan.music_mood);
      if (!music) warn('Background music was skipped: no music files are available in the server’s music library (MUSIC_DIR).');
      else applied.push('music: ' + path.basename(music));
    }
    const fades = plan.transitions && ed.duration > 2;
    if (plan.transitions) { if (fades) applied.push('transitions (fade in/out)'); warn('Transitions: only a fade in and fade out at the start and end were applied; scene-to-scene transitions are not supported yet.'); }
    step(2, 'done', [srt ? 'Captions added' : plan.captions ? 'Captions skipped' : '', music ? 'music mixed' : plan.music ? 'music skipped' : ''].filter(Boolean).join(' · ') || 'Nothing to add'); progress(62);

    /* ---- 3. final render ---- */
    current = 3; step(3, 'running', 'Rendering ' + plan.output_format.toUpperCase());
    const fmt = plan.output_format, out = 'final.' + fmt;
    if (!srt && !music && !fades && fmt === 'mp4') await fsp.rename(abs('edit.mp4'), abs(out));
    else {
      const vf = [];
      if (srt) vf.push(`subtitles=captions.srt:force_style='FontName=Noto Sans,FontSize=14,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=0,Alignment=2,MarginV=26'`);
      if (fades) vf.push('fade=t=in:st=0:d=0.4', `fade=t=out:st=${(ed.duration - 0.5).toFixed(2)}:d=0.4`);
      const g = [];
      if (vf.length) g.push('[0:v]' + vf.join(',') + ',format=yuv420p[vout]');
      const af = fades ? `afade=t=in:d=0.4,afade=t=out:st=${(ed.duration - 0.5).toFixed(2)}:d=0.5` : 'anull';
      if (ed.hasAudio && music) g.push(`[0:a]${af}[a0]`, `[1:a]volume=0.14,afade=t=in:d=1,afade=t=out:st=${Math.max(0, ed.duration - 1.5).toFixed(2)}:d=1.5[m]`, '[a0][m]amix=inputs=2:duration=first:normalize=0[aout]');
      else if (music) g.push(`[1:a]volume=0.35,afade=t=in:d=1,afade=t=out:st=${Math.max(0, ed.duration - 1.5).toFixed(2)}:d=1.5[aout]`);
      else if (ed.hasAudio && fades) g.push(`[0:a]${af}[aout]`);
      const hasA = ed.hasAudio || !!music, aMap = g.some(x => x.endsWith('[aout]')) ? '[aout]' : '0:a';
      if (g.length) await fsp.writeFile(abs('pass2.fgraph'), g.join(';\n'));
      const venc = fmt === 'webm' ? ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '33', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4', '-pix_fmt', 'yuv420p']
        : vf.length ? ['-c:v', 'libx264', '-preset', 'fast', '-crf', '19', '-pix_fmt', 'yuv420p'] : ['-c:v', 'copy'];
      const aenc = fmt === 'webm' ? ['-c:a', 'libopus', '-b:a', '128k'] : ['-c:a', 'aac', '-b:a', '192k'];
      checkCancelled();
      await media.runFfmpeg([
        '-i', 'edit.mp4', ...(music ? ['-stream_loop', '-1', '-i', music] : []),
        ...(g.length ? ['-filter_complex_script', 'pass2.fgraph'] : []),
        '-map', vf.length ? '[vout]' : '0:v', ...(hasA ? ['-map', aMap] : []),
        ...venc, ...(hasA ? aenc : []), ...(fmt === 'webm' ? [] : ['-movflags', '+faststart']),
        '-t', ed.duration.toFixed(3), out
      ], { cwd: dir, totalSec: ed.duration, ctl, onProgress: p => progress(62 + p * 36) });
      await fsp.rm(abs('edit.mp4'), { force: true });
    }
    await fsp.rm(abs('audio.mp3'), { force: true });
    checkCancelled();
    const fin = await media.probe(abs(out));
    checkCancelled();
    const st = await fsp.stat(abs(out));
    if (!(fin.duration > 0) || !fin.hasVideo) throw fail('EMPTY_OUTPUT', 'The final render produced an invalid video.');
    job.result = { file: out, format: fmt, duration_seconds: +fin.duration.toFixed(2), width: fin.width, height: fin.height, size_bytes: st.size, has_audio: fin.hasAudio };
    step(3, 'done', fmtDur(fin.duration) + ' · ' + Math.max(1, Math.round(st.size / 1024)) + ' KB'); progress(100);
    job.status = 'done'; save();
  } catch (e) {
    if (e.code === 'CANCELLED' || ctl.cancelled) { job.status = 'cancelled'; job.error = { code: 'CANCELLED', message: 'The job was cancelled.' }; }
    else {
      job.status = 'error';
      const where = STEP_LABELS[current].toLowerCase();
      job.error = { code: e.code || 'PROCESSING_FAILED', message: e.code === 'FFMPEG_FAILED' ? 'Video processing failed during “' + where + '”.' : e.message || 'Processing failed.', detail: e.detail || undefined };
      if (job.steps[current].state !== 'done') job.steps[current].state = 'failed';
    }
    job.updated_at = Date.now(); save();
  }
}

module.exports = { runJob, newJob, STEP_LABELS, targetSize };

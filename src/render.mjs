// ccrender — render a ChatCut-style timeline bundle in the agent's own sandbox.
//
// Strategy (measured on a 2-vCPU Cowork sandbox):
//   * plain editing (cuts, layers, captions, audio mix) -> ffmpeg   (~2-3x faster than real time @1080p)
//   * motion-graphic items only                         -> Remotion, transparent PNG frames
//   * everything is checkpointed in <work>/state.json, so a reclaimed sandbox or a
//     10-minute tool-call limit just means "run the same command again".
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export const RENDERER = {name: 'ccrender', version: '0.2.0'};
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MG_ENTRY = path.join(HERE, '..', 'mg', 'index.jsx');
// checkpoints are keyed by bundle AND renderer code, so a renderer fix never reuses stale outputs
const CODE_HASH = crypto.createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).update(fs.readFileSync(MG_ENTRY)).digest('hex').slice(0, 16);
RENDERER.codeHash = CODE_HASH;
export const EXIT_RESUMABLE = 75; // EX_TEMPFAIL: budget used up, re-run to continue

// ---------- small helpers ----------
const sha256File = (p) => new Promise((res, rej) => {
  const h = crypto.createHash('sha256');
  fs.createReadStream(p).on('data', (d) => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej);
});
const sha256Str = (s) => crypto.createHash('sha256').update(s).digest('hex');
const fmtT = (sec) => {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
};
function run(cmd, args, {log} = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, {stdio: ['ignore', 'pipe', 'pipe']});
    let err = '';
    p.stdout.on('data', (d) => log && log(d.toString()));
    p.stderr.on('data', (d) => { err += d.toString(); if (err.length > 20000) err = err.slice(-20000); });
    p.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}\n${err.slice(-3000)}`)));
  });
}
async function ffprobeJson(file) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', (c) => c === 0 ? resolve(JSON.parse(out)) : reject(new Error('ffprobe failed: ' + file)));
  });
}

// ---------- state / checkpoints ----------
class State {
  constructor(work, bundleHash) {
    this.file = path.join(work, 'state.json');
    let s = null;
    try { s = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch {}
    if (!s || s.bundleHash !== bundleHash) s = {bundleHash, done: {}, timings: {}, runs: 0};
    s.runs += 1;
    this.s = s; this.save();
  }
  isDone(k) { return !!this.s.done[k]; }
  mark(k, v = true) { this.s.done[k] = v; this.save(); }
  time(k, sec) { this.s.timings[k] = +(((this.s.timings[k] || 0) + sec).toFixed(2)); this.save(); }
  save() { fs.writeFileSync(this.file, JSON.stringify(this.s, null, 2)); }
}

// ---------- bundle ----------
export function loadBundle(file) {
  const b = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!String(b.version || '').startsWith('render-bundle/')) throw new Error('not a render bundle');
  const t = b.timeline;
  for (const k of ['fps', 'width', 'height', 'durationFrames']) if (!(t[k] > 0)) throw new Error('timeline.' + k + ' missing');
  b._dir = path.dirname(path.resolve(file));
  b._hash = sha256Str(JSON.stringify({...b, _dir: undefined, storage: undefined}));
  b._stateKey = b._hash + ':' + CODE_HASH;
  return b;
}

// ---------- 1. assets: file / https / drive -> local cache ----------
async function download(url, dest, headers = {}) {
  const r = await fetch(url, {headers});
  if (!r.ok) throw new Error(`download ${r.status} ${url}`);
  const tmp = dest + '.part';
  await fs.promises.writeFile(tmp, Buffer.from(await r.arrayBuffer()));
  fs.renameSync(tmp, dest);
}
async function resolveAssets(b, work, st, log) {
  const cache = path.join(work, 'assets');
  fs.mkdirSync(cache, {recursive: true});
  b._local = {};
  for (const [id, a] of Object.entries(b.assets)) {
    const src = a.src;
    let local;
    if (src.startsWith('drive://')) {
      local = path.join(cache, id + (a.ext || ''));
      if (!fs.existsSync(local)) {
        const tok = b.storage?.drive?.accessToken;
        if (!tok) throw new Error(`asset ${id}: drive source needs storage.drive.accessToken`);
        log(`  pull drive ${src}`);
        await download(`https://www.googleapis.com/drive/v3/files/${src.slice(8)}?alt=media`, local, {Authorization: `Bearer ${tok}`});
      }
    } else if (/^https?:\/\//.test(src)) {
      local = path.join(cache, id + (a.ext || path.extname(new URL(src).pathname)));
      if (!fs.existsSync(local)) { log(`  pull ${src}`); await download(src, local); }
    } else {
      local = path.resolve(b._dir, src.replace(/^file:\/\//, ''));
      if (!fs.existsSync(local)) throw new Error(`asset ${id}: missing ${local}`);
    }
    b._local[id] = local;
    if (a.type === 'video' || a.type === 'audio') {
      const pr = await ffprobeJson(local);
      a._hasAudio = pr.streams.some((s) => s.codec_type === 'audio');
      a._duration = +pr.format.duration;
    }
  }
  st.mark('assets');
}

// ---------- 2. motion graphics: Remotion -> transparent PNG frames ----------
// Measured: encoding ProRes 4444 inside Remotion was ~70% of MG time. Writing the PNG
// frames straight to disk and letting the segment pass read them as an image sequence
// is ~3x faster, and one shared browser avoids a relaunch per item.
async function renderMotion(b, work, st, budget, log) {
  const items = b.tracks.filter((t) => t.kind === 'motion').flatMap((t) => t.items);
  if (!items.length) return true;
  const todo = items.filter((it) => !st.isDone('mg:' + it.id));
  if (!todo.length) return collectMg(b, items, st);
  const {bundle} = await import('@remotion/bundler');
  const {selectComposition, renderFrames, openBrowser} = await import('@remotion/renderer');
  const browserExecutable = process.env.CCRENDER_CHROME || findChrome();
  let serveUrl = st.s.done.mgBundle;
  if (!serveUrl || !fs.existsSync(serveUrl)) {
    const t0 = Date.now();
    serveUrl = await bundle({entryPoint: MG_ENTRY, outDir: path.join(work, 'mg-bundle'), onProgress: () => {}});
    st.mark('mgBundle', serveUrl); st.time('mg_bundle', (Date.now() - t0) / 1000);
  }
  const {fps, width, height} = b.timeline;
  const browser = await openBrowser('chrome', {browserExecutable, logLevel: 'error'});
  try {
    for (const it of todo) {
      if (budget.exceeded()) return false;
      const t0 = Date.now();
      const dir = path.join(work, 'mg', it.id);
      fs.rmSync(dir, {recursive: true, force: true});
      fs.mkdirSync(dir, {recursive: true});
      const inputProps = {props: {...it.props, fps, width, height, durationInFrames: it.duration}};
      const composition = await selectComposition({serveUrl, id: it.component, inputProps, puppeteerInstance: browser, logLevel: 'error'});
      if (composition.durationInFrames !== it.duration) {
        throw new Error(`mg ${it.id}: composition is ${composition.durationInFrames} frames, timeline item is ${it.duration}`);
      }
      await renderFrames({
        composition, serveUrl, inputProps, puppeteerInstance: browser, outputDir: dir, imageFormat: 'png',
        concurrency: Number(process.env.CCRENDER_MG_CONCURRENCY || 2), onStart: () => {}, onFrameUpdate: () => {}, logLevel: 'error',
      });
      const frames = fs.readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
      if (frames.length !== it.duration) throw new Error(`mg ${it.id}: rendered ${frames.length} frames, expected ${it.duration}`);
      const pattern = frames[0].replace(/\d+(?=\.png$)/, (d) => `%0${d.length}d`);
      st.mark('mg:' + it.id, {dir, pattern, frames: frames.length});
      st.time('motion_graphics', (Date.now() - t0) / 1000);
      log(`  mg ${it.id} (${it.component}, ${(it.duration / fps).toFixed(1)}s) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }
  } finally {
    await browser.close({silent: true}).catch(() => {});
  }
  return collectMg(b, items, st);
}
function collectMg(b, items, st) {
  b._mg = {};
  for (const it of items) {
    const m = st.s.done['mg:' + it.id];
    if (!m || typeof m !== 'object' || !fs.existsSync(m.dir)) return false;
    b._mg[it.id] = m;
  }
  return true;
}
function findChrome() {
  const roots = ['/opt/pw-browsers'];
  for (const r of roots) {
    if (!fs.existsSync(r)) continue;
    for (const d of fs.readdirSync(r).filter((d) => d.startsWith('chromium_headless_shell'))) {
      for (const sub of fs.readdirSync(path.join(r, d))) {
        const p = path.join(r, d, sub, 'headless_shell');
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return undefined; // let Remotion download its own
}

// ---------- 3. picture: segment graph (shared by export + single-frame proofs) ----------
function captionsAss(b, f0, f1, scaleH) {
  const tr = b.tracks.find((t) => t.kind === 'captions');
  if (!tr) return null;
  const {fps, width, height} = b.timeline;
  const st = tr.style || {};
  const size = Math.round((st.fontSize || 56) * scaleH);
  const cues = tr.cues.filter((c) => c.end > f0 && c.start < f1);
  if (!cues.length) return null;
  const esc = (s) => s.replace(/\n/g, '\\N').replace(/[{}]/g, '');
  const hex = (c, a = '00') => '&H' + a + c.slice(5, 7) + c.slice(3, 5) + c.slice(1, 3);
  const lines = [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${Math.round(width * scaleH)}`, `PlayResY: ${Math.round(height * scaleH)}`, '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, BorderStyle, Outline, Shadow, Alignment, MarginV',
    `Style: Cap,${st.font || 'Noto Sans CJK SC'},${size},${hex(st.color || '#FFFFFF')},${hex('#000000')},${hex('#000000', '60')},1,3,${Math.max(2, Math.round(size / 9))},0,2,${Math.round((st.marginV || 70) * scaleH)}`,
    '', '[Events]', 'Format: Layer, Start, End, Style, Text',
    ...cues.map((c) => `Dialogue: 0,${fmtT(Math.max(0, c.start - f0) / fps)},${fmtT((Math.min(f1, c.end) - f0) / fps)},Cap,${esc(c.text)}`),
  ];
  return lines.join('\n');
}

export function buildPictureGraph(b, work, f0, f1, {scale = 1} = {}) {
  const {fps} = b.timeline;
  const W = Math.round(b.timeline.width * scale / 2) * 2, H = Math.round(b.timeline.height * scale / 2) * 2;
  const dur = (f1 - f0) / fps;
  const inputs = ['-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:r=${fps}:d=${dur.toFixed(4)}`];
  const filters = [];
  let base = '[0:v]', n = 1;
  for (const tr of b.tracks) {
    if (tr.kind !== 'video' && tr.kind !== 'motion') continue;
    if (tr.hidden) continue;
    for (const it of tr.items) {
      const a = it.start, e = it.start + it.duration;
      if (e <= f0 || a >= f1) continue;
      const ov0 = Math.max(a, f0), ov1 = Math.min(e, f1);
      const off = (ov0 - f0) / fps, len = (ov1 - ov0) / fps;
      const into = (ov0 - a) / fps; // seconds into this item
      let chain;
      if (tr.kind === 'motion') {
        const mg = b._mg?.[it.id];
        if (!mg) throw new Error(`mg ${it.id} not rendered`);
        const first = ov0 - a; // first frame index inside the item
        inputs.push('-framerate', String(fps), '-start_number', String(first), '-i', path.join(mg.dir, mg.pattern));
        chain = `[${n}:v]trim=end_frame=${ov1 - ov0},scale=${W}:${H},format=yuva420p`;
      } else {
        const asset = b.assets[it.asset];
        const file = b._local[it.asset];
        if (asset.type === 'image') {
          inputs.push('-loop', '1', '-framerate', String(fps), '-t', len.toFixed(4), '-i', file);
        } else {
          const speed = it.speed || 1;
          const src = (it.sourceStart || 0) / fps + into * speed;
          inputs.push('-ss', src.toFixed(4), '-t', (len * speed).toFixed(4), '-i', file);
        }
        const r = it.rect; // fractional {x,y,w,h}; absent => full-frame cover
        const sp = it.speed && it.speed !== 1 ? `setpts=PTS/${it.speed},` : '';
        if (r) chain = `[${n}:v]${sp}fps=${fps},scale=${Math.round(r.w * W / 2) * 2}:${Math.round(r.h * H / 2) * 2}:force_original_aspect_ratio=increase,crop=${Math.round(r.w * W / 2) * 2}:${Math.round(r.h * H / 2) * 2},format=yuva420p`;
        else chain = `[${n}:v]${sp}fps=${fps},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},format=yuva420p`;
        if (it.opacity != null && it.opacity < 1) chain += `,colorchannelmixer=aa=${it.opacity}`;
        const fi = (it.fadeIn || 0) / fps, fo = (it.fadeOut || 0) / fps, itemLen = it.duration / fps;
        if (fi > 0 && into < fi) chain += `,fade=t=in:st=${(-into).toFixed(4)}:d=${fi}:alpha=1`;
        if (fo > 0 && into + len > itemLen - fo) chain += `,fade=t=out:st=${(itemLen - fo - into).toFixed(4)}:d=${fo}:alpha=1`;
      }
      const x = it.rect ? Math.round(it.rect.x * W) : 0, y = it.rect ? Math.round(it.rect.y * H) : 0;
      filters.push(`${chain},setpts=PTS-STARTPTS+${off.toFixed(4)}/TB[l${n}]`);
      filters.push(`${base}[l${n}]overlay=${x}:${y}:eof_action=pass:format=auto[b${n}]`);
      base = `[b${n}]`; n++;
    }
  }
  const ass = captionsAss(b, f0, f1, scale);
  if (ass) {
    const assFile = path.join(work, 'tmp', `cap_${f0}_${f1}_${scale}.ass`);
    fs.mkdirSync(path.dirname(assFile), {recursive: true});
    fs.writeFileSync(assFile, ass);
    filters.push(`${base}ass=${assFile}[cap]`);
    base = '[cap]';
  }
  filters.push(`${base}format=yuv420p[vout]`);
  return {inputs, filter: filters.join(';'), frames: f1 - f0};
}

async function renderSegments(b, work, st, budget, opt, log) {
  const {fps, durationFrames} = b.timeline;
  const segFrames = Math.round((opt.segmentSec || 10) * fps);
  const segs = [];
  for (let f = 0; f < durationFrames; f += segFrames) segs.push([f, Math.min(durationFrames, f + segFrames)]);
  fs.mkdirSync(path.join(work, 'seg'), {recursive: true});
  for (let i = 0; i < segs.length; i++) {
    const key = 'seg:' + i;
    const out = path.join(work, 'seg', `seg_${String(i).padStart(4, '0')}.ts`);
    if (st.isDone(key) && fs.existsSync(out)) continue;
    if (budget.exceeded()) return {done: false, segs};
    const [f0, f1] = segs[i];
    const g = buildPictureGraph(b, work, f0, f1);
    const t0 = Date.now();
    await run('ffmpeg', ['-v', 'error', '-y', ...g.inputs, '-filter_complex', g.filter, '-map', '[vout]', '-frames:v', String(g.frames),
      '-c:v', 'libx264', '-preset', opt.preset || 'veryfast', '-crf', String(opt.crf ?? 20), '-g', String(fps * 2),
      '-r', String(fps), '-an', '-f', 'mpegts', out + '.part']);
    fs.renameSync(out + '.part', out);
    st.mark(key, true);
    st.time('picture', (Date.now() - t0) / 1000);
    log(`  segment ${i + 1}/${segs.length} [${(f0 / fps).toFixed(1)}s-${(f1 / fps).toFixed(1)}s] ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
  return {done: true, segs};
}

// ---------- 4. audio: one pass, role-based ducking (anchor = speech, follower = music) ----------
async function renderAudio(b, work, st, log) {
  const out = path.join(work, 'audio.m4a');
  if (st.isDone('audio') && fs.existsSync(out)) return out;
  const {fps, durationFrames} = b.timeline;
  const total = durationFrames / fps;
  const inputs = [], anchors = [], followers = [];
  let n = 0;
  const add = (it, tr, file) => {
    const speed = it.speed || 1;
    const src = (it.sourceStart || 0) / fps;
    const len = it.duration / fps;
    inputs.push('-ss', src.toFixed(4), '-t', (len * speed).toFixed(4), '-i', file);
    const vol = (it.volume ?? 1) * (tr.volume ?? 1);
    const fi = (it.audioFadeIn || 0) / fps, fo = (it.audioFadeOut || 0) / fps;
    let c = `[${n}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo`;
    if (speed !== 1) c += `,atempo=${speed}`;
    c += `,volume=${vol}`;
    if (fi) c += `,afade=t=in:st=0:d=${fi}`;
    if (fo) c += `,afade=t=out:st=${(len - fo).toFixed(3)}:d=${fo}`;
    const ms = Math.round((it.start / fps) * 1000);
    c += `,adelay=${ms}|${ms}[a${n}]`;
    ((tr.role || 'anchor') === 'follower' ? followers : anchors).push({label: `[a${n}]`, chain: c});
    n++;
  };
  for (const tr of b.tracks) {
    if (tr.muted) continue;
    if (tr.kind === 'audio') for (const it of tr.items) add(it, tr, b._local[it.asset]);
    if (tr.kind === 'video') for (const it of tr.items) {
      const a = b.assets[it.asset];
      if (a.type === 'video' && a._hasAudio && it.audio !== false) add(it, {role: tr.audioRole || 'anchor', volume: tr.volume}, b._local[it.asset]);
    }
  }
  const t0 = Date.now();
  if (!n) {
    await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `anullsrc=r=48000:cl=stereo`, '-t', total.toFixed(4), '-c:a', 'aac', '-b:a', '192k', out]);
  } else {
    const f = [...anchors, ...followers].map((x) => x.chain);
    // pad every bus to the full timeline: sidechaincompress stops when its sidechain ends,
    // so an un-padded speech bus would cut the music off when the talking stops.
    const pad = `apad=whole_dur=${total.toFixed(4)}`;
    const mix = (arr, name) => arr.length === 1 ? `${arr[0].label}${pad}[${name}]` : `${arr.map((x) => x.label).join('')}amix=inputs=${arr.length}:normalize=0:duration=longest,${pad}[${name}]`;
    if (anchors.length) f.push(mix(anchors, 'anc'));
    if (followers.length) f.push(mix(followers, 'fol'));
    if (anchors.length && followers.length) {
      const d = b.audio?.ducking || {};
      f.push('[anc]asplit=2[anc1][anc2]');
      f.push(`[fol][anc2]sidechaincompress=threshold=${d.threshold ?? 0.02}:ratio=${d.ratio ?? 10}:attack=${d.attack ?? 15}:release=${d.release ?? 350}[duck]`);
      f.push('[anc1][duck]amix=inputs=2:normalize=0:duration=longest[mix]');
    } else f.push(`[${anchors.length ? 'anc' : 'fol'}]anull[mix]`);
    f.push(`[mix]apad,atrim=0:${total.toFixed(4)},alimiter=limit=0.95[aout]`);
    await run('ffmpeg', ['-v', 'error', '-y', ...inputs, '-filter_complex', f.join(';'), '-map', '[aout]', '-c:a', 'aac', '-b:a', '192k', out + '.part.m4a']);
    fs.renameSync(out + '.part.m4a', out);
  }
  st.mark('audio'); st.time('audio', (Date.now() - t0) / 1000);
  log(`  audio mix ${((Date.now() - t0) / 1000).toFixed(1)}s (${anchors.length} anchor, ${followers.length} follower)`);
  return out;
}

// ---------- 5. mux + deliverables ----------
async function finalize(b, work, st, segs, audio, outDir, log) {
  fs.mkdirSync(outDir, {recursive: true});
  const final = path.join(outDir, `${b.renderId || 'export'}.mp4`);
  const t0 = Date.now();
  if (!st.isDone('mux') || !fs.existsSync(final)) {
    const list = path.join(work, 'seg', 'list.txt');
    fs.writeFileSync(list, segs.map((_, i) => `file 'seg_${String(i).padStart(4, '0')}.ts'`).join('\n'));
    await run('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-i', audio, '-map', '0:v', '-map', '1:a',
      '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart', '-shortest', final]);
    st.mark('mux');
  }
  const preview = path.join(outDir, 'preview_360p.mp4');
  const poster = path.join(outDir, 'poster.jpg');
  if (!st.isDone('preview') || !fs.existsSync(preview)) {
    await run('ffmpeg', ['-v', 'error', '-y', '-i', final, '-vf', 'scale=-2:360', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30',
      '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', preview]);
    const mid = (b.timeline.durationFrames / b.timeline.fps) / 2;
    await run('ffmpeg', ['-v', 'error', '-y', '-ss', mid.toFixed(2), '-i', final, '-frames:v', '1', '-q:v', '3', poster]);
    st.mark('preview');
  }
  st.time('mux_preview', (Date.now() - t0) / 1000);
  const pr = await ffprobeJson(final);
  const v = pr.streams.find((s) => s.codec_type === 'video');
  const manifest = {
    // == payload for ChatCut `register_export` ==
    renderId: b.renderId, projectId: b.projectId, timelineId: b.timelineId,
    bundleHash: b._hash, renderer: RENDERER, renderedAt: new Date().toISOString(), renderedOn: 'agent-sandbox',
    file: {name: path.basename(final), bytes: fs.statSync(final).size, sha256: await sha256File(final)},
    media: {durationSec: +(+pr.format.duration).toFixed(3), width: v.width, height: v.height, fps: b.timeline.fps, videoCodec: v.codec_name,
      audioCodec: pr.streams.find((s) => s.codec_type === 'audio')?.codec_name},
    preview: {file: path.basename(preview), poster: path.basename(poster)},
    timings: st.s.timings, invocations: st.s.runs,
  };
  fs.writeFileSync(path.join(outDir, 'export-manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

// ---------- public API ----------
export async function exportBundle(bundlePath, {work, out, budgetSec = Infinity, segmentSec = 10, crf, preset, log = console.log} = {}) {
  const b = loadBundle(bundlePath);
  work = path.resolve(work || path.join(path.dirname(bundlePath), '.ccrender', b.renderId || 'job'));
  out = path.resolve(out || path.join(path.dirname(bundlePath), 'out'));
  fs.mkdirSync(work, {recursive: true});
  const st = new State(work, b._stateKey);
  const started = Date.now();
  const budget = {exceeded: () => (Date.now() - started) / 1000 > budgetSec};
  log(`ccrender ${RENDERER.version} · ${b.renderId} · ${b.timeline.width}x${b.timeline.height}@${b.timeline.fps} · ${(b.timeline.durationFrames / b.timeline.fps).toFixed(1)}s · run #${st.s.runs}`);
  const T = async (k, fn) => { const t0 = Date.now(); const r = await fn(); st.time('wall_' + k, (Date.now() - t0) / 1000); return r; };
  await T('assets', () => resolveAssets(b, work, st, log));
  if (!(await T('mg', () => renderMotion(b, work, st, budget, log)))) return {status: 'resumable', work};
  const {done, segs} = await T('picture', () => renderSegments(b, work, st, budget, {segmentSec, crf, preset}, log));
  if (!done) return {status: 'resumable', work};
  const audio = await renderAudio(b, work, st, log);
  const manifest = await finalize(b, work, st, segs, audio, out, log);
  return {status: 'done', manifest, out};
}

// Single composed frames for agent self-checks (replaces cloud `preview_timeline` viewer frames).
export async function proofFrames(bundlePath, seconds, {work, out, scale = 0.5, log = console.log} = {}) {
  const b = loadBundle(bundlePath);
  work = path.resolve(work || path.join(path.dirname(bundlePath), '.ccrender', b.renderId || 'job'));
  out = path.resolve(out || path.join(path.dirname(bundlePath), 'out', 'frames'));
  fs.mkdirSync(work, {recursive: true}); fs.mkdirSync(out, {recursive: true});
  const st = new State(work, b._stateKey);
  await resolveAssets(b, work, st, () => {});
  await renderMotion(b, work, st, {exceeded: () => false}, log);
  const files = [];
  for (const s of seconds) {
    const f0 = Math.min(b.timeline.durationFrames - 1, Math.round(s * b.timeline.fps));
    const g = buildPictureGraph(b, work, f0, f0 + 1, {scale});
    const file = path.join(out, `frame_${s.toFixed(2)}s.jpg`);
    const t0 = Date.now();
    await run('ffmpeg', ['-v', 'error', '-y', ...g.inputs, '-filter_complex', g.filter, '-map', '[vout]', '-frames:v', '1', '-q:v', '3', file]);
    files.push({t: s, file, ms: Date.now() - t0});
  }
  return files;
}

// Resumable upload of a finished file into the user's Google Drive (token comes from the bundle).
export async function uploadToDrive(file, {accessToken, folderId, name} = {}) {
  const size = fs.statSync(file).size;
  const init = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,size,webViewLink', {
    method: 'POST',
    headers: {Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Length': String(size)},
    body: JSON.stringify({name: name || path.basename(file), parents: folderId ? [folderId] : undefined}),
  });
  if (!init.ok) throw new Error('drive init ' + init.status + ' ' + (await init.text()));
  const session = init.headers.get('location');
  const CHUNK = 32 * 1024 * 1024; // multiple of 256 KiB
  const fd = fs.openSync(file, 'r');
  let offset = 0, last;
  while (offset < size) {
    const len = Math.min(CHUNK, size - offset);
    const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, offset);
    last = await fetch(session, {method: 'PUT', headers: {'Content-Range': `bytes ${offset}-${offset + len - 1}/${size}`}, body: buf});
    if (last.status !== 308 && !last.ok) throw new Error('drive chunk ' + last.status);
    offset += len;
  }
  fs.closeSync(fd);
  return last.json();
}

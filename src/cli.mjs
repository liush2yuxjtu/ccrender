#!/usr/bin/env node
// Usage:
//   ccrender export <bundle.json> [--out dir] [--work dir] [--budget-sec N] [--segment-sec 10] [--crf 20] [--preset veryfast]
//       exit 0 = done, exit 75 = budget used up (run the same command again to resume)
//   ccrender frames <bundle.json> --at 1.5,4,9.2 [--scale 0.5]
//   ccrender upload <file> [--folder <folderId>]
// Drive access token: env CCRENDER_DRIVE_TOKEN (keeps it off disk and out of `ps`).
import {parseArgs} from 'node:util';
import {exportBundle, proofFrames, uploadToDrive, EXIT_RESUMABLE} from './render.mjs';

const str = {type: 'string'};
const num = (name, raw) => {
  if (raw === undefined) return undefined;
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0) throw new Error(`--${name} must be a positive number, got '${raw}'`);
  return v;
};
let cmd, target, opt;
try {
  const {values, positionals} = parseArgs({
    allowPositionals: true,
    options: {out: str, work: str, 'budget-sec': str, 'segment-sec': str, crf: str, preset: str, at: str, scale: str, token: str, folder: str},
  });
  [cmd, target] = positionals; opt = values;
  for (const k of ['budget-sec', 'segment-sec', 'scale']) opt[k] = num(k, opt[k]);
} catch (e) {
  console.error('ccrender:', e.message); process.exit(2);
}

try {
  if (cmd === 'export') {
    const r = await exportBundle(target, {
      out: opt.out, work: opt.work, budgetSec: opt['budget-sec'] ?? Infinity,
      segmentSec: opt['segment-sec'] ?? 10, crf: opt.crf, preset: opt.preset,
    });
    console.log(JSON.stringify(r.status === 'done' ? {status: 'done', manifest: r.manifest} : r, null, 2));
    process.exit(r.status === 'done' ? 0 : EXIT_RESUMABLE);
  } else if (cmd === 'frames') {
    const r = await proofFrames(target, String(opt.at || '0').split(',').map(Number), {scale: opt.scale ?? 0.5, out: opt.out});
    console.log(JSON.stringify(r, null, 2));
  } else if (cmd === 'upload') {
    if (opt.token) console.warn('ccrender: --token is visible in the process list; prefer CCRENDER_DRIVE_TOKEN');
    const accessToken = process.env.CCRENDER_DRIVE_TOKEN || opt.token;
    if (!accessToken) throw new Error('upload needs CCRENDER_DRIVE_TOKEN');
    console.log(JSON.stringify(await uploadToDrive(target, {accessToken, folderId: opt.folder}), null, 2));
  } else {
    console.error('usage: ccrender export|frames|upload ...'); process.exit(2);
  }
} catch (e) {
  console.error('ccrender error:', e.message); process.exit(1);
}

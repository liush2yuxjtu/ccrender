#!/usr/bin/env node
// Usage:
//   ccrender export <bundle.json> [--out dir] [--work dir] [--budget-sec N] [--segment-sec 10] [--crf 20] [--preset veryfast]
//       exit 0 = done, exit 75 = budget used up (run the same command again to resume)
//   ccrender frames <bundle.json> --at 1.5,4,9.2 [--scale 0.5]
//   ccrender upload <file> --token <drive access token> [--folder <folderId>]
import {exportBundle, proofFrames, uploadToDrive, EXIT_RESUMABLE} from './render.mjs';

const [cmd, target, ...rest] = process.argv.slice(2);
const opt = {};
for (let i = 0; i < rest.length; i += 2) opt[rest[i].replace(/^--/, '')] = rest[i + 1];

try {
  if (cmd === 'export') {
    const r = await exportBundle(target, {
      out: opt.out, work: opt.work, budgetSec: opt['budget-sec'] ? +opt['budget-sec'] : Infinity,
      segmentSec: opt['segment-sec'] ? +opt['segment-sec'] : 10, crf: opt.crf, preset: opt.preset,
    });
    console.log(JSON.stringify(r.status === 'done' ? {status: 'done', manifest: r.manifest} : r, null, 2));
    process.exit(r.status === 'done' ? 0 : EXIT_RESUMABLE);
  } else if (cmd === 'frames') {
    const r = await proofFrames(target, String(opt.at || '0').split(',').map(Number), {scale: opt.scale ? +opt.scale : 0.5, out: opt.out});
    console.log(JSON.stringify(r, null, 2));
  } else if (cmd === 'upload') {
    console.log(JSON.stringify(await uploadToDrive(target, {accessToken: opt.token, folderId: opt.folder}), null, 2));
  } else {
    console.error('usage: ccrender export|frames|upload ...'); process.exit(2);
  }
} catch (e) {
  console.error('ccrender error:', e.message); process.exit(1);
}

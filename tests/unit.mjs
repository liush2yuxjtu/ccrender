// Fast checks that need no fixtures: streamed + resumed download, atempo chaining.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {download, atempoChain, strongValidator} from '../src/render.mjs';

const body = Buffer.alloc(3 * 1024 * 1024, 7);
const ETAG = '"v1"';
let lastRange = null, lastIfRange = null;
const srv = http.createServer((req, res) => {
  lastRange = req.headers.range || null; lastIfRange = req.headers['if-range'] || null;
  const m = /bytes=(\d+)-/.exec(lastRange || '');
  // RFC 9110: a Range with a non-matching If-Range gets the whole representation
  if (!m || (lastIfRange && lastIfRange !== ETAG)) { res.writeHead(200, {'Content-Length': body.length, ETag: ETAG}); return res.end(body); }
  const from = +m[1];
  if (from >= body.length) { res.writeHead(416, {'Content-Range': `bytes */${body.length}`}); return res.end(); }
  res.writeHead(206, {'Content-Range': `bytes ${from}-${body.length - 1}/${body.length}`, ETag: ETAG}); res.end(body.subarray(from));
});
await new Promise((r) => srv.listen(0, r));
const url = `http://127.0.0.1:${srv.address().port}/f`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-'));
const partial = (name, bytes, validator) => {
  const f = path.join(dir, name);
  fs.writeFileSync(f + '.part', bytes);
  if (validator) fs.writeFileSync(f + '.part.json', JSON.stringify({validator}));
  return f;
};
const done = (f) => fs.readFileSync(f).equals(body) && !fs.existsSync(f + '.part') && !fs.existsSync(f + '.part.json');
try {
  const a = path.join(dir, 'a.bin');
  await download(url, a);
  assert.ok(done(a)); assert.equal(lastRange, null);
  console.log('PASS download full');
  const b = partial('b.bin', body.subarray(0, 1000), ETAG);
  await download(url, b);
  assert.equal(lastRange, 'bytes=1000-'); assert.equal(lastIfRange, ETAG); assert.ok(done(b));
  console.log('PASS download resumes with Range + If-Range');
  const c = partial('c.bin', Buffer.alloc(1000, 9), '"v0"');
  await download(url, c);
  assert.ok(done(c));
  console.log('PASS remote changed (If-Range mismatch) replaces the stale prefix');
  const d = partial('d.bin', Buffer.alloc(1000, 9));
  await download(url, d);
  assert.equal(lastRange, null); assert.ok(done(d));
  console.log('PASS .part without validator restarts');
  const e = partial('e.bin', body, ETAG);
  await download(url, e);
  assert.ok(done(e));
  console.log('PASS download complete .part (416)');
  const g = partial('g.bin', Buffer.concat([body, Buffer.alloc(10)]), ETAG);
  await download(url, g);
  assert.ok(done(g));
  console.log('PASS oversized .part restarts');
} finally { srv.close(); fs.rmSync(dir, {recursive: true, force: true}); }

const H = (o) => new Headers(o);
const t0 = 'Wed, 01 Oct 2026 10:00:00 GMT', t1 = 'Wed, 01 Oct 2026 10:00:00 GMT', t2 = 'Wed, 01 Oct 2026 11:00:00 GMT';
assert.equal(strongValidator(H({etag: '"a"'})), '"a"');
assert.equal(strongValidator(H({etag: 'W/"a"', 'last-modified': t0, date: t2})), null);
assert.equal(strongValidator(H({'last-modified': t0, date: t2})), t0);
assert.equal(strongValidator(H({'last-modified': t0, date: t1})), null);
assert.equal(strongValidator(H({})), null);
console.log('PASS strong validator selection (weak ETag, fresh Last-Modified)');

const prod = (s) => s.split(',').map((x) => +x.split('=')[1]).reduce((a, b) => a * b, 1);
for (const sp of [0.25, 0.5, 1.5, 2, 3, 8]) {
  const ch = atempoChain(sp);
  assert.ok(ch.split(',').every((x) => { const v = +x.split('=')[1]; return v >= 0.5 && v <= 2; }), ch);
  assert.ok(Math.abs(prod(ch) - sp) < 1e-6, ch);
}
console.log('PASS atempo chain in [0.5, 2]');

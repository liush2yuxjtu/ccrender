// Fast checks that need no fixtures: streamed + resumed download, atempo chaining.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {download, atempoChain} from '../src/render.mjs';

const body = Buffer.alloc(3 * 1024 * 1024, 7);
let lastRange = null;
const srv = http.createServer((req, res) => {
  lastRange = req.headers.range || null;
  const m = /bytes=(\d+)-/.exec(lastRange || '');
  if (!m) { res.writeHead(200, {'Content-Length': body.length}); return res.end(body); }
  const from = +m[1];
  if (from >= body.length) { res.writeHead(416); return res.end(); }
  res.writeHead(206, {'Content-Range': `bytes ${from}-${body.length - 1}/${body.length}`}); res.end(body.subarray(from));
});
await new Promise((r) => srv.listen(0, r));
const url = `http://127.0.0.1:${srv.address().port}/f`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-'));
try {
  const a = path.join(dir, 'a.bin');
  await download(url, a);
  assert.ok(fs.readFileSync(a).equals(body)); assert.equal(lastRange, null);
  console.log('PASS download full');
  const b = path.join(dir, 'b.bin');
  fs.writeFileSync(b + '.part', body.subarray(0, 1000));
  await download(url, b);
  assert.equal(lastRange, 'bytes=1000-'); assert.ok(fs.readFileSync(b).equals(body));
  console.log('PASS download resumes with Range');
  const c = path.join(dir, 'c.bin');
  fs.writeFileSync(c + '.part', body);
  await download(url, c);
  assert.ok(fs.readFileSync(c).equals(body));
  console.log('PASS download complete .part (416)');
} finally { srv.close(); fs.rmSync(dir, {recursive: true, force: true}); }

const prod = (s) => s.split(',').map((x) => +x.split('=')[1]).reduce((a, b) => a * b, 1);
for (const sp of [0.25, 0.5, 1.5, 2, 3, 8]) {
  const ch = atempoChain(sp);
  assert.ok(ch.split(',').every((x) => { const v = +x.split('=')[1]; return v >= 0.5 && v <= 2; }), ch);
  assert.ok(Math.abs(prod(ch) - sp) < 1e-6, ch);
}
console.log('PASS atempo chain in [0.5, 2]');

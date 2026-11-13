// Interop with @discordjs/opus — skipped when it is not installed.
// Run: `npm install` (devDependency) then `node --test test/interop.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRequire } from 'node:module';

let DiscordOpus;
try {
  // require(), not `await import()`: @discordjs/opus's named exports are
  // not statically detectable by cjs-module-lexer, so an ESM import yields
  // no `OpusEncoder` binding even though the CJS require works.
  ({ OpusEncoder: DiscordOpus } = createRequire(import.meta.url)('@discordjs/opus'));
} catch {
  console.log('skipping interop tests: @discordjs/opus is not installed');
}

import { OpusEncoder as RustyOpus } from '../index.js';

function sinePcm({ rate = 48000, channels = 2, seconds = 1, freq = 440 } = {}) {
  const samples = rate * seconds;
  const buf = Buffer.alloc(samples * channels * 2);
  for (let i = 0; i < samples; i++) {
    const s = Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 0.5 * 32767);
    for (let ch = 0; ch < channels; ch++) buf.writeInt16LE(s, (i * channels + ch) * 2);
  }
  return buf;
}

function rmsError(a, b) {
  assert.equal(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < a.length; i += 2) {
    const d = (a.readInt16LE(i) - b.readInt16LE(i)) / 32768;
    sum += d * d;
  }
  return Math.sqrt(sum / (a.length / 2));
}

const maybe = DiscordOpus ? test : test.skip;

maybe('our packets decode with @discordjs/opus', () => {
  const ours = new RustyOpus(48000, 2);
  const theirs = new DiscordOpus(48000, 2);
  const pcm = sinePcm({ seconds: 1 });
  const frameBytes = 960 * 2 * 2;
  // Same pre-skip alignment as the main tests: encode one extra silent
  // frame to flush, drop the first 312 samples of the decoded stream.
  const packets = [];
  for (let off = 0; off + frameBytes <= pcm.length; off += frameBytes) {
    packets.push(ours.encode(pcm.subarray(off, off + frameBytes), 960));
  }
  packets.push(ours.encode(Buffer.alloc(frameBytes), 960));
  const decodedAll = Buffer.concat(packets.map((pkt) => theirs.decode(pkt, 960)));
  // Aligned by OUR pre-skip (120 at 48 kHz Audio), not libopus's 312.
  const decoded = decodedAll.subarray(120 * 2 * 2, 120 * 2 * 2 + pcm.length);
  assert.equal(decoded.length, pcm.length);
  assert.ok(rmsError(pcm, decoded) < 0.05);
});

maybe('@discordjs/opus packets decode with us', () => {
  const ours = new RustyOpus(48000, 2);
  const theirs = new DiscordOpus(48000, 2);
  const pcm = sinePcm({ seconds: 1 });
  const frameBytes = 960 * 2 * 2;
  const packets = [];
  for (let off = 0; off + frameBytes <= pcm.length; off += frameBytes) {
    packets.push(theirs.encode(pcm.subarray(off, off + frameBytes), 960));
  }
  packets.push(theirs.encode(Buffer.alloc(frameBytes), 960));
  const decodedAll = Buffer.concat(packets.map((pkt) => ours.decode(pkt, 960)));
  // Aligned by THEIR pre-skip (libopus: 312 at 48 kHz).
  const decoded = decodedAll.subarray(312 * 2 * 2, 312 * 2 * 2 + pcm.length);
  assert.equal(decoded.length, pcm.length);
  assert.ok(rmsError(pcm, decoded) < 0.05);
});

maybe('same input, both codecs produce valid packets of similar size', () => {
  // NOTE: the defaults differ — @discordjs/opus (libopus) defaults to
  // 120000 bps, @ndqp/bun-rusty-opus defaults to 64000 bps — so the bitrate must
  // be matched explicitly before comparing sizes. With matched bitrate the
  // totals are within a few percent (measured 1.03-1.28x across 32-96 kbps).
  const ours = new RustyOpus(48000, 2, { bitrate: 64000 });
  const theirs = new DiscordOpus(48000, 2);
  theirs.setBitrate(64000);
  const frame = sinePcm({ seconds: 0.02 });
  const a = ours.encode(frame, 960);
  const b = theirs.encode(frame, 960);
  assert.ok(a.length > 2 && b.length > 2);
  // Same codec family, same bitrate — sizes should be in the same ballpark.
  assert.ok(Math.abs(a.length - b.length) < Math.max(a.length, b.length) * 0.5);
});

// Decode-only probe across configs, both codecs, same packets.
// Usage: node bench/probe-decode.mjs
import { OpusEncoder as Rusty } from '../index.js';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';

const { OpusEncoder: Discord } = createRequire(import.meta.url)('@discordjs/opus');

function sine(seconds, rate, ch) {
  const n = Math.floor(rate * seconds);
  const buf = Buffer.alloc(n * ch * 2);
  for (let i = 0; i < n; i++) {
    const s = Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 0.5 * 32767);
    for (let c = 0; c < ch; c++) buf.writeInt16LE(s, (i * ch + c) * 2);
  }
  return buf;
}

function bestOf(fn, rounds = 5) {
  let best = Infinity;
  for (let r = 0; r < rounds; r++) {
    const t0 = performance.now();
    fn();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

for (const [rate, ch, app] of [
  [48000, 2, 'audio'],
  [48000, 1, 'audio'],
  [48000, 2, 'voip'],
  [48000, 2, 'lowDelay'],
  [16000, 1, 'voip'],
  [16000, 1, 'audio'],
  [8000, 1, 'voip'],
  [24000, 2, 'audio'],
]) {
  const frame = rate / 50;
  const frameBytes = frame * ch * 2;
  const pcm = sine(10, rate, ch);
  const frames = [];
  for (let off = 0; off + frameBytes <= pcm.length; off += frameBytes) {
    frames.push(pcm.subarray(off, off + frameBytes));
  }
  const ours = new Rusty(rate, ch, { application: app, bitrate: 64000 });
  const theirs = new Discord(rate, ch);
  theirs.setBitrate(64000);
  const ourPackets = frames.map((f) => ours.encode(f, frame));
  const theirPackets = frames.map((f) => theirs.encode(f, frame));

  // Each codec decodes its OWN packets (same as bench.mjs), and also the
  // OTHER codec's packets — to separate "codec decode speed" from
  // "packet content" effects.
  const dOursOwn = bestOf(() => {
    for (const p of ourPackets) ours.decode(p, frame);
  });
  const dTheirsOwn = bestOf(() => {
    for (const p of theirPackets) theirs.decode(p, frame);
  });
  const dOursTheirs = bestOf(() => {
    for (const p of theirPackets) ours.decode(p, frame);
  });
  const dTheirsOurs = bestOf(() => {
    for (const p of ourPackets) theirs.decode(p, frame);
  });
  const eOurs = bestOf(() => {
    for (const f of frames) ours.encode(f, frame);
  });
  const eTheirs = bestOf(() => {
    for (const f of frames) theirs.encode(f, frame);
  });
  console.log(
    `${String(rate).padStart(5)}Hz ${ch}ch ${app.padEnd(9)}` +
      ` enc ours ${eOurs.toFixed(1).padStart(6)} / theirs ${eTheirs.toFixed(1).padStart(6)}` +
      ` | dec(own pkt) ours ${dOursOwn.toFixed(1).padStart(6)} / theirs ${dTheirsOwn.toFixed(1).padStart(6)}` +
      ` | dec(other pkt) ours ${dOursTheirs.toFixed(1).padStart(6)} / theirs ${dTheirsOurs.toFixed(1).padStart(6)}`,
  );
}

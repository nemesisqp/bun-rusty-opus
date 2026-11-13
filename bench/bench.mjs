// Benchmark: @ndqp/bun-rusty-opus vs @discordjs/opus (if installed).
// Usage: bun bench/bench.mjs  (or: node bench/bench.mjs)
// Encodes + decodes 10 s of 48 kHz stereo audio in 20 ms frames.
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import { OpusEncoder } from '../index.js';

let DiscordOpus = null;
try {
  // require(), not `await import()`: @discordjs/opus's named exports are not
  // statically detectable by cjs-module-lexer (same as test/interop.test.mjs).
  // Under Bun this fails because its prebuild targets Node's ABI, not Bun's —
  // that is a @discordjs/opus limitation, not a bench bug.
  ({ OpusEncoder: DiscordOpus } = createRequire(import.meta.url)('@discordjs/opus'));
} catch {
  console.log('@discordjs/opus not loadable here — benchmarking @ndqp/bun-rusty-opus only.\n');
}

function sinePcm(seconds = 10, rate = 48000, channels = 2) {
  const samples = rate * seconds;
  const buf = Buffer.alloc(samples * channels * 2);
  for (let i = 0; i < samples; i++) {
    const s = Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 0.5 * 32767);
    for (let ch = 0; ch < channels; ch++) buf.writeInt16LE(s, (i * channels + ch) * 2);
  }
  return buf;
}

function benchCodec(name, makeEncoder, pcm, frameBytes, frameSamples, rounds = 3) {
  const frames = [];
  for (let off = 0; off + frameBytes <= pcm.length; off += frameBytes) frames.push(pcm.subarray(off, off + frameBytes));
  const results = [];
  for (let r = 0; r < rounds; r++) {
    const enc = makeEncoder();
    const t0 = performance.now();
    const packets = frames.map((f) => enc.encode(f, frameSamples));
    const t1 = performance.now();
    for (const p of packets) enc.decode(p, frameSamples);
    const t2 = performance.now();
    results.push({ encodeMs: t1 - t0, decodeMs: t2 - t1 });
  }
  const best = results.reduce((a, b) => (a.encodeMs + a.decodeMs < b.encodeMs + b.decodeMs ? a : b));
  const audioSeconds = frames.length * (frameSamples / 48000);
  const totalMs = best.encodeMs + best.decodeMs;
  console.log(
    `${name.padEnd(18)} encode ${best.encodeMs.toFixed(1).padStart(7)} ms  ` +
      `decode ${best.decodeMs.toFixed(1).padStart(7)} ms  ` +
      `total ${totalMs.toFixed(1).padStart(7)} ms  ` +
      `${(audioSeconds / (totalMs / 1000)).toFixed(1)}x realtime  ` +
      `${((frames.length * 1000) / totalMs).toFixed(0)} frames/s`,
  );
  return best;
}

const pcm = sinePcm();
const frameBytes = 960 * 2 * 2;
console.log('10 s of 48 kHz stereo, 20 ms frames (500 frames), best of 3 rounds');
console.log('Bitrate matched at 64000 bps for both codecs (defaults differ: ours 64k, @discordjs/opus 120k).\n');
// @discordjs/opus defaults to 120000 bps, ours to 64000 — match them, or the
// comparison measures bitrate, not codec speed.
const rusty = benchCodec('@ndqp/bun-rusty-opus', () => new OpusEncoder(48000, 2, { bitrate: 64000 }), pcm, frameBytes, 960);
if (DiscordOpus) {
  const discord = benchCodec('@discordjs/opus', () => {
    const enc = new DiscordOpus(48000, 2);
    enc.setBitrate(64000);
    return enc;
  }, pcm, frameBytes, 960);
  console.log(
    `\n@ndqp/bun-rusty-opus vs @discordjs/opus: encode ${(discord.encodeMs / rusty.encodeMs).toFixed(2)}x, ` +
      `decode ${(discord.decodeMs / rusty.decodeMs).toFixed(2)}x, ` +
      `overall ${((discord.encodeMs + discord.decodeMs) / (rusty.encodeMs + rusty.decodeMs)).toFixed(2)}x ` +
      `(higher = @ndqp/bun-rusty-opus faster)`,
  );
}

// Reuse path: encodeInto/decodeInto with one pre-allocated output buffer.
{
  const frames = [];
  for (let off = 0; off + frameBytes <= pcm.length; off += frameBytes) frames.push(pcm.subarray(off, off + frameBytes));
  const enc = new OpusEncoder(48000, 2, { bitrate: 64000 });
  const outPacket = Buffer.alloc(1276);
  const outPcm = Buffer.alloc(frameBytes);
  const packets = frames.map((f) => enc.encode(f, 960)); // outside the timed section
  const t0 = performance.now();
  const sizes = frames.map((f) => enc.encodeInto(f, outPacket, 960));
  const t1 = performance.now();
  for (const p of packets) enc.decodeInto(p, outPcm, 960);
  const t2 = performance.now();
  console.log(
    `\n@ndqp/bun-rusty-opus (reuse) encodeInto ${(t1 - t0).toFixed(1)} ms, decodeInto ${(t2 - t1).toFixed(1)} ms ` +
      `(no Buffer allocated per frame; packet sizes ${sizes[0]}..${Math.max(...sizes)} bytes)`,
  );
}

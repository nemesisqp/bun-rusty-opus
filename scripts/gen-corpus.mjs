// Generates a fixed, deterministic corpus for decode-parity checks.
//
// Packets are encoded with @discordjs/opus (libopus), so the corpus is
// independent of rusty-opus entirely. Signals are synthetic and seeded.
// Run: `node scripts/gen-corpus.mjs` (regenerates scripts/corpus/).
// Output: scripts/corpus/packets/<config>.bin (u32 LE count, then per
// packet u32 LE length + bytes), scripts/corpus/pcm/<config>.s16 (the
// source PCM, for encode-identity checks), scripts/corpus/manifest.json.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const { OpusEncoder } = createRequire(import.meta.url)('@discordjs/opus');

const root = join(dirname(fileURLToPath(import.meta.url)), 'corpus');
mkdirSync(join(root, 'packets'), { recursive: true });
mkdirSync(join(root, 'pcm'), { recursive: true });

const OPUS_SET_APPLICATION = 4000;
const APP = { voip: 2048, audio: 2049, restricted_lowdelay: 2051 };

// Deterministic PRNG (mulberry32).
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function genSignal(kind, rate, channels, seconds) {
  const n = rate * seconds;
  const buf = Buffer.alloc(n * channels * 2);
  const r = rng(0xc0ffee);
  for (let i = 0; i < n; i++) {
    let s = 0;
    switch (kind) {
      case 'sine':
        s = Math.sin((2 * Math.PI * 440 * i) / rate) * 0.5;
        break;
      case 'chirp': {
        const f = 100 + (4000 - 100) * (i / n);
        s = Math.sin((2 * Math.PI * f * i) / rate) * 0.5;
        break;
      }
      case 'noise':
        s = (r() - 0.5) * 0.9;
        break;
      case 'silence':
        s = 0;
        break;
      case 'speech': {
        // Harmonic stack + slow AM + pauses: exercises SILK + mode logic.
        const env = Math.sin((2 * Math.PI * 2 * i) / rate) > 0.2 ? 1 : 0.15;
        const f0 = 110 + 40 * Math.sin((2 * Math.PI * 0.5 * i) / rate);
        s =
          env *
          0.4 *
          (Math.sin((2 * Math.PI * f0 * i) / rate) +
            0.5 * Math.sin((2 * Math.PI * 2 * f0 * i) / rate) +
            0.25 * Math.sin((2 * Math.PI * 3 * f0 * i) / rate));
        break;
      }
      case 'twotone':
        s =
          0.35 * Math.sin((2 * Math.PI * 523 * i) / rate) +
          0.35 * Math.sin((2 * Math.PI * 784 * i) / rate);
        break;
      default:
        throw new Error(`unknown signal ${kind}`);
    }
    const v = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
    for (let ch = 0; ch < channels; ch++) {
      buf.writeInt16LE(v, (i * channels + ch) * 2);
    }
  }
  return buf;
}

const CONFIGS = [
  { name: '48k-stereo-audio-64k-20ms', rate: 48000, channels: 2, app: 'audio', bitrate: 64000, frameMs: 20, signal: 'sine' },
  { name: '48k-stereo-voip-64k-20ms', rate: 48000, channels: 2, app: 'voip', bitrate: 64000, frameMs: 20, signal: 'speech' },
  { name: '48k-mono-audio-32k-20ms', rate: 48000, channels: 1, app: 'audio', bitrate: 32000, frameMs: 20, signal: 'chirp' },
  { name: '48k-stereo-lowdelay-64k-20ms', rate: 48000, channels: 2, app: 'restricted_lowdelay', bitrate: 64000, frameMs: 20, signal: 'twotone' },
  { name: '24k-stereo-audio-48k-20ms', rate: 24000, channels: 2, app: 'audio', bitrate: 48000, frameMs: 20, signal: 'sine' },
  { name: '16k-mono-voip-24k-20ms', rate: 16000, channels: 1, app: 'voip', bitrate: 24000, frameMs: 20, signal: 'speech' },
  { name: '8k-mono-voip-16k-20ms', rate: 8000, channels: 1, app: 'voip', bitrate: 16000, frameMs: 20, signal: 'silence' },
  { name: '48k-stereo-audio-128k-10ms', rate: 48000, channels: 2, app: 'audio', bitrate: 128000, frameMs: 10, signal: 'noise' },
  { name: '48k-stereo-audio-64k-40ms', rate: 48000, channels: 2, app: 'audio', bitrate: 64000, frameMs: 40, signal: 'chirp' },
  { name: '48k-stereo-audio-16k-20ms', rate: 48000, channels: 2, app: 'audio', bitrate: 16000, frameMs: 20, signal: 'noise' },
  { name: '48k-stereo-audio-64k-2.5ms', rate: 48000, channels: 2, app: 'audio', bitrate: 64000, frameMs: 2.5, signal: 'sine' },
];

const manifest = [];
for (const cfg of CONFIGS) {
  const pcm = genSignal(cfg.signal, cfg.rate, cfg.channels, 2);
  const frameSize = Math.round((cfg.rate * cfg.frameMs) / 1000);
  const frameBytes = frameSize * cfg.channels * 2;
  const enc = new OpusEncoder(cfg.rate, cfg.channels);
  enc.setBitrate(cfg.bitrate);
  enc.applyEncoderCTL(OPUS_SET_APPLICATION, APP[cfg.app]);
  const packets = [];
  for (let off = 0; off + frameBytes <= pcm.length; off += frameBytes) {
    packets.push(enc.encode(pcm.subarray(off, off + frameBytes), frameSize));
  }
  // One trailing silent frame, so the decoder's overlap tail is exercised.
  packets.push(enc.encode(Buffer.alloc(frameBytes), frameSize));

  const out = Buffer.alloc(4 + packets.reduce((a, p) => a + 4 + p.length, 0));
  let w = 0;
  out.writeUInt32LE(packets.length, w);
  w += 4;
  for (const p of packets) {
    out.writeUInt32LE(p.length, w);
    w += 4;
    p.copy(out, w);
    w += p.length;
  }
  writeFileSync(join(root, 'packets', `${cfg.name}.bin`), out);
  writeFileSync(join(root, 'pcm', `${cfg.name}.s16`), pcm);
  manifest.push({ ...cfg, frameSize, packets: packets.length });
  console.log(`${cfg.name}: ${packets.length} packets, ${pcm.length} bytes PCM`);
}

writeFileSync(join(root, 'manifest.json'), JSON.stringify({ generated: new Date().toISOString(), encoder: '@discordjs/opus (libopus)', configs: manifest }, null, 2));
console.log(`wrote ${manifest.length} configs to ${root}`);

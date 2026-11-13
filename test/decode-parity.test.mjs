// Decode parity vs libopus (@discordjs/opus) on the fixed corpus.
//
// Both codecs decode the SAME libopus packets, so their PCM must agree to
// within float-path rounding (measured RMS ~2e-5, max abs diff exactly 1 s16
// LSB). Thresholds below give ~3x headroom over the measured values —
// tight enough to catch any regression the fork introduces, loose enough
// for the two float implementations to differ in last bits.
//
// The corpus (scripts/corpus/) is generated on demand by
// scripts/gen-corpus.mjs when missing; it is gitignored (3.3 MB, fully
// regenerable). Skipped when @discordjs/opus is not installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

let DiscordOpus;
try {
  ({ OpusEncoder: DiscordOpus } = createRequire(import.meta.url)('@discordjs/opus'));
} catch {
  console.log('skipping decode-parity tests: @discordjs/opus is not installed');
}

import { OpusEncoder as RustyOpus } from '../index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const corpusDir = join(root, 'scripts', 'corpus');
if (!existsSync(join(corpusDir, 'manifest.json'))) {
  console.log('generating corpus for decode-parity tests...');
  execFileSync('node', [join(root, 'scripts', 'gen-corpus.mjs')], { stdio: 'inherit' });
}
const manifest = JSON.parse(readFileSync(join(corpusDir, 'manifest.json'), 'utf8'));

function readPackets(name) {
  const raw = readFileSync(join(corpusDir, 'packets', `${name}.bin`));
  let off = 0;
  const n = raw.readUInt32LE(off);
  off += 4;
  const packets = [];
  for (let i = 0; i < n; i++) {
    const len = raw.readUInt32LE(off);
    off += 4;
    packets.push(raw.subarray(off, off + len));
    off += len;
  }
  return packets;
}

// RMS and max absolute difference between two s16le PCM buffers,
// relative to full scale. Both decoders output frameSize samples per
// packet, so the streams align sample-for-sample with no pre-skip
// adjustment (the pre-skip is an encoder-side delay).
function diffStats(a, b) {
  assert.equal(a.length, b.length, 'PCM lengths must match');
  let sum = 0;
  let mx = 0;
  for (let i = 0; i < a.length; i += 2) {
    const d = (a.readInt16LE(i) - b.readInt16LE(i)) / 32768;
    sum += d * d;
    mx = Math.max(mx, Math.abs(d));
  }
  return { rms: Math.sqrt(sum / (a.length / 2)), max: mx };
}

const maybe = DiscordOpus ? test : test.skip;

for (const cfg of manifest.configs) {
  maybe(`decode parity vs libopus: ${cfg.name}`, () => {
    const packets = readPackets(cfg.name);
    const ours = new RustyOpus(cfg.rate, cfg.channels);
    const theirs = new DiscordOpus(cfg.rate, cfg.channels);
    const decOurs = Buffer.concat(packets.map((p) => ours.decode(p, cfg.frameSize)));
    const decTheirs = Buffer.concat(packets.map((p) => theirs.decode(p, cfg.frameSize)));
    const { rms, max } = diffStats(decOurs, decTheirs);
    assert.ok(rms < 5e-5, `${cfg.name}: RMS ${rms} < 5e-5`);
    assert.ok(max < 1e-4, `${cfg.name}: max abs diff ${max} < 1e-4`);
  });

  // Packet-loss concealment is a SANITY check, not a libopus comparison:
  // rusty-opus's PLC legitimately diverges from libopus (different
  // concealment fade: measured PLC RMS 0.35 vs libopus 0.23 on the sine
  // corpus, and the frame after a loss differs more). That is a
  // pre-existing upstream difference — the fork's PLC is guarded
  // bit-exactly against pristine 1.0.2 by scripts/check-decode-parity.sh
  // instead. Here we only assert PLC is alive and sane: it outputs
  // non-silent, bounded audio and decoding continues afterwards.
  test(`packet-loss concealment stays sane: ${cfg.name}`, () => {
    const packets = readPackets(cfg.name);
    const dec = new RustyOpus(cfg.rate, cfg.channels);
    const out = [];
    for (let i = 0; i < packets.length; i++) {
      const frame = i % 10 === 9 ? dec.decode(Buffer.alloc(0), cfg.frameSize) : dec.decode(packets[i], cfg.frameSize);
      assert.equal(frame.length, cfg.frameSize * cfg.channels * 2);
      out.push(frame);
    }
    const plc = out[9];
    let sum = 0;
    let mx = 0;
    let finite = true;
    for (let i = 0; i < plc.length; i += 2) {
      const v = plc.readInt16LE(i) / 32768;
      if (!Number.isFinite(v)) finite = false;
      sum += v * v;
      mx = Math.max(mx, Math.abs(v));
    }
    const rms = Math.sqrt(sum / (plc.length / 2));
    assert.ok(finite, `${cfg.name}: PLC output is finite`);
    // Concealing silence is silence — only assert non-silent output when
    // the source signal is audible.
    if (cfg.signal !== 'silence') {
      assert.ok(rms > 0.01, `${cfg.name}: PLC output is non-silent (RMS ${rms})`);
    }
    assert.ok(mx < 1.0, `${cfg.name}: PLC output is bounded (max ${mx})`);
  });
}

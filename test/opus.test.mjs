// bun-rusty-opus tests — run with `node --test test/*.test.mjs` or `bun test test/`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpusEncoder, OpusDecoder, SUPPORTED_SAMPLE_RATES, packetFrameSize } from '../index.js';

/** Sine wave, s16le PCM Buffer. */
function sinePcm({ rate = 48000, channels = 2, seconds = 1, freq = 440, amplitude = 0.5 } = {}) {
  const samples = rate * seconds;
  const buf = Buffer.alloc(samples * channels * 2);
  for (let i = 0; i < samples; i++) {
    const s = Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * amplitude * 32767);
    for (let ch = 0; ch < channels; ch++) buf.writeInt16LE(s, (i * channels + ch) * 2);
  }
  return buf;
}

function pcmToFloat(buf) {
  const out = new Float32Array(buf.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
  return out;
}

/** RMS error between two PCM buffers (same length), relative to full scale. */
function rmsError(a, b) {
  assert.equal(a.length, b.length, 'PCM lengths must match for RMS comparison');
  const fa = pcmToFloat(a);
  const fb = pcmToFloat(b);
  let sum = 0;
  for (let i = 0; i < fa.length; i++) sum += (fa[i] - fb[i]) ** 2;
  return Math.sqrt(sum / fa.length);
}

function encodeAll(encoder, pcm, frameSamples) {
  const frameBytes = frameSamples * encoder.channels * 2;
  const packets = [];
  for (let off = 0; off + frameBytes <= pcm.length; off += frameBytes) {
    packets.push(encoder.encode(pcm.subarray(off, off + frameBytes), frameSamples));
  }
  return packets;
}

function decodeAll(decoder, packets, frameSamples) {
  return Buffer.concat(packets.map((p) => decoder.decode(p, frameSamples)));
}

// The decoded stream is delayed by the encoder's lookahead (`preSkip`
// samples per channel — 120 at 48 kHz for CELT/Hybrid, 312 for SILK-only;
// see `opusPreSkip` in lib/wrapper.js), and the tail of the input only
// comes out after a flush frame. A round-trip comparison must therefore
// encode one extra silent frame, drop the first `preSkip` samples of the
// decoded output, and compare the rest against the original. Comparing the
// raw decoded bytes to the input is a test bug, not a codec bug.
function roundTrip(encoder, pcm, frameSamples) {
  const frameBytes = frameSamples * encoder.channels * 2;
  const packets = encodeAll(encoder, pcm, frameSamples);
  packets.push(encoder.encode(Buffer.alloc(frameBytes), frameSamples)); // flush
  const decoded = decodeAll(encoder, packets, frameSamples);
  const skipBytes = encoder.preSkip * encoder.channels * 2;
  const aligned = decoded.subarray(skipBytes, skipBytes + pcm.length);
  assert.equal(aligned.length, pcm.length, 'aligned decoded length matches input');
  return { packets, decoded: aligned };
}

test('round-trip 48kHz stereo 20ms: sample counts and low error', () => {
  const enc = new OpusEncoder(48000, 2);
  const pcm = sinePcm({ seconds: 1 });
  const { packets, decoded } = roundTrip(enc, pcm, 960);
  assert.equal(packets.length, 51, '1s at 20ms frames = 50 packets + 1 flush frame');
  for (const p of packets) assert.ok(p.length >= 2 && p.length <= 1276, `packet size ${p.length} in range`);
  const err = rmsError(pcm, decoded);
  assert.ok(err < 0.05, `round-trip RMS error ${err} < 0.05`);
});

test('round-trip 48kHz mono, and OpusDecoder class', () => {
  const enc = new OpusEncoder(48000, 1);
  const dec = new OpusDecoder(48000, 1);
  const pcm = sinePcm({ channels: 1, seconds: 1 });
  const packets = encodeAll(enc, pcm, 960);
  packets.push(enc.encode(Buffer.alloc(960 * 2), 960)); // flush
  const decodedAll = decodeAll(dec, packets, 960);
  const skip = enc.preSkip * 2;
  const decoded = decodedAll.subarray(skip, skip + pcm.length);
  assert.equal(decoded.length, pcm.length);
  assert.ok(rmsError(pcm, decoded) < 0.05);
});

test('all supported sample rates round-trip', () => {
  for (const rate of SUPPORTED_SAMPLE_RATES) {
    const frame = rate / 50; // 20 ms
    const enc = new OpusEncoder(rate, 1);
    const pcm = sinePcm({ rate, channels: 1, seconds: 1 });
    const { packets, decoded } = roundTrip(enc, pcm, frame);
    assert.equal(packets.length, 51, `${rate} Hz: 50 packets + flush`);
    assert.ok(rmsError(pcm, decoded) < 0.08, `${rate} Hz: RMS error`);
  }
});

test('frame sizes 10/20/40/60ms round-trip', () => {
  // 1.2 s: divisible by every frame size here (1 s is not divisible by 60 ms,
  // which would leave a partial frame unencoded and fail the comparison).
  for (const ms of [10, 20, 40, 60]) {
    const frame = (48000 * ms) / 1000;
    const enc = new OpusEncoder(48000, 2);
    const pcm = sinePcm({ seconds: 1.2 });
    const { decoded } = roundTrip(enc, pcm, frame);
    assert.ok(rmsError(pcm, decoded) < 0.06, `${ms} ms: RMS error`);
  }
});

test('frame size is inferred from the PCM buffer when omitted', () => {
  const enc = new OpusEncoder(48000, 2);
  const frame = sinePcm({ seconds: 0.02 }); // exactly one 20 ms frame
  const packet = enc.encode(frame);
  assert.ok(packet.length > 2);
  const pcm = enc.decode(packet); // frame size inferred from TOC
  assert.equal(pcm.length, frame.length);
});

test('packetFrameSize matches the TOC: 20ms stereo packet -> 960', () => {
  const enc = new OpusEncoder(48000, 2);
  const packet = enc.encode(sinePcm({ seconds: 0.02 }));
  assert.equal(packetFrameSize(packet, 48000), 960);
});

test('encodeInto / decodeInto reuse buffers and match the allocating path', () => {
  // Encoder/decoder state advances on every frame, so the two paths must be
  // compared on fresh codecs with identical settings — not on one codec
  // used twice, where the second call is a different frame in the stream.
  const pcm = sinePcm({ seconds: 0.02 });
  const encA = new OpusEncoder(48000, 2);
  const encB = new OpusEncoder(48000, 2);
  const outPacket = Buffer.alloc(1276);
  const n = encA.encodeInto(pcm, outPacket);
  assert.ok(n >= 2 && n <= 1276);
  assert.deepEqual(outPacket.subarray(0, n), encB.encode(pcm));

  const decA = new OpusDecoder(48000, 2);
  const decB = new OpusDecoder(48000, 2);
  const outPcm = Buffer.alloc(960 * 2 * 2);
  const m = decA.decodeInto(outPacket.subarray(0, n), outPcm);
  assert.equal(m, 960 * 2 * 2);
  assert.deepEqual(outPcm, decB.decode(outPacket.subarray(0, n)));
});

test('Uint8Array input works (no Buffer required)', () => {
  const enc = new OpusEncoder(48000, 1);
  const pcm = new Uint8Array(sinePcm({ channels: 1, seconds: 0.02 }));
  const packet = enc.encode(pcm);
  const decoded = enc.decode(new Uint8Array(packet));
  assert.equal(decoded.length, 960 * 2);
});

test('invalid rate / channels / frame size throw', () => {
  assert.throws(() => new OpusEncoder(44100, 2), /sample rate/);
  assert.throws(() => new OpusEncoder(48000, 3), /channel/);
  assert.throws(() => new OpusEncoder(48000, 0), /channel/);
  const enc = new OpusEncoder(48000, 2);
  // 100 samples is not a valid Opus frame size at 48 kHz.
  assert.throws(() => enc.encode(Buffer.alloc(100 * 2 * 2), 100), /frame size|Invalid/);
  // Odd-length PCM buffer.
  assert.throws(() => enc.encode(Buffer.alloc(101)), /frame size|whole number|even/);
});

test('garbage packet fails decode instead of crashing', () => {
  const enc = new OpusEncoder(48000, 2);
  assert.throws(() => enc.decode(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), 960), /opus error/);
});

test('packet-loss concealment returns a full frame', () => {
  const enc = new OpusEncoder(48000, 2);
  const pcm = sinePcm({ seconds: 0.1 });
  encodeAll(enc, pcm, 960); // prime the decoder state
  const concealed = enc.decodePacketLoss(960);
  assert.equal(concealed.length, 960 * 2 * 2);
  assert.ok(pcmToFloat(concealed).every((v) => Number.isFinite(v)));
  // The stream continues after the concealed frame.
  const packets2 = encodeAll(enc, sinePcm({ seconds: 0.02 }), 960);
  assert.equal(enc.decode(packets2[0], 960).length, 960 * 2 * 2);
});

test('in-band FEC: decodeFec recovers the lost frame', () => {
  const enc = new OpusEncoder(48000, 1, { fec: true, packetLoss: 10 });
  const pcm = sinePcm({ channels: 1, seconds: 0.2 });
  const packets = encodeAll(enc, pcm, 960);
  assert.ok(packets.length >= 3);
  // Decode packet 0, "lose" packet 1, recover it from packet 2's LBRR.
  enc.decode(packets[0], 960);
  const recovered = enc.decodeFec(packets[2], 960);
  assert.equal(recovered.length, 960 * 2);
  // Then decode packet 2 normally to continue the stream.
  const next = enc.decode(packets[2], 960);
  assert.equal(next.length, 960 * 2);
});

test('settings: bitrate, FEC, PLP, complexity, CBR, DTX, bandwidth, signal, CTL', () => {
  const enc = new OpusEncoder(48000, 2);
  assert.equal(enc.getBitrate(), 64000);
  enc.setBitrate(32000);
  assert.equal(enc.getBitrate(), 32000);
  enc.setFEC(true);
  enc.setPLP(20);
  enc.setComplexity(5);
  enc.setCBR(true);
  enc.setDTX(true);
  enc.setBandwidth('wideband');
  enc.setSignal('voice');
  enc.setMaxBandwidth('fullband');
  enc.setLsbDepth(16);
  // Still encodes after all the settings.
  const packet = enc.encode(sinePcm({ seconds: 0.02 }));
  assert.ok(packet.length > 2);
  // CTL passthrough: OPUS_SET_BITRATE (4002).
  enc.applyEncoderCTL(4002, 48000);
  assert.equal(enc.getBitrate(), 48000);
  // OPUS_SET_COMPLEXITY (4010) and OPUS_SET_INBAND_FEC (4012).
  enc.applyEncoderCTL(4010, 7);
  enc.applyEncoderCTL(4012, 1);
  // Unknown CTL throws; decoder CTLs are unsupported by rusty-opus.
  assert.throws(() => enc.applyEncoderCTL(9999, 1), /unsupported encoder CTL/);
  assert.throws(() => enc.applyDecoderCTL(4002, 1), /unsupported decoder CTL/);
  // Invalid values throw.
  assert.throws(() => enc.setComplexity(11), /complexity/);
  assert.throws(() => enc.setPLP(101), /packet_loss/);
  assert.throws(() => new OpusEncoder(48000, 2, { application: 'nope' }), /application/);
  assert.throws(() => new OpusEncoder(48000, 2, { bandwidth: 'nope' }), /bandwidth/);
});

test('applications: voip / audio / lowDelay all encode', () => {
  for (const application of ['voip', 'audio', 'lowDelay']) {
    const enc = new OpusEncoder(48000, 2, { application });
    assert.equal(enc.application, application);
    const packet = enc.encode(sinePcm({ seconds: 0.02 }));
    assert.ok(packet.length > 2, `${application}: packet produced`);
  }
});

test('finalRange / lastRange are stable u32s after a frame', () => {
  const enc = new OpusEncoder(48000, 2);
  const packet = enc.encode(sinePcm({ seconds: 0.02 }));
  assert.equal(typeof enc.finalRange(), 'number');
  enc.decode(packet);
  assert.equal(typeof enc.lastRange(), 'number');
});

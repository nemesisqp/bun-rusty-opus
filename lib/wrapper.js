'use strict';

/**
 * JS wrapper — the @discordjs/opus-compatible surface over the native
 * rusty-opus binding.
 *
 * `OpusEncoder` mirrors @discordjs/opus exactly (one class that encodes
 * AND decodes, `new OpusEncoder(rate, channels)`, `encode`/`decode` on
 * s16le PCM Buffers), so it is a drop-in replacement for prism-media /
 * discord.js voice. Extra rusty-opus features are additive:
 * an `options` argument on the constructor, `encodeInto`/`decodeInto`
 * (zero-alloc reuse), `OpusDecoder`, FEC and packet-loss concealment.
 *
 * All PCM here is signed 16-bit little-endian, interleaved, exactly like
 * @discordjs/opus. The i16 <-> f32 conversion happens inside Rust.
 */

const { loadNative } = require('./loader');

const native = loadNative();
const { createOpus } = native;

const SUPPORTED_SAMPLE_RATES = [8000, 12000, 16000, 24000, 48000];
const FRAME_DURATIONS_MS = [2.5, 5, 10, 20, 40, 60, 80, 100, 120];

const OPUS_APPLICATIONS = Object.freeze({ voip: 2048, audio: 2049, lowDelay: 2051 });
const OPUS_BANDWIDTHS = Object.freeze({
  auto: -1000, narrowband: 1101, mediumband: 1102, wideband: 1103, superwideband: 1104, fullband: 1105,
});
const OPUS_SIGNALS = Object.freeze({ auto: 0, voice: 1, music: 2 });
/** libopus `opus_encoder_ctl` codes the native layer understands. */
const OPUS_CTL = Object.freeze({
  SET_APPLICATION: 4000,
  SET_BITRATE: 4002,
  SET_VBR: 4006,
  SET_BANDWIDTH: 4008,
  SET_MAX_BANDWIDTH: 4009,
  SET_COMPLEXITY: 4010,
  SET_INBAND_FEC: 4012,
  SET_PACKET_LOSS_PERC: 4014,
  SET_DTX: 4016,
  SET_SIGNAL: 4024,
  SET_LSB_DEPTH: 4036,
  // libopus signal values for OPUS_SET_SIGNAL (4024):
  SIGNAL_AUTO: -1000,
  SIGNAL_VOICE: 3001,
  SIGNAL_MUSIC: 3002,
});

/** Frame duration (ms) per Opus TOC config 0-31 (RFC 6716 §3.1). */
const TOC_DURATIONS_MS = [
  10, 20, 40, 60, // SILK NB
  10, 20, 40, 60, // SILK MB
  10, 20, 40, 60, // SILK WB
  10, 20, // Hybrid SWB
  10, 20, // Hybrid FB
  2.5, 5, 10, 20, // CELT NB
  2.5, 5, 10, 20, // CELT WB
  2.5, 5, 10, 20, // CELT SWB
  2.5, 5, 10, 20, // CELT FB
];

function toBuffer(view, name) {
  if (Buffer.isBuffer(view)) return view;
  if (view instanceof Uint8Array) {
    // View over the same memory — no copy.
    return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
  }
  throw new TypeError(`${name} must be a Buffer or Uint8Array`);
}

function validFrameSizes(rate) {
  return FRAME_DURATIONS_MS.map((ms) => (rate * ms) / 1000);
}

function assertRate(rate) {
  if (!SUPPORTED_SAMPLE_RATES.includes(rate)) {
    throw new RangeError(
      `unsupported sample rate ${rate}: Opus supports only ${SUPPORTED_SAMPLE_RATES.join(', ')} Hz`,
    );
  }
}

function assertChannels(channels) {
  if (channels !== 1 && channels !== 2) {
    throw new RangeError(`unsupported channel count ${channels}: Opus supports only 1 or 2 channels`);
  }
}

function inferEncodeFrameSize(pcm, rate, channels) {
  if (pcm.length % (2 * channels) !== 0) {
    throw new RangeError(
      `PCM buffer length ${pcm.length} is not a whole number of frames for ${channels} channel(s)`,
    );
  }
  const frameSize = pcm.length / (2 * channels);
  if (!validFrameSizes(rate).includes(frameSize)) {
    throw new RangeError(
      `invalid frame size ${frameSize} samples at ${rate} Hz: valid sizes are ${validFrameSizes(rate).join(', ')} ` +
        `(2.5/5/10/20/40/60/80/100/120 ms)`,
    );
  }
  return frameSize;
}

/**
 * Infer the total output frame size (samples per channel) of an Opus
 * packet from its TOC byte — the same information libopus reads in
 * `opus_packet_get_nb_frames` / `opus_packet_get_samples_per_frame`.
 */
function packetFrameSize(packet, rate) {
  if (packet.length < 1) throw new RangeError('cannot infer frame size from an empty Opus packet');
  const toc = packet[0];
  const config = (toc >> 3) & 0x1f;
  const frameCountCode = toc & 0x03;
  let frames;
  if (frameCountCode === 0) frames = 1;
  else if (frameCountCode === 1 || frameCountCode === 2) frames = 2;
  else {
    if (packet.length < 2) throw new RangeError('malformed Opus packet: frame-count byte missing');
    frames = packet[1] & 0x3f;
  }
  const perFrame = (rate * TOC_DURATIONS_MS[config]) / 1000;
  return perFrame * frames;
}

/**
 * End-to-end encoder delay (pre-skip), in samples per channel.
 *
 * Measured by cross-correlating a chirp through encode -> decode (see
 * docs/PERFORMANCE.md): rusty-opus does NOT pad its output to libopus's
 * uniform 312 samples. Its delay follows the coding mode, exactly as the
 * mode decision in rusty-opus `OpusEncoder::new`:
 * - SILK-only (voip/audio at <= 16 kHz): 312 samples at 48 kHz, scaled by rate.
 * - CELT-only / Hybrid (lowDelay at any rate; voip/audio above 16 kHz):
 *   120 samples at 48 kHz, scaled by rate.
 *
 * This is the value an Ogg OpusHead must carry as pre-skip for streams
 * encoded here — writing libopus's 312 for a 48 kHz CELT/Hybrid stream
 * would trim 192 real samples (~4 ms) off the start of the audio.
 * Forcing a SILK-only bandwidth at a high rate can change the mode and
 * therefore the delay; the value here is for the default mode decision.
 */
function opusPreSkip(rate, application) {
  const silkOnly = rate <= 16000 && application !== 'lowDelay';
  return Math.round((rate * (silkOnly ? 312 : 120)) / 48000);
}

function resolveApplication(application) {
  if (application === undefined || application === null) return { name: 'audio', code: 2049 };
  if (typeof application === 'string') {
    const key = application === 'low-delay' || application === 'lowdelay' ? 'lowDelay' : application;
    if (key in OPUS_APPLICATIONS) return { name: key, code: OPUS_APPLICATIONS[key] };
    throw new RangeError(`unknown application ${JSON.stringify(application)}: use 'voip', 'audio' or 'lowDelay'`);
  }
  throw new TypeError(`application must be a string ('voip' | 'audio' | 'lowDelay'), got ${typeof application}`);
}

function resolveBandwidth(name, label) {
  if (name === undefined || name === null) return null;
  if (typeof name === 'string' && name in OPUS_BANDWIDTHS) return OPUS_BANDWIDTHS[name];
  if (typeof name === 'number' && Object.values(OPUS_BANDWIDTHS).includes(name)) return name;
  throw new RangeError(`unknown ${label} ${JSON.stringify(name)}: use ${Object.keys(OPUS_BANDWIDTHS).join(', ')}`);
}

function resolveSignal(name) {
  if (name === undefined || name === null) return 0;
  if (typeof name === 'string' && name in OPUS_SIGNALS) return OPUS_SIGNALS[name];
  throw new RangeError(`unknown signal ${JSON.stringify(name)}: use 'auto', 'voice' or 'music'`);
}

function createNative(rate, channels, options = {}) {
  const opts = typeof options === 'string' ? { application: options } : options;
  if (opts === null || typeof opts !== 'object') throw new TypeError('options must be an object');
  const app = resolveApplication(opts.application);
  const bitrate = opts.bitrate ?? 64000;
  const complexity = opts.complexity ?? 9;
  const useCbr = opts.cbr ?? opts.useCbr ?? false;
  const useFec = opts.fec ?? opts.useFec ?? false;
  const useDtx = opts.dtx ?? opts.useDtx ?? false;
  const packetLoss = opts.packetLoss ?? opts.packetLossPerc ?? 0;
  // s16-sourced content: rusty-opus's float default is 24, but 16 matches
  // opus_demo parity for s16 input (see docs/research-rusty-opus.md).
  const lsbDepth = opts.lsbDepth ?? 16;
  // createOpus is a free napi function: construction is fallible, and napi
  // constructors must return Self directly, so creation lives there.
  const codec = createOpus({
    rate, channels, application: app.code, bitrate, complexity, useCbr, useFec, useDtx, packetLoss, lsbDepth,
  });
  const bandwidth = resolveBandwidth(opts.bandwidth, 'bandwidth');
  if (bandwidth !== null && bandwidth !== -1000) codec.setBandwidth(bandwidth);
  const maxBandwidth = resolveBandwidth(opts.maxBandwidth, 'maxBandwidth');
  if (maxBandwidth !== null) codec.setMaxBandwidth(maxBandwidth);
  codec.setSignal(resolveSignal(opts.signal));
  return { codec, application: app.name };
}

/**
 * @discordjs/opus-compatible encoder/decoder.
 *
 * ```js
 * const { OpusEncoder } = require('bun-rusty-opus');
 * const encoder = new OpusEncoder(48000, 2); // rate, channels
 * const packet = encoder.encode(pcmBuffer);   // 20 ms s16le frame -> Opus
 * const pcm = encoder.decode(packet);         // Opus packet -> s16le PCM
 * ```
 */
class OpusEncoder {
  constructor(rate = 48000, channels = 2, options = {}) {
    assertRate(rate);
    assertChannels(channels);
    const { codec, application } = createNative(rate, channels, options);
    this._native = codec;
    this._rate = rate;
    this._channels = channels;
    this._application = application;
  }

  get rate() { return this._rate; }
  get channels() { return this._channels; }
  get application() { return this._application; }
  /** End-to-end encoder delay in samples per channel — the Ogg pre-skip for streams encoded here. See `opusPreSkip`. */
  get preSkip() { return opusPreSkip(this._rate, this._application); }

  /** Encode one s16le PCM frame -> one Opus packet. `frameSize` in samples per channel; inferred from the buffer length when omitted. */
  encode(pcm, frameSize) {
    const buf = toBuffer(pcm, 'pcm');
    const frame = frameSize ?? inferEncodeFrameSize(buf, this._rate, this._channels);
    return this._native.encode(buf, frame);
  }

  /**
   * Encode into a caller-provided output buffer. Returns bytes written.
   * No Buffer is allocated per frame — the hot path for 50 frames/sec.
   * `out` must hold at least 1276 bytes (max Opus packet) to be safe.
   */
  encodeInto(pcm, out, frameSize) {
    const buf = toBuffer(pcm, 'pcm');
    const outBuf = toBuffer(out, 'out');
    const frame = frameSize ?? inferEncodeFrameSize(buf, this._rate, this._channels);
    return this._native.encodeInto(buf, outBuf, frame);
  }

  /** Decode one Opus packet -> s16le PCM. `frameSize` inferred from the packet TOC when omitted. */
  decode(packet, frameSize) {
    const buf = toBuffer(packet, 'packet');
    const frame = frameSize ?? packetFrameSize(buf, this._rate);
    return this._native.decode(buf, frame);
  }

  /** Decode into a caller-provided PCM buffer. Returns PCM bytes written. */
  decodeInto(packet, out, frameSize) {
    const buf = toBuffer(packet, 'packet');
    const outBuf = toBuffer(out, 'out');
    const frame = frameSize ?? packetFrameSize(buf, this._rate);
    return this._native.decodeInto(buf, outBuf, frame);
  }

  /** Reconstruct a lost frame from the in-band FEC (LBRR) in the *next* packet. `frameSize` is required. */
  decodeFec(packet, frameSize) {
    if (frameSize === undefined || frameSize === null) {
      throw new RangeError('decodeFec requires frameSize (samples per channel of the lost frame)');
    }
    return this._native.decodeFec(toBuffer(packet, 'packet'), frameSize);
  }

  /** Packet-loss concealment: synthesise `frameSize` samples per channel for a lost frame. */
  decodePacketLoss(frameSize) {
    if (frameSize === undefined || frameSize === null) {
      throw new RangeError('decodePacketLoss requires frameSize (samples per channel)');
    }
    return this._native.decodePlc(frameSize);
  }

  setBitrate(bitrate) { this._native.setBitrate(bitrate); }
  getBitrate() { return this._native.getBitrate(); }
  setFEC(enabled) { this._native.setFec(Boolean(enabled)); }
  /** Expected packet loss, 0-100 (%). Alias of setPacketLoss. */
  setPLP(percentage) { this._native.setPacketLoss(percentage); }
  setPacketLoss(percentage) { this._native.setPacketLoss(percentage); }
  setComplexity(complexity) { this._native.setComplexity(complexity); }
  setCBR(enabled) { this._native.setCbr(Boolean(enabled)); }
  setDTX(enabled) { this._native.setDtx(Boolean(enabled)); }
  setBandwidth(bandwidth) {
    const code = resolveBandwidth(bandwidth, 'bandwidth');
    if (code === -1000 || code === null) this._native.clearBandwidth();
    else this._native.setBandwidth(code);
  }
  setMaxBandwidth(bandwidth) { this._native.setMaxBandwidth(resolveBandwidth(bandwidth, 'maxBandwidth')); }
  setSignal(signal) { this._native.setSignal(resolveSignal(signal)); }
  setLsbDepth(depth) { this._native.setLsbDepth(depth); }

  /** Raw `opus_encoder_ctl` passthrough for the codes in `OPUS_CTL`. Unsupported codes throw. */
  applyEncoderCTL(ctl, value) { this._native.applyEncoderCtl(ctl, value); }
  /** rusty-opus exposes no decoder controls — this always throws. Kept for @discordjs/opus API parity. */
  applyDecoderCTL(ctl, value) { this._native.applyDecoderCtl(ctl, value); }

  /** Final range-coder state of the last encoded packet (OPUS_GET_FINAL_RANGE). */
  finalRange() { return this._native.finalRange(); }
  /** Final range-decoder state of the last decoded packet. */
  lastRange() { return this._native.lastRange(); }
}

/** Decode-only codec. Same decoder as `OpusEncoder`, without an encoder. */
class OpusDecoder {
  constructor(rate = 48000, channels = 2) {
    assertRate(rate);
    assertChannels(channels);
    const { codec } = createNative(rate, channels, {});
    this._native = codec;
    this._rate = rate;
    this._channels = channels;
  }

  get rate() { return this._rate; }
  get channels() { return this._channels; }

  decode(packet, frameSize) {
    const buf = toBuffer(packet, 'packet');
    const frame = frameSize ?? packetFrameSize(buf, this._rate);
    return this._native.decode(buf, frame);
  }

  decodeInto(packet, out, frameSize) {
    const buf = toBuffer(packet, 'packet');
    const outBuf = toBuffer(out, 'out');
    const frame = frameSize ?? packetFrameSize(buf, this._rate);
    return this._native.decodeInto(buf, outBuf, frame);
  }

  decodeFec(packet, frameSize) {
    if (frameSize === undefined || frameSize === null) {
      throw new RangeError('decodeFec requires frameSize (samples per channel of the lost frame)');
    }
    return this._native.decodeFec(toBuffer(packet, 'packet'), frameSize);
  }

  decodePacketLoss(frameSize) {
    if (frameSize === undefined || frameSize === null) {
      throw new RangeError('decodePacketLoss requires frameSize (samples per channel)');
    }
    return this._native.decodePlc(frameSize);
  }

  lastRange() { return this._native.lastRange(); }
}

module.exports = {
  OpusEncoder,
  OpusDecoder,
  SUPPORTED_SAMPLE_RATES,
  FRAME_DURATIONS_MS,
  OPUS_APPLICATIONS,
  OPUS_BANDWIDTHS,
  OPUS_SIGNALS,
  OPUS_CTL,
  packetFrameSize,
  opusPreSkip,
};

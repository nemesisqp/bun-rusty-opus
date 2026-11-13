/**
 * @ndqp/bun-rusty-opus — Bun/Node bindings to rusty-opus (pure-Rust Opus codec).
 *
 * `OpusEncoder` mirrors @discordjs/opus: one class that encodes AND decodes,
 * s16le PCM Buffers in and out. See README.md for the full API.
 *
 * NOTE: this is the hand-written public type definition. The napi-rs
 * generated types for the raw native binding live in lib/binding.d.ts.
 */

export type OpusApplication = 'voip' | 'audio' | 'lowDelay';
export type OpusBandwidth = 'auto' | 'narrowband' | 'mediumband' | 'wideband' | 'superwideband' | 'fullband';
export type OpusSignal = 'auto' | 'voice' | 'music';

export interface OpusEncoderOptions {
  /** 'voip' (speech), 'audio' (music/general, default), 'lowDelay' (CELT only). */
  application?: OpusApplication;
  /** Target bitrate in bits/sec. Default 64000. */
  bitrate?: number;
  /** Complexity 0 (fastest) to 10 (best quality). Default 9. */
  complexity?: number;
  /** Constant bitrate. Default false (VBR). */
  cbr?: boolean;
  /** @deprecated Use `cbr`. */
  useCbr?: boolean;
  /** In-band forward error correction (SILK LBRR). Default false. */
  fec?: boolean;
  /** @deprecated Use `fec`. */
  useFec?: boolean;
  /** Discontinuous transmission. Default false. */
  dtx?: boolean;
  /** @deprecated Use `dtx`. */
  useDtx?: boolean;
  /** Expected packet loss, 0-100 (%). Default 0. */
  packetLoss?: number;
  /** @deprecated Use `packetLoss`. */
  packetLossPerc?: number;
  /** Input bit depth assumed by the analysis (16 for s16 source, default). */
  lsbDepth?: number;
  /** Force an audio bandwidth, or 'auto' (default). */
  bandwidth?: OpusBandwidth;
  /** Cap the automatically selected bandwidth. Default 'fullband'. */
  maxBandwidth?: OpusBandwidth;
  /** Voice/music bias, or 'auto' (default). */
  signal?: OpusSignal;
}

/**
 * @discordjs/opus-compatible encoder/decoder.
 *
 * ```ts
 * import { OpusEncoder } from '@ndqp/bun-rusty-opus';
 * const encoder = new OpusEncoder(48000, 2);
 * const packet = encoder.encode(pcmBuffer); // 20 ms s16le frame -> Opus
 * const pcm = encoder.decode(packet);
 * ```
 */
export declare class OpusEncoder {
  constructor(rate?: number, channels?: number, options?: OpusEncoderOptions | OpusApplication);
  readonly rate: number;
  readonly channels: number;
  readonly application: OpusApplication;
  /**
   * End-to-end encoder delay in samples per channel — the Ogg OpusHead
   * pre-skip for streams encoded here. 120 at 48 kHz for CELT/Hybrid,
   * 312 (scaled by rate) for SILK-only modes. See `opusPreSkip`.
   */
  readonly preSkip: number;

  /** Encode one s16le PCM frame -> one Opus packet. `frameSize` in samples per channel; inferred from the buffer length when omitted. */
  encode(pcm: Buffer | Uint8Array, frameSize?: number): Buffer;
  /**
   * Encode into a caller-provided output buffer. Returns bytes written.
   * No Buffer is allocated per frame. `out` should hold at least 1276 bytes.
   */
  encodeInto(pcm: Buffer | Uint8Array, out: Buffer | Uint8Array, frameSize?: number): number;
  /** Decode one Opus packet -> s16le PCM. `frameSize` inferred from the packet TOC when omitted. */
  decode(packet: Buffer | Uint8Array, frameSize?: number): Buffer;
  /** Decode into a caller-provided PCM buffer. Returns PCM bytes written. */
  decodeInto(packet: Buffer | Uint8Array, out: Buffer | Uint8Array, frameSize?: number): number;
  /** Reconstruct a lost frame from the in-band FEC (LBRR) in the *next* packet. `frameSize` is required. */
  decodeFec(packet: Buffer | Uint8Array, frameSize: number): Buffer;
  /** Packet-loss concealment: synthesise `frameSize` samples per channel for a lost frame. */
  decodePacketLoss(frameSize: number): Buffer;

  setBitrate(bitrate: number): void;
  getBitrate(): number;
  setFEC(enabled: boolean): void;
  /** Expected packet loss, 0-100 (%). */
  setPLP(percentage: number): void;
  setPacketLoss(percentage: number): void;
  setComplexity(complexity: number): void;
  setCBR(enabled: boolean): void;
  setDTX(enabled: boolean): void;
  setBandwidth(bandwidth: OpusBandwidth): void;
  setMaxBandwidth(bandwidth: OpusBandwidth): void;
  setSignal(signal: OpusSignal): void;
  setLsbDepth(depth: number): void;
  /** Raw `opus_encoder_ctl` passthrough for the codes in `OPUS_CTL`. Unsupported codes throw. */
  applyEncoderCTL(ctl: number, value: number): void;
  /** rusty-opus exposes no decoder controls — this always throws. Kept for @discordjs/opus API parity. */
  applyDecoderCTL(ctl: number, value: number): void;
  /** Final range-coder state of the last encoded packet (OPUS_GET_FINAL_RANGE). */
  finalRange(): number;
  /** Final range-decoder state of the last decoded packet. */
  lastRange(): number;
}

/** Decode-only codec. Same decoder as `OpusEncoder`, without an encoder. */
export declare class OpusDecoder {
  constructor(rate?: number, channels?: number);
  readonly rate: number;
  readonly channels: number;
  decode(packet: Buffer | Uint8Array, frameSize?: number): Buffer;
  decodeInto(packet: Buffer | Uint8Array, out: Buffer | Uint8Array, frameSize?: number): number;
  decodeFec(packet: Buffer | Uint8Array, frameSize: number): Buffer;
  decodePacketLoss(frameSize: number): Buffer;
  lastRange(): number;
}

export declare const SUPPORTED_SAMPLE_RATES: readonly [8000, 12000, 16000, 24000, 48000];
export declare const FRAME_DURATIONS_MS: readonly number[];
export declare const OPUS_APPLICATIONS: Readonly<{ voip: 2048; audio: 2049; lowDelay: 2051 }>;
export declare const OPUS_BANDWIDTHS: Readonly<{
  auto: -1000;
  narrowband: 1101;
  mediumband: 1102;
  wideband: 1103;
  superwideband: 1104;
  fullband: 1105;
}>;
export declare const OPUS_SIGNALS: Readonly<{ auto: 0; voice: 1; music: 2 }>;
export declare const OPUS_CTL: Readonly<{
  SET_APPLICATION: 4000;
  SET_BITRATE: 4002;
  SET_VBR: 4006;
  SET_BANDWIDTH: 4008;
  SET_MAX_BANDWIDTH: 4009;
  SET_COMPLEXITY: 4010;
  SET_INBAND_FEC: 4012;
  SET_PACKET_LOSS_PERC: 4014;
  SET_DTX: 4016;
  SET_SIGNAL: 4024;
  SET_LSB_DEPTH: 4036;
  SIGNAL_AUTO: -1000;
  SIGNAL_VOICE: 3001;
  SIGNAL_MUSIC: 3002;
}>;

/** Infer the total output frame size (samples per channel) of an Opus packet from its TOC byte. */
export declare function packetFrameSize(packet: Buffer | Uint8Array, rate: number): number;

/**
 * End-to-end encoder delay (pre-skip), in samples per channel, for the
 * given rate and application. SILK-only (voip/audio at <= 16 kHz) is
 * `round(rate * 312 / 48000)`; CELT/Hybrid is `round(rate * 120 / 48000)`.
 * Unlike libopus, rusty-opus does not pad its output to a uniform 312 —
 * use this value as the Ogg OpusHead pre-skip for streams encoded here.
 */
export declare function opusPreSkip(rate: number, application: OpusApplication): number;

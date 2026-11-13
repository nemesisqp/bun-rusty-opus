//! N-API binding from `rusty-opus` (pure-Rust Opus codec) to Node.js / Bun.
//!
//! Design — keep the 1.5x speedup across the JS/Rust boundary:
//!
//! * **Pass buffers by reference.** Inputs arrive as [`BufferSlice`], a
//!   zero-copy view of the caller's `Buffer`/`Uint8Array` — never a `Vec`
//!   copied per 20 ms frame. Outputs for the `*_into` methods are written
//!   straight into a caller-provided buffer the same way.
//! * **Reuse output buffers.** The `f32` scratch buffers live on the struct
//!   and only grow (never shrink, never re-allocate per frame). The codec
//!   itself also stops allocating after warm-up (see rusty-opus docs).
//! * **i16 <-> f32 conversion is done here, in Rust.** `rusty-opus` 1.0.2 is
//!   f32-only (no `encode_i16`/`decode_i16`); a JS conversion loop would
//!   cost more than the codec itself on small frames. The loops below are
//!   plain and auto-vectorise.
//! * **Sync only.** No threadsafe functions, no async work — the surface
//!   Bun had N-API crashes with in the past is avoided entirely.
//!
//! The JS wrapper (`lib/wrapper.js`) owns all defaults, validation and
//! frame-size inference; this layer takes only primitives so the N-API
//! surface stays small and fast.

use napi::bindgen_prelude::{Buffer, BufferSlice};
use napi::{Error as NapiError, Result, Status};
use napi_derive::napi;
use rusty_opus::{Application, Bandwidth, OpusDecoder, OpusEncoder, SignalType};

/// Max Opus packet size (RFC 6716), bytes.
const MAX_PACKET_BYTES: usize = 1276;

fn map_err(err: rusty_opus::Error) -> NapiError {
    // libopus-style code is negative; keep it in the message so callers can
    // distinguish BadArg (-1) / BufferTooSmall (-2) / Internal (-3) /
    // InvalidPacket (-4) without parsing the text.
    NapiError::new(
        Status::GenericFailure,
        format!("opus error {}: {}", err.code(), err.message()),
    )
}

fn bad_arg(msg: &str) -> NapiError {
    NapiError::new(Status::InvalidArg, msg.to_string())
}

fn application_from_code(code: u32) -> Result<Application> {
    match code {
        2048 => Ok(Application::Voip),
        2049 => Ok(Application::Audio),
        2051 => Ok(Application::RestrictedLowDelay),
        _ => Err(bad_arg(
            "application must be 2048 (voip), 2049 (audio) or 2051 (low-delay)",
        )),
    }
}

fn bandwidth_from_code(code: i32) -> Result<Bandwidth> {
    match code {
        -1000 => Ok(Bandwidth::Auto),
        1101 => Ok(Bandwidth::Narrowband),
        1102 => Ok(Bandwidth::Mediumband),
        1103 => Ok(Bandwidth::Wideband),
        1104 => Ok(Bandwidth::Superwideband),
        1105 => Ok(Bandwidth::Fullband),
        _ => Err(bad_arg(
            "bandwidth must be -1000 (auto), 1101 (NB), 1102 (MB), 1103 (WB), 1104 (SWB) or 1105 (FB)",
        )),
    }
}

/// `0` = auto, `1` = voice, `2` = music.
fn signal_from_code(code: i32) -> Result<Option<SignalType>> {
    match code {
        0 => Ok(None),
        1 => Ok(Some(SignalType::Voice)),
        2 => Ok(Some(SignalType::Music)),
        _ => Err(bad_arg("signal must be 0 (auto), 1 (voice) or 2 (music)")),
    }
}

#[inline]
fn i16_to_f32(sample: i16) -> f32 {
    sample as f32 / 32768.0
}

#[inline]
fn f32_to_i16(sample: f32) -> i16 {
    // Round to nearest, saturate. Matches the usual float -> s16 conversion
    // (libopus `opus_float_to_short` saturates the same way); bit-exact PCM
    // parity with libopus is not expected anyway — Opus is lossy.
    let v = (sample.clamp(-1.0, 1.0) * 32767.0).round() as i32;
    v.clamp(-32768, 32767) as i16
}

/// One native codec: an encoder and a decoder sharing the same rate/channels.
/// The JS `OpusEncoder` (encode + decode, @discordjs/opus shape) and the JS
/// `OpusDecoder` (decode only) are both thin wrappers over this struct.
#[napi]
pub struct NativeOpus {
    encoder: OpusEncoder,
    decoder: OpusDecoder,
    rate: u32,
    channels: u32,
    /// Reused f32 scratch: encode input (i16 -> f32) and decode output
    /// (f32 -> i16). Grows to the largest frame seen, never shrinks.
    f32_scratch: Vec<f32>,
}

/// Creation options, passed as one JS object to `createOpus` — one argument
/// instead of ten (clippy `too_many_arguments`), and the field names are the
/// contract with `lib/wrapper.js` (`useCbr`, `packetLoss`, `lsbDepth`, ...).
#[napi(object)]
pub struct OpusOptions {
    pub rate: u32,
    pub channels: u32,
    pub application: u32,
    pub bitrate: i32,
    pub complexity: i32,
    pub use_cbr: bool,
    pub use_fec: bool,
    pub use_dtx: bool,
    pub packet_loss: i32,
    pub lsb_depth: i32,
}

/// Plain Rust construction (not exposed to JS). Fallible, so it lives here
/// instead of in a napi constructor/factory, which in napi 3.x must return
/// `Self` directly. The JS entry point is the free function `create_opus`
/// at the bottom of this file.
impl NativeOpus {
    /// `lsb_depth` should be 16 for s16-sourced content (the JS default).
    pub fn new(opts: &OpusOptions) -> Result<Self> {
        if !(0..=10).contains(&opts.complexity) {
            return Err(bad_arg(
                "complexity must be 0 (fastest) to 10 (best quality)",
            ));
        }
        if !(0..=100).contains(&opts.packet_loss) {
            return Err(bad_arg("packet_loss must be 0-100"));
        }
        let app = application_from_code(opts.application)?;
        let mut encoder =
            OpusEncoder::new(opts.rate as i32, opts.channels as usize, app).map_err(map_err)?;
        encoder.bitrate_bps = opts.bitrate;
        encoder.complexity = opts.complexity;
        encoder.use_cbr = opts.use_cbr;
        encoder.use_inband_fec = opts.use_fec;
        encoder.use_dtx = opts.use_dtx;
        encoder.packet_loss_perc = opts.packet_loss;
        encoder.lsb_depth = opts.lsb_depth;
        let decoder =
            OpusDecoder::new(opts.rate as i32, opts.channels as usize).map_err(map_err)?;
        Ok(Self {
            encoder,
            decoder,
            rate: opts.rate,
            channels: opts.channels,
            f32_scratch: Vec::new(),
        })
    }
}

#[napi]
impl NativeOpus {
    #[napi]
    pub fn rate(&self) -> u32 {
        self.rate
    }

    #[napi]
    pub fn channels(&self) -> u32 {
        self.channels
    }

    // -- settings -----------------------------------------------------------

    #[napi]
    pub fn get_bitrate(&self) -> i32 {
        self.encoder.bitrate_bps
    }

    #[napi]
    pub fn set_bitrate(&mut self, bitrate: i32) {
        self.encoder.bitrate_bps = bitrate;
    }

    #[napi]
    pub fn set_complexity(&mut self, complexity: i32) -> Result<()> {
        if !(0..=10).contains(&complexity) {
            return Err(bad_arg(
                "complexity must be 0 (fastest) to 10 (best quality)",
            ));
        }
        self.encoder.complexity = complexity;
        Ok(())
    }

    #[napi]
    pub fn set_cbr(&mut self, enabled: bool) {
        self.encoder.use_cbr = enabled;
    }

    #[napi]
    pub fn set_fec(&mut self, enabled: bool) {
        self.encoder.use_inband_fec = enabled;
    }

    #[napi]
    pub fn set_dtx(&mut self, enabled: bool) {
        self.encoder.use_dtx = enabled;
    }

    #[napi]
    pub fn set_packet_loss(&mut self, percent: i32) -> Result<()> {
        if !(0..=100).contains(&percent) {
            return Err(bad_arg("packet_loss must be 0-100"));
        }
        self.encoder.packet_loss_perc = percent;
        Ok(())
    }

    #[napi]
    pub fn set_bandwidth(&mut self, code: i32) -> Result<()> {
        self.encoder.force_bandwidth = Some(bandwidth_from_code(code)?);
        Ok(())
    }

    #[napi]
    pub fn clear_bandwidth(&mut self) {
        self.encoder.force_bandwidth = None;
    }

    #[napi]
    pub fn set_max_bandwidth(&mut self, code: i32) -> Result<()> {
        self.encoder.max_bandwidth = bandwidth_from_code(code)?;
        Ok(())
    }

    #[napi]
    pub fn set_signal(&mut self, code: i32) -> Result<()> {
        self.encoder.signal_type = signal_from_code(code)?;
        Ok(())
    }

    #[napi]
    pub fn set_lsb_depth(&mut self, depth: i32) {
        self.encoder.lsb_depth = depth;
    }

    /// Raw `opus_encoder_ctl` passthrough for the CTL codes rusty-opus can
    /// express. Unknown / unsupported codes are an error, never silent.
    /// libopus CTL numbers: https://opus-codec.org/docs/opus_api-1.5/group__opus__encoderctls.html
    #[napi]
    pub fn apply_encoder_ctl(&mut self, ctl: i32, value: i32) -> Result<()> {
        match ctl {
            4000 => Err(bad_arg(
                "OPUS_SET_APPLICATION (4000): application is fixed at construction time",
            )),
            4002 => {
                self.encoder.bitrate_bps = value;
                Ok(())
            }
            // OPUS_SET_VBR: 0 = CBR, 1 = VBR.
            4006 => {
                self.encoder.use_cbr = value == 0;
                Ok(())
            }
            4008 => {
                self.encoder.force_bandwidth = Some(bandwidth_from_code(value)?);
                Ok(())
            }
            4009 => {
                self.encoder.max_bandwidth = bandwidth_from_code(value)?;
                Ok(())
            }
            4010 => self.set_complexity(value),
            4012 => {
                self.encoder.use_inband_fec = value != 0;
                Ok(())
            }
            4014 => self.set_packet_loss(value),
            4016 => {
                self.encoder.use_dtx = value != 0;
                Ok(())
            }
            // OPUS_SET_SIGNAL: -1000 auto, 3001 voice, 3002 music.
            4024 => {
                self.encoder.signal_type = match value {
                    -1000 => None,
                    3001 => Some(SignalType::Voice),
                    3002 => Some(SignalType::Music),
                    _ => return Err(bad_arg(
                        "OPUS_SET_SIGNAL value must be -1000 (auto), 3001 (voice) or 3002 (music)",
                    )),
                };
                Ok(())
            }
            4036 => {
                self.encoder.lsb_depth = value;
                Ok(())
            }
            _ => Err(bad_arg(&format!(
                "unsupported encoder CTL {ctl}: rusty-opus has no equivalent"
            ))),
        }
    }

    /// rusty-opus exposes no decoder-side settings (no gain, no CTL), so
    /// every decoder CTL is an explicit error rather than a silent no-op.
    #[napi]
    pub fn apply_decoder_ctl(&mut self, ctl: i32, _value: i32) -> Result<()> {
        Err(bad_arg(&format!(
            "unsupported decoder CTL {ctl}: rusty-opus exposes no decoder controls"
        )))
    }

    #[napi]
    pub fn final_range(&self) -> u32 {
        self.encoder.final_range()
    }

    #[napi]
    pub fn last_range(&self) -> u32 {
        self.decoder.last_range
    }

    // -- encode -------------------------------------------------------------

    fn ensure_f32(&mut self, samples: usize) {
        if self.f32_scratch.len() < samples {
            self.f32_scratch.resize(samples, 0.0);
        }
    }

    /// `frame_size` is samples per channel; `0` infers it from the input
    /// length (`input.len() / (channels * 2)`).
    #[napi]
    pub fn encode(&mut self, input: BufferSlice, frame_size: u32) -> Result<Buffer> {
        let channels = self.channels as usize;
        let frame = if frame_size == 0 {
            input.len() / (channels * 2)
        } else {
            frame_size as usize
        };
        let needed = frame
            .checked_mul(channels)
            .ok_or_else(|| bad_arg("frame_size overflow"))?;
        if input.len() < needed * 2 {
            return Err(bad_arg(&format!(
                "input buffer too short: need {} bytes for a {}-sample frame, got {}",
                needed * 2,
                frame,
                input.len()
            )));
        }
        if input.len() % 2 != 0 {
            return Err(bad_arg(
                "input PCM buffer must have an even byte length (s16le)",
            ));
        }
        self.ensure_f32(needed);
        for (i, chunk) in input[..needed * 2].chunks_exact(2).enumerate() {
            self.f32_scratch[i] = i16_to_f32(i16::from_le_bytes([chunk[0], chunk[1]]));
        }
        // Stack packet buffer: max Opus packet is 1276 bytes, no heap alloc.
        let mut packet = [0u8; MAX_PACKET_BYTES];
        let n = self
            .encoder
            .encode(&self.f32_scratch[..needed], frame, &mut packet)
            .map_err(map_err)?;
        Ok(Buffer::from(packet[..n].to_vec()))
    }

    /// Encode into a caller-provided output buffer. Returns bytes written.
    /// This is the zero-alloc hot path: no `Buffer` is created per frame.
    #[napi]
    pub fn encode_into(
        &mut self,
        input: BufferSlice,
        mut output: BufferSlice,
        frame_size: u32,
    ) -> Result<u32> {
        let channels = self.channels as usize;
        let frame = if frame_size == 0 {
            input.len() / (channels * 2)
        } else {
            frame_size as usize
        };
        let needed = frame
            .checked_mul(channels)
            .ok_or_else(|| bad_arg("frame_size overflow"))?;
        if input.len() < needed * 2 {
            return Err(bad_arg(&format!(
                "input buffer too short: need {} bytes for a {}-sample frame, got {}",
                needed * 2,
                frame,
                input.len()
            )));
        }
        if output.len() < 2 {
            return Err(bad_arg("output buffer too small: need at least 2 bytes"));
        }
        self.ensure_f32(needed);
        for (i, chunk) in input[..needed * 2].chunks_exact(2).enumerate() {
            self.f32_scratch[i] = i16_to_f32(i16::from_le_bytes([chunk[0], chunk[1]]));
        }
        let out: &mut [u8] = &mut output;
        let n = self
            .encoder
            .encode(&self.f32_scratch[..needed], frame, out)
            .map_err(map_err)?;
        Ok(n as u32)
    }

    // -- decode -------------------------------------------------------------

    fn decode_to_f32(&mut self, packet: &[u8], frame_size: usize, fec: bool) -> Result<usize> {
        let channels = self.channels as usize;
        let needed = frame_size
            .checked_mul(channels)
            .ok_or_else(|| bad_arg("frame_size overflow"))?;
        self.ensure_f32(needed);
        let n = if fec {
            self.decoder
                .decode_fec(packet, frame_size, &mut self.f32_scratch[..needed])
        } else {
            self.decoder
                .decode(packet, frame_size, &mut self.f32_scratch[..needed])
        }
        .map_err(map_err)?;
        Ok(n)
    }

    fn f32_scratch_to_pcm(&self, samples_per_channel: usize) -> Buffer {
        let total = samples_per_channel * self.channels as usize;
        let mut pcm = Vec::with_capacity(total * 2);
        for &v in &self.f32_scratch[..total] {
            pcm.extend_from_slice(&f32_to_i16(v).to_le_bytes());
        }
        Buffer::from(pcm)
    }

    /// `frame_size` is the expected output samples per channel and is
    /// required here — the JS wrapper infers it from the packet TOC when
    /// the caller omits it. Pass an empty packet for PLC (lost frame).
    #[napi]
    pub fn decode(&mut self, packet: BufferSlice, frame_size: u32) -> Result<Buffer> {
        if frame_size == 0 {
            return Err(bad_arg(
                "frame_size is required for decode (pass it, or let the JS wrapper infer it from the packet TOC)",
            ));
        }
        let n = self.decode_to_f32(&packet, frame_size as usize, false)?;
        Ok(self.f32_scratch_to_pcm(n))
    }

    /// Decode into a caller-provided PCM buffer. Returns PCM bytes written.
    #[napi]
    pub fn decode_into(
        &mut self,
        packet: BufferSlice,
        mut output: BufferSlice,
        frame_size: u32,
    ) -> Result<u32> {
        if frame_size == 0 {
            return Err(bad_arg(
                "frame_size is required for decode (pass it, or let the JS wrapper infer it from the packet TOC)",
            ));
        }
        let n = self.decode_to_f32(&packet, frame_size as usize, false)?;
        let total = n * self.channels as usize;
        if output.len() < total * 2 {
            return Err(bad_arg(&format!(
                "output buffer too small: need {} bytes, got {}",
                total * 2,
                output.len()
            )));
        }
        let out: &mut [u8] = &mut output;
        for (i, &v) in self.f32_scratch[..total].iter().enumerate() {
            out[i * 2..i * 2 + 2].copy_from_slice(&f32_to_i16(v).to_le_bytes());
        }
        Ok((total * 2) as u32)
    }

    /// Reconstruct a lost frame from the LBRR in the *next* packet.
    #[napi]
    pub fn decode_fec(&mut self, packet: BufferSlice, frame_size: u32) -> Result<Buffer> {
        if frame_size == 0 {
            return Err(bad_arg("frame_size is required for decode_fec"));
        }
        let n = self.decode_to_f32(&packet, frame_size as usize, true)?;
        Ok(self.f32_scratch_to_pcm(n))
    }

    /// Packet-loss concealment for a lost frame: synthesises `frame_size`
    /// samples per channel from decoder state.
    #[napi]
    pub fn decode_plc(&mut self, frame_size: u32) -> Result<Buffer> {
        if frame_size == 0 {
            return Err(bad_arg("frame_size is required for decode_plc"));
        }
        let n = self.decode_to_f32(&[], frame_size as usize, false)?;
        Ok(self.f32_scratch_to_pcm(n))
    }
}

/// JS entry point for creating a codec: `createOpus({ rate, channels,
/// application, bitrate, complexity, useCbr, useFec, useDtx, packetLoss,
/// lsbDepth })`. A free function (not a class constructor) so construction
/// errors surface as a JS exception instead of a panic.
#[napi]
pub fn create_opus(opts: OpusOptions) -> Result<NativeOpus> {
    NativeOpus::new(&opts)
}

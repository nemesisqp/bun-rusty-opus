# Research: rusty-opus 1.0.2 — verified from the crate source

Checked 2026-11-13. `cargo search rusty-opus` resolves `rusty-opus = "1.0.2"`
(checksum `46604e6809c06441da1cfdde1f0cc25a4f2bf42c7d005aa387c2875c02d78762`),
and the signatures below were read directly from the vendored source
`~/.cargo/registry/src/.../rusty-opus-1.0.2/src/lib.rs` and `src/isa.rs`.

## What it actually is — NOT a libopus wrapper

- Pure-Rust Opus codec (RFC 6716 / RFC 8251). **No C code, no FFI, no `opus-sys`,
  no libopus linkage, no build-time toolchain.** Derived from `opus-rs`
  (pure-Rust port of libopus 1.6). Edition 2024, MSRV Rust 1.85, zero
  dependencies, BSD-3-Clause. `build = false` in its Cargo.toml.
- SILK, CELT, Hybrid modes; bit-exact on the official RFC test vectors;
  interoperates with libopus both ways.
- Claimed speed: up to 1.6x libopus single-thread encode in the crate's own
  benchmarks (1.50x CELT 48kHz speech @ 32kb/s, 1.60x CELT 48kHz stereo music
  @ 128kb/s on i7-14650HX; SILK 16kHz VoIP within 4% of libopus).
- **SIMD is runtime-dispatched, not compile-time** (`src/isa.rs`):
  `is_x86_feature_detected!("avx2"/"avx"/"fma"/"sse2")`, NEON on aarch64,
  scalar fallback. `RUSTY_OPUS_ISA=scalar|sse2|avx|avx2` caps the rung.
  Consequence for this project: **`RUSTFLAGS="-C target-cpu=native" must NOT
  be used for published prebuilts** — a binary built with `native` on the CI
  runner can SIGILL on a user's older CPU. The crate already uses AVX2/NEON
  on machines that have it, from one portable binary. `target-cpu=native`
  is offered only as a dev-local build option (`scripts/build-local.sh`).
- After warm-up, `encode`/`decode` do no heap allocation per frame
  (encode allocates only on a SILK→CELT switch).

## Core API (exact signatures, docs.rs 1.0.2)

```rust
use rusty_opus::{Application, Error, OpusDecoder, OpusEncoder};

OpusEncoder::new(sampling_rate: i32, channels: usize, application: Application) -> Result<Self, Error>
OpusEncoder::encode(&mut self, input: &[f32], frame_size: usize, output: &mut [u8]) -> Result<usize, Error>
OpusEncoder::enable_hybrid_mode(&mut self) -> Result<(), Error>  // only 24/48 kHz
OpusEncoder::final_range(&self) -> u32

OpusDecoder::new(sampling_rate: i32, channels: usize) -> Result<Self, Error>
OpusDecoder::decode(&mut self, input: &[u8], frame_size: usize, output: &mut [f32]) -> Result<usize, Error>
OpusDecoder::decode_fec(&mut self, packet: &[u8], frame_size: usize, output: &mut [f32]) -> Result<usize, Error>
// pub field: OpusDecoder::last_range: u32
```

- **f32 only — no `encode_i16`/`decode_i16` in 1.0.2.** Input is interleaved
  `f32` in [-1, 1], length `frame_size * channels`; `frame_size` is samples
  per channel. Output packet buffer is caller-provided (example uses
  `[0u8; 1500]`; `< 2` bytes → `BufferTooSmall`). Returns bytes written.
  Max packet 1276 bytes. **The N-API wrapper must do i16↔f32 conversion
  (`sample as f32 / 32768.0`) itself.**
- `decode` returns samples per channel. Empty packet = lost frame → PLC
  (concealment), still returns `frame_size`. `decode_fec` reconstructs a
  lost frame from LBRR in the *next* packet; falls back to PLC.
- Rates: 8000 / 12000 / 16000 / 24000 / 48000 only. Channels: 1 or 2.
- Valid frame sizes (samples/channel) = rate × duration, durations
  2.5 / 5 / 10 / 20 / 40 / 60 / 80 / 100 / 120 ms. Anything else → `BadArg`.
  At 48 kHz, 20 ms = 960.
- `Application`: `Voip = 2048`, `Audio = 2049`, `RestrictedLowDelay = 2051`.
- `Bandwidth`: `Auto = -1000, Narrowband = 1101, Mediumband = 1102,
  Wideband = 1103, Superwideband = 1104, Fullband = 1105`.
  `SignalType`: `Voice, Music` (None = auto).

## Encoder settings — public fields, not setter methods

| Field | Type | Default |
|---|---|---|
| `bitrate_bps` | `i32` | 64_000 |
| `complexity` | `i32` | 9 (0 fastest – 10 best) |
| `use_cbr` | `bool` | `false` (VBR) |
| `use_inband_fec` | `bool` | `false` |
| `use_dtx` | `bool` | `false` |
| `packet_loss_perc` | `i32` | 0 (0–100) |
| `force_bandwidth` | `Option<Bandwidth>` | `None` (auto) |
| `signal_type` | `Option<SignalType>` | `None` (auto) |
| `max_bandwidth` | `Bandwidth` | `Fullband` |
| `lsb_depth` | `i32` | 24 (set 16 for s16-sourced content) |
| `mode_dwell` | `u32` | 1 (= off) |

## Error type

```rust
#[non_exhaustive]
pub enum Error { BadArg(&'static str), BufferTooSmall(&'static str),
                 InvalidPacket(&'static str), Internal(&'static str) }
// Error::code() -> i32  (libopus error code, always negative)
```

Malformed packets are always `Err`, never a panic. `#[non_exhaustive]` —
the wrapper must have a wildcard arm.

## Extra modules

- `multistream::{OpusMSEncoder, OpusMSDecoder, ChannelLayout}` — surround.
- `repacketizer::{Repacketizer, nb_frames, pad_packet, parse_packet, ...}`.
- `parallel::{ParallelConfig, encode_parallel, encode_serial, encode_streams}`.
- Features: `profile` (off), `research` (off). No default features to enable.
  Do not copy the `heap`/`std`/`libm` feature table from upstream `opus-rs`.

# Changelog

## 0.1.0 — 2026-11-13

First release.

- napi-rs bindings to rusty-opus 1.0.2 (pure-Rust Opus codec, no libopus).
- `OpusEncoder` with the @discordjs/opus API shape (encode/decode on s16le
  PCM, `setBitrate`/`setFEC`/`setPLP`, `applyEncoderCTL`, `finalRange`/
  `lastRange`), plus `OpusDecoder` (decode-only).
- Zero-copy Buffers (`BufferSlice`) and zero-allocation hot path
  (`encodeInto`/`decodeInto` with caller-provided output buffers; reused
  f32 scratch; no heap allocation per frame after warm-up).
- Prebuilt napi binaries for 8 platforms via GitHub Actions; install fails
  (`ERR_BUN_RUSTY_OPUS_NO_PREBUILT`) when no prebuilt fits — no
  install-time source build anywhere.
- `encoder.preSkip` / `opusPreSkip(rate, application)`: the real
  end-to-end delay (120 samples @48 kHz CELT/Hybrid, 312 scaled for
  SILK-only) — not libopus's uniform 312.
- Interop verified both ways with @discordjs/opus 0.11.0 (libopus):
  packets decode correctly in both directions at matched bitrate.
- 18 tests pass under Node (15 under Bun; the 3 interop tests skip there
  because @discordjs/opus ships no Bun prebuild). Typecheck clean.

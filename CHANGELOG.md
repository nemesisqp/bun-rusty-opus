# Changelog

## 0.2.0 — 2026-11-13

- Vendored rusty-opus 1.0.2 into `vendor/rusty-opus/` with
  `[patch.crates-io]` and bit-preserving decode patches (see
  `vendor/rusty-opus/PATCHES.md`): AVX2/SSE2 kernels for `exp_rotation1`
  (the PVQ rotation had a NEON kernel but no x86 twin; no FMA, unit-
  tested bit-exact vs scalar), `#[inline(always)]` on `dec_bits` /
  `read_byte` / `unext`, and the SIG_SAT clamp loop slicing first.
  Decode 28.6 → 27.8 ms in `bench.mjs` (0.78x → 0.80x vs
  @discordjs/opus, overall 1.15x). Two leads were measured and dropped:
  `compute_u` never fires on real content and an AVX `kf_bfly2`
  extraction did not vectorise (reverted).
- Validation harness: `scripts/check-decode-parity.sh` (pristine 1.0.2
  vs fork, bit-for-bit, 44 checks: 11 configs × normal/PLC/FEC decode
  + encode bit-identity — all pass) and `test/decode-parity.test.mjs`
  (JS interop vs libopus: RMS ~2e-5, max 1 s16 LSB; PLC asserted as
  sanity, not libopus parity, because upstream PLC legitimately
  diverges from libopus's concealment fade).
- `docs/DECODE_ESTIMATE.md` corrected: the 22–24 ms fork estimate was
  too optimistic (PVQ scaffolding, already-optimised IMDCT/postfilter);
  the fork's ~3% is real and the harness makes future patches cheap to
  validate.

## 0.1.1 — 2026-11-13

- Faster decode: the f32→i16 conversion on the decode path is now
  runtime-dispatched SIMD (AVX2/SSE2 on x86_64, NEON on aarch64, scalar
  tail + fallback) instead of a scalar loop that did not auto-vectorise.
  Decode 33.1 → 28.7 ms in `bench.mjs` (0.66x → 0.77x vs
  @discordjs/opus), `decodeInto` 31.7 → 27.7 ms. Rounding may differ by
  1 LSB on exact-half values (nearest-even vs half-away-from-zero).
- Investigation notes in `docs/PERFORMANCE.md`: the remaining decode
  gap is inside rusty-opus's CELT/Hybrid decode (SILK decode is at
  parity or faster); ruled out with measurements — per-frame allocation
  (0), denormals/FTZ (1.00x), SIMD dispatch, native CPU flags, packet
  content. Also noted: SILK encode at 16 kHz mono is ~3x slower than
  libopus in the crate (not fixed here).

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

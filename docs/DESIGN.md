# Design

Decisions behind bun-rusty-opus, and the gotchas found while building it.
Read this before changing the binding layout, the loader, or the release
flow.

## 1. Why rusty-opus, why napi-rs

- rusty-opus 1.0.2 is a pure-Rust port of libopus 1.6: no C, no FFI, no
  opus-sys, zero dependencies, BSD-3-Clause. Bit-exact on the RFC test
  vectors and interoperable with libopus both ways (verified in
  `test/interop.test.mjs`).
- napi-rs is the only distribution story that gives prebuilt `.node` files
  per platform triple without node-gyp. @discordjs/opus's
  node-pre-gyp + `fallback-to-build` is the anti-pattern this project
  exists to avoid: a 404 or ABI mismatch silently compiles C++ on the
  user's machine.
- Bun loads napi `.node` files natively, so one binary serves Node and Bun.

## 2. No `target-cpu=native` for published prebuilts

The brief suggested native CPU flags. A `native` binary built on a CI
runner can SIGILL on a user's older CPU, so published builds must be
portable. rusty-opus already runtime-dispatches SIMD
(`src/isa.rs`: AVX2/AVX/FMA/SSE2 detection on x86_64, NEON baseline on
aarch64; `RUSTY_OPUS_ISA` caps it), so the portable build still takes the
fast paths. Release profile: opt-level 3, fat LTO, codegen-units 1,
strip. `scripts/build-local.sh` offers `target-cpu=native` for a dev
machine only. The release workflow sets `RUSTFLAGS: ''` explicitly so no
runner default can sneak a native flag in.

## 3. f32-only codec, i16 at the boundary

rusty-opus has no `encode_i16`/`decode_i16`: it takes interleaved f32
in [-1, 1] and returns f32. The conversion lives in Rust
(`sample as f32 / 32768.0`; decode clamps to [-1, 1], *32767, rounds,
saturates) — doing it in JS would eat the speedup the binding exists for.
The JS wrapper defaults `lsbDepth` to 16 (s16 source).

## 4. Zero-copy and zero-allocation hot path

- Inputs and the `encodeInto`/`decodeInto` outputs are napi
  `BufferSlice<'env>` — a zero-copy `&mut [u8]` view of a JS Buffer
  (sync contexts only). No `Vec<u8>` is built per 20 ms frame.
- The allocating `encode` uses a stack packet buffer (`[0u8; 1276]`,
  the max Opus packet size) and copies out only the bytes written.
- `NativeOpus` holds one encoder + one decoder + a reusable `f32_scratch`
  Vec that grows and never shrinks. After warm-up, no heap allocation per
  frame. The bench shows `encodeInto` costs the same wall time as
  `encode` — the win is GC pressure, not wall time; see
  `docs/PERFORMANCE.md`.

## 5. Fallible construction: `createOpus`, not a napi constructor

napi-derive constructors/factories in napi 3.x must return `Self`
directly — they cannot fail. So creation lives in a free function
`#[napi] pub fn create_opus(opts: OpusOptions) -> Result<NativeOpus>`
with `#[napi(object)] pub struct OpusOptions` (10 fields). The JS
`OpusEncoder` constructor calls it. This also fixed an early clippy
`too_many_arguments` failure.

## 6. The `Result` alias gotcha (napi-derive)

**Do not alias the return type.** Writing `use napi::Result as
NapiResult` and returning `NapiResult<T>` breaks napi-derive's Result
detection: fallible methods then silently return `undefined` instead of
throwing. Use `napi::Result` unaliased everywhere in `src/lib.rs`.
Found by testing: invalid frame size and garbage packets returned
`undefined` instead of throwing `opus error -1/-4`. If a native method
ever returns `undefined` on error, check this first.

## 7. Loader layout: hand-written `index.js`, generated `binding.js`

- `index.js` (main) and `index.d.ts` (public types) are hand-written and
  must never be overwritten by `napi build`. The build script is
  `napi build --platform --release --js binding.js --dts lib/binding.d.ts`:
  the generated loader lands at the repo root as `binding.js`, the
  generated native types at `lib/binding.d.ts`. Both are committed.
- `lib/loader.js` delegates to `../binding.js` (the napi-rs loader, which
  tries `./<name>.<triple>.node` then `require('<pkg>-<triple>')`) and
  rethrows failures as an error with
  `code: 'ERR_BUN_RUSTY_OPUS_NO_PREBUILT'`, naming the detected
  platform-arch-libc and the supported list. If `binding.js` is missing
  (source checkout, never built) it says so plainly.
- `lib/wrapper.js` is the public API: validation, frame-size inference
  (`packetFrameSize` parses the TOC byte), the @discordjs/opus-compatible
  surface, and `opusPreSkip`.

## 8. Install must fail, not build

- No `install`/`postinstall` build anywhere. `postinstall` runs only
  `scripts/check-prebuilt.js`, which *loads* the binding: in a published
  install it exits 1 on failure; in a source checkout (detected by
  `Cargo.toml` + `.git` present — published `files` exclude them) it warns
  and exits 0. Escape hatch: `BUN_RUSTY_OPUS_SKIP_PREBUILT_CHECK=1`.
- The loader is the backstop for Bun, which may skip dependency
  postinstall scripts.
- `Cargo.lock` is deliberately tracked (removed from `.gitignore`) for
  reproducible builds of a binary artifact.
- `package.json` must NOT have a script named `prepublish` — npm
  auto-runs it on `npm install`, and it fails there because the `npm/*`
  platform dirs do not exist yet. The napi step is named
  `release:prepare` instead.

## 9. Pre-skip is not 312

Measured by cross-correlating a chirp through encode → decode
(`docs/PERFORMANCE.md`): rusty-opus does not pad its output to libopus's
uniform 312 samples. SILK-only (voip/audio ≤ 16 kHz) delays
`rate * 312 / 48000` samples; CELT/Hybrid delays `rate * 120 / 48000`.
Exposed as `encoder.preSkip` and `opusPreSkip(rate, application)`. The
interop tests align each direction by the *encoding* side's pre-skip
(ours 120, theirs 312 at 48 kHz). Anyone writing Ogg files from this
codec must use this value as OpusHead pre-skip — including Voice
Studio's `opus.ts`, which hardcodes 312 for libopus.

## 10. Defaults that differ from @discordjs/opus

- Bitrate: ours 64000 bps (rusty-opus default), theirs 120000 bps
  (libopus `OPUS_AUTO`). The bench and the interop size test match it
  explicitly; comparing defaults measures bitrate, not codec speed.
- `applyDecoderCTL` always throws (rusty-opus exposes no decoder
  controls); kept for API parity. `applyEncoderCTL` maps CTLs 4002, 4006,
  4008, 4009, 4010, 4012, 4014, 4016, 4024, 4036; 4000 (application) is
  rejected — set it in the constructor.
- `decode` with `frameSize` 0 is an error; `encode` with `frameSize` 0
  infers it from the input length. `decode_fec` needs an explicit
  frame size; empty packet to `decode` is packet-loss concealment.

## 11. Release flow

`.github/workflows/release.yml` (tag `v*` only): 8-target matrix,
`napi build --platform --release` per target (musl via cargo-zigbuild
`--zig`, aarch64 GNU via cross gcc), artifacts uploaded as
`bindings-<triple>`, publish job runs `napi create-npm-dirs`, copies
each `.node` into `npm/<triple>/`, runs `napi prepublish`, publishes the
main package and every platform package (`npm publish --access public`,
`NPM_TOKEN` secret). Unscoped platform package names
(`bun-rusty-opus-linux-x64-gnu`, …) are the napi default; they can trip
npm spam detection on first publish — if that happens, the fix is scoped
platform packages, not a build fallback.

`npm/*` dirs are generated in CI and never committed. `binding.js` and
`lib/binding.d.ts` are generated by `npm run build` and ARE committed.

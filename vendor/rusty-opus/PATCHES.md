# rusty-opus fork (vendored)

This is a vendored copy of **rusty-opus 1.0.2** (pure-Rust Opus codec,
BSD-3-Clause, upstream: https://github.com/Remade-With-Rust/rusty-opus),
patched by the bun-rusty-opus project for decode performance. The
original `COPYING` (BSD-3-Clause) is retained unchanged.

## Why a vendored fork

- Upstream decode at 48 kHz stereo is ~28.6 ms per 10 s of audio vs
  ~22.2 ms for libopus (measured 2026-11-13, best of 3, this VM). The
  binding already fixed its own layer (SIMD f32→i16 conversion,
  v0.1.1); the remaining gap is inside the crate's CELT/Hybrid decode.
- The crate's own stage profiler is encode-only, which suggests decode
  has had less optimisation attention. The optimisations below are
  localised to the decode path and keep the crate's bit-exact output.
- Vendoring (instead of a git fork) keeps the repo self-contained: no
  extra GitHub repo or deploy key, CI builds offline for this crate.

## How it is wired

Root `Cargo.toml` has:

```toml
[patch.crates-io]
rusty-opus = { path = "vendor/rusty-opus" }
```

The vendored crate keeps version `1.0.2` so the patch applies cleanly
to the `=1.0.2` pin. Its own `Cargo.lock` is kept for standalone
`cargo test` runs inside this directory; the workspace lock is the
authoritative one.

## Rules for patches (all of them are enforced by the checks below)

1. **Bit-preserving only.** Every optimisation must produce
   bit-identical decoded PCM to unpatched 1.0.2 (same float ops in the
   same order, no FMA, no fast-math, no reordered summation). SIMD
   kernels must be lane-parallel with the same per-element arithmetic.
   Verified by `scripts/check-decode-parity.sh` (pristine vs patched,
   bit-for-bit) and the crate's own `oracle_bitexact` test.
2. **No behaviour change.** No new public API, no changed defaults, no
   changed error behaviour. Encode output must also stay bit-identical
   (checked by the same harness).
3. **Upstream style.** Follow the crate's own clippy config
   (`undocumented_unsafe_blocks = deny` — every `unsafe` block needs a
   `// SAFETY:` comment) and run `cargo fmt --check` inside
   `vendor/rusty-opus`.
4. **Rebase path.** To take a new upstream version: copy the new
   registry source over this directory (keeping `PATCHES.md` and this
   file's history), re-apply the patches listed below, re-run all
   checks. Each patch is listed with its rationale and the files it
   touches so the rebase is mechanical.

## Patches applied

### 1. `exp_rotation1` AVX2/SSE2 kernels (`src/pvq.rs`)
- **Why:** `exp_rotation` (PVQ spreading rotation, ~17–25% of the decode
  PVQ bucket) had a NEON kernel for aarch64 but no x86 twin, so x86
  always ran the scalar loop. A normal developer reading the dispatch
  would assume the rotation is SIMD-covered; it was not on x86.
- **What:** `exp_rotation1_avx2` (8-wide, `stride >= 8`) and
  `exp_rotation1_sse2` (4-wide, `stride >= 4`), dispatched from
  `exp_rotation1` before the scalar fallback. Forward pass only (the
  backward pass stays scalar, like the NEON kernel); the stride-1 pass
  is a serial recurrence and cannot be vectorised.
- **Bit-preservation:** separate multiply and add, NO FMA — lane-for-lane
  identical arithmetic to the scalar loop. (The NEON kernel uses FMA and
  therefore differs from scalar in last bits; the x86 kernels deliberately
  do not.) Guarded by the unit test
  `exp_rotation1_simd_matches_scalar_bit_exact` (exact `assert_eq!`,
  not closeness) and by the pristine-vs-patched parity harness.
- **Measured:** patches 1–3 together move the JS bench decode from
  28.6 ms to 27.8 ms per 10 s of 48 kHz stereo (ratio vs libopus
  0.78x → 0.80x, overall 1.15x unchanged; two quiet-machine runs,
  best of 3 each). Patch 1 is the main contributor; patches 2–3 are
  each <1%. The exp_rotation gain is smaller than the profiler
  suggested because only the stride-2 pass vectorises (the stride-1
  pass is a serial recurrence) and the profiler's absolute numbers were
  inflated by its own instrumentation.

### 2. `dec_bits` / `read_byte` / `unext` inlining (`src/range_coder.rs`, `src/pvq.rs`)
- **Why:** `dec_bits` (one call per sign bit, hundreds per frame) had no
  inline attribute, unlike its neighbours `dec_uint` / `decode` /
  `update`. Same for the private `read_byte` and `unext` (called from
  `compute_u`).
- **What:** added `#[inline(always)]` to all three. No code change.
- **Bit-preservation:** inlining only; identical instructions.
- **Measured:** sub-1% (folded into the patches 1–3 total above).

### 3. SIG_SAT clamp loop slices first (`src/celt.rs`)
- **Why:** the decode-tail saturation clamp indexed
  `decode_mem[offset + i]` with a computed index, forcing a bounds
  check per sample and blocking auto-vectorisation of an element-wise
  clamp.
- **What:** slice the range first, then `iter_mut().clamp(...)`. The
  slice creation panics under exactly the same conditions the indexed
  loop did.
- **Bit-preservation:** order-independent per-element clamp.
- **Measured:** sub-1% (folded into the patches 1–3 total above).

### Test hygiene fixes (not performance patches)
- `src/pvq.rs` (own test): `let mut b = x.clone()` → `let mut b = x`
  (move instead of a second clone; clippy `redundant_clone`).
- `src/kiss_fft.rs` (`test_bitrev_permutation`, pre-existing upstream):
  `st.bitrev.clone()` → `st.bitrev` — `st` is unused afterwards, so the
  clone was redundant. Both are behaviour-identical; they unblock
  `cargo clippy --all-targets -- -D warnings`, which otherwise fails on
  these two pre-existing test-code lints under clippy 1.100.

## Investigated and NOT applied (measured first, then dropped)

### `cwrsi` binary search + `compute_u` memoisation
- **Why it looked promising:** `celt_pvq_u_lookup` falls back to
  `compute_u` (O(n·k), no memoisation) when the table misses, and the
  table scans are linear.
- **Measurement:** a counter-instrumented copy decoded the whole
  corpus: `compute_u` was called **0 times on every config** — the
  table covers all real content, so memoisation buys nothing. The
  linear scans average 2.3–11.7 steps/call (48k audio 4.0, voip 7.7,
  16k mono 11.7, 128k/10ms 11.0); each step is a table lookup +
  compare, ~20k–100k steps per 10 s of audio, i.e. <0.2 ms. A binary
  search would need ~7 lookups for the common cases — no win. Dropped.

### `kf_bfly2` AVX inner for the `m > 1` stage
- **Why it looked promising:** the radix-2 FFT stage's `m > 1` branch
  had no AVX kernel (only the `m == 1` case did), and the audit
  estimated ~4–5% of decode.
- **What was tried:** extracted the scalar body into a
  `#[target_feature(enable = "avx")]` fn (the crate's own pattern for
  `kf_bfly3/4/5_avx_inner`) and dispatched to it when `avx()` is true.
- **Measurement:** decode ratio unchanged (0.80x, overall 1.15x, two
  runs) — LLVM does not auto-vectorise this loop (strided 8-element
  groups), so the patch was a no-op. Reverted. An explicit-intrinsic
  version could still work but was judged not worth the shuffle-heavy
  code and bit-exactness risk for ~1 ms.

### `stereo_itheta` SIMD (skipped, not bit-exact)
- Vectorising it changes the dot-product summation order, which can flip
  a quantisation decision by ULPs. Not bit-preserving under the fork
  rules; skipped.

## Checks that guard this fork

- `cargo test -p rusty-opus` (vendored crate's own suite, incl.
  `oracle_bitexact`, RFC vectors, round-trips, property tests).
- `scripts/check-decode-parity.sh` — pristine 1.0.2 (from the registry)
  vs this patched copy, bit-for-bit PCM on a fixed corpus, plus
  encode bit-identity.
- `npm test` + `test/decode-parity.test.mjs` — JS-level interop vs
  @discordjs/opus (libopus): tightened RMS / max-abs-diff thresholds.
- `node bench/bench.mjs` — the headline numbers must not regress.

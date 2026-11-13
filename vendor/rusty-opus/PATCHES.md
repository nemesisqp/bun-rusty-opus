# rusty-opus fork (vendored)

This is a vendored copy of **rusty-opus 1.1.0** (pure-Rust Opus codec,
BSD-3-Clause, upstream: https://github.com/Remade-With-Rust/rusty-opus),
patched by the bun-rusty-opus project for decode performance. The
original `COPYING` (BSD-3-Clause) is retained unchanged.

Rebased from 1.0.2 to 1.1.0 on 2026-11-13 (upstream's performance
release, v1.1.0, 2026-11-13T07:18:55Z). All four patches below were
re-applied: the FFT kernels (kiss_fft.rs) and the range-coder inlining
(range_coder.rs) apply cleanly — upstream did not touch those files;
the SIG_SAT slice (celt.rs) re-applies at shifted line numbers
(upstream only removed the `w_pcm_frame` zero-fill next to it); the
`exp_rotation1` AVX2/SSE2 kernels (pvq.rs) needed a manual merge
because upstream rewrote the scalar to be bounds-check-free (with a
`#[cold]` checked fallback) — our kernels and dispatcher are kept
unchanged and the new upstream scalar is the fallback. Upstream's
1.1.0 work (PVQ index-coding table-lookup skips, MDCT/high-pass
zero-fill removal, inline `floor`/`round_ties_even`, SILK NSQ/decoder
AVX2, slice-walking sample plumbing) is taken as-is. One extra
one-line lint fix was needed (patch 5): upstream 1.1.0's
`src/silk/resampler.rs` trips Rust 1.100's `tuple_array_conversions`
lint under `-D warnings`.

## Why a vendored fork

- Upstream decode at 48 kHz stereo is ~24.6 ms per 10 s of audio vs
  ~22.2 ms for libopus (measured 2026-11-13, best of 3, this VM, after
  the 1.1.0 rebase + our patches; before the rebase it was ~30.1 ms).
  The binding already fixed its own layer (SIMD f32→i16 conversion,
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

The vendored crate keeps version `1.1.0` so the patch applies cleanly
to the `=1.1.0` pin. Its own `Cargo.lock` is kept for standalone
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

### 4. FFT `m > 1` butterfly AVX kernels (`src/kiss_fft.rs`)
- **Why:** the profiler showed the FFT (`opus_fft_impl`, inside
  `mdct.backward`) is ~4.4 ms of decode (~12% on sine) and its `m > 1`
  stages are 3.8 ms (~11%) — the `m == 1` stage was already AVX-covered
  and the pre/post rotations already have AVX kernels. The `m > 1`
  stages had only scalar bodies compiled with `#[target_feature(enable
  = "avx")]` (the crate's own pattern), which LLVM does not
  auto-vectorise (strided groups), so they ran scalar.
- **What:** explicit-intrinsic AVX (256-bit, 4 complex per vector)
  kernels for all four radices' `m > 1` stages, dispatched from
  `kf_bfly2/3/4/5` when `avx()` is true, with a scalar tail for
  `m % 4`:
  - `avx_cmul_4` — complex multiply of 4 interleaved pairs, mirroring
    the NEON `neon_cmul_2` helper (dup + mul + add; the real part is
    formed as `ar*br + (-(ai*bi))`, bit-identical to `ar*br - ai*bi`).
  - `avx_load_twiddles_4` — loads 4 strided twiddle complex values
    (twiddles advance by `fstride` per `j`) via scalar loads + set.
  - `kf_bfly4_avx_inner`, `kf_bfly5_avx_inner`, `kf_bfly3_avx_inner`
    — rewritten with explicit intrinsics (4 consecutive `j` per
    iteration; the four `fout` partners are each contiguous loads).
  - `kf_bfly2_mm_avx` — the radix-2 `m > 1` stage. Its twiddles are
    factored constants (`(sum) * tw`), so a general `c_mul` would NOT
    be bit-exact (two products + add vs one add + one product, different
    rounding); the twiddled operand is built lane by lane from the
    duplicated real/imag parts using the scalar's own factored sums.
  - The `ya`/`yb` (radix-5) and `epi3_i` (radix-3) intermediates mix
    real and imaginary parts, so they are built from duplicated
    real/imag vectors and interleaved with a 0xAA blend.
- **Bit-preservation:** same float ops in the same order per lane, no
  FMA, no reassociation. Guarded by the unit tests
  `test_bfly4_mm_avx_bitexact`, `test_bfly35_mm_avx_bitexact`,
  `test_bfly2_mm_avx_bitexact` (exact `to_bits()` equality vs the
  scalar body, uncapped vs capped to SCALAR) and by the pristine-vs-
  patched parity harness.
- **Measured:** FFT kernels together move the JS bench decode from
  32.5 ms to ~30.1 ms per 10 s of 48 kHz stereo (ratio vs libopus
  0.77x → 0.82x, overall 1.16x → 1.23x; encode also improves,
  80.8 → 75.7 ms, 1.32x → 1.40x, because encode uses the same FFT).
  Radix-4 alone gave ~0.6 ms; radix-5 + radix-3 gave ~1.9 ms more;
  radix-2 gave ~0.1 ms (within noise — its factored twiddles make it
  the smallest, most shuffle-heavy stage). Short of the hoped-for 10%
  because the `m > 1` stages are only ~11% of decode and the rest
  (PVQ scaffolding, postfilter, rotations) does not vectorise.

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
- `src/silk/resampler.rs` (`ar2_q14_exact`, upstream 1.1.0 code):
  `let (mut s0, mut s1) = (s[0], s[1]);` → `let [mut s0, mut s1] =
  [s[0], s[1]];` — same values, same order, array destructuring so
  Rust 1.100's `tuple_array_conversions` lint stays clean under
  `-D warnings`. Behaviour-identical; needed only because the 1.1.0
  rebase brought in this upstream line.

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

### `kf_bfly2` AVX inner for the `m > 1` stage (scalar-body extraction)
- **Why it looked promising:** the radix-2 FFT stage's `m > 1` branch
  had no AVX kernel (only the `m == 1` case did), and the audit
  estimated ~4–5% of decode.
- **What was tried:** extracted the scalar body into a
  `#[target_feature(enable = "avx")]` fn (the crate's own pattern for
  `kf_bfly3/4/5_avx_inner`) and dispatched to it when `avx()` is true.
- **Measurement:** decode ratio unchanged (0.80x, overall 1.15x, two
  runs) — LLVM does not auto-vectorise this loop (strided 8-element
  groups), so the patch was a no-op. Reverted. (The explicit-intrinsic
  version was later built as part of patch 4 — see above — and it does
  work, but only for ~0.1 ms, confirming the original judgement that
  this stage is small.)

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

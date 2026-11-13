# Decode: how much faster could a forked rusty-opus get?

Estimate for cloning rusty-opus 1.0.2 and optimising its decode path.
Measured 2026-11-13 on this VM (AMD EPYC, AVX2), 10 s of 48 kHz stereo,
20 ms frames, 64 kbps, best-of runs. Profiling used a temporary copy of
the crate with the built-in `profile` feature plus four added decode
stages (`DecTotal/DecRange/DecPvq/DecPost` in `src/prof.rs`); the copy
lives in /tmp, not in this repo. The profiler adds ~18% overhead
(DecTotal 33.5 ms vs 28.3 ms wall without it), so **shares, not absolute
milliseconds, are the basis** for the estimate below.

## Where decode time goes (exclusive shares, 48 kHz stereo)

| stage | sine | noise | silence | what it is |
| --- | --- | --- | --- | --- |
| PVQ decode + dequant (`quant_all_bands`, encode=false) | 42% | 56% | 17% | range-coded pulse decoding (`decode_pulses`), dequant, stereo |
| IMDCT (`mdct.backward` + kiss_fft) | 21% | 17% | 32% | inverse MDCT, overlap-add |
| postfilter + deemphasis (comb filter, IIR, clamps) | 23% | 16% | 35% | pitch postfilter, deemphasis, saturation clamps |
| range / energy (exclusive: coarse+fine unquant, tf, spread) | 4% | 2% | 2% | entropy reads for band energies |
| allocation (`clt_compute_allocation`) | 2–3% | 2% | 3% | bit allocation per band |
| denormalise_bands wrapper | 1% | 1% | ~0% | band scaling |
| other (mode setup, log2amp, anti-collapse, PLC state) | 7% | 5% | 10% | — |

Pure-Rust decode totals: sine 28.3 ms, noise ~30 ms, silence 17.8 ms
per 10 s audio. libopus (through @discordjs/opus, minus ~2.5 ms of
binding overhead) decodes the same sine in ~19.5 ms and silence in
~13 ms. So the gap is **~9 ms on sine (~31%) and ~5 ms on silence
(~27%)** — spread across all three hot stages, not one broken function.
SILK-only decode (≤ 16 kHz) is already at parity or faster than libopus,
so this is purely a CELT/Hybrid wideband-decode story.

## What each stage would take to fix, and what it could give

1. **PVQ decode (42–56%).** Arithmetic decoding is inherently serial —
   each bit depends on the last — so there is no SIMD win here. What
   can improve is the range decoder's inner loop (`ec_dec` fast paths,
   batch bit extraction) and bounds-check-free pulse loops. This is the
   hardest stage to speed up a lot. Realistic: **10–25% off the stage
   → 4–10% of total decode.**
2. **IMDCT (17–32%).** The crate already has AVX pre/post-rotation
   kernels, but the FFT butterflies look mostly scalar on this path
   (capping the whole crate at scalar only costs decode ~10%, vs 35%
   on encode). libopus uses a SIMD radix FFT. A vectorised FFT /
   butterfly pass is the most mechanical win here. Realistic:
   **20–40% off the stage → 4–8% of total decode.**
3. **Postfilter + deemphasis (16–35%).** The comb filter is a serial
   IIR recurrence — it cannot be vectorised across samples — but the
   per-sample work (clamps, gain math, memory layout) can be tightened
   toward libopus's lean fixed-point version. Realistic: **15–30% off
   the stage → 3–7% of total decode.**
4. **Everything else (~15% combined).** Micro-optimisations only,
   ~1–2% of total decode.

## The estimate

| scenario | decode (48 kHz stereo, 10 s) | vs libopus | overall bench* | effort |
| --- | --- | --- | --- | --- |
| today (v0.1.1, SIMD conversion) | 28.6 ms | 0.78x | 1.15x | — |
| realistic fork (1–2 week focused pass on the 3 stages) | ~22–24 ms | ~0.88–0.95x | ~1.20–1.23x | 1–2 weeks + rebase per upstream release |
| ceiling (full libopus parity, sustained effort) | ~19–20 ms | ~1.0x | ~1.27x | weeks, diminishing returns |

\* Overall bench = encode 67 ms + decode; encode is already 1.31x and
is untouched by this work, so even full decode parity only moves the
overall figure from 1.15x to ~1.27x.

## Actual outcome (v0.2.0, 2026-11-13) — the estimate was too optimistic

The fork was built (`vendor/rusty-opus/`, `[patch.crates-io]`,
`vendor/rusty-opus/PATCHES.md`) and the estimate's leads were measured
one by one before implementing. Result: **decode 28.6 → 27.8 ms**
(0.78x → 0.80x vs libopus, overall still 1.15x) — not the 22–24 ms
the estimate promised. What the estimate got wrong:

- **PVQ's biggest chunk is scaffolding, not a hot loop.** A finer
  profile showed `decode_pulses` is only ~24% of the PVQ bucket; the
  rest is per-band scaffolding (`quant_partition` recursion,
  `compute_theta`, Haar, dispatch) that does not vectorise and has no
  single function to fix. The range decoder itself is already tight.
- **The `cwrsi`/`compute_u` lead was dead.** `compute_u` fires **0
  times** on the whole corpus (the table covers all real content), and
  the linear scans average 2–12 steps — under 0.2 ms total. A binary
  search would be no faster.
- **The FFT lead did not vectorise.** Extracting the radix-2 `m > 1`
  stage into an `avx` function (the crate's own pattern) left decode
  unchanged — LLVM does not auto-vectorise its strided 8-element
  groups. Only an explicit-intrinsic kernel could move it, and that was
  judged not worth the shuffle-heavy code for ~1 ms.
- **The postfilter was already optimised.** The comb filter has
  AVX2+FMA kernels; it dominates the post stage and has little headroom.
  Deemphasis is a serial IIR and genuinely unvectorisable.
- **The profiler overstated the rotatable portions.** Its inflated
  absolutes made `exp_rotation` look like 3.6 ms; the real gain from
  its AVX2/SSE2 kernels is ~2–3%, and only the stride-2 pass benefits
  (stride-1 is a serial recurrence).

What worked: `exp_rotation1` AVX2/SSE2 (bit-identical, unit-tested),
`dec_bits`/`read_byte`/`unext` inlining, and the SIG_SAT clamp slicing
— together ~3%. The ceiling (~19–20 ms) is still a theoretical target,
but reaching it needs the hard work this estimate flagged (a PVQ
range-decoder rework, explicit-intrinsic FFT, postfilter restructure),
not a 1–2 week pass. The fork's checks (pristine-vs-patched bit
parity, 44/44; JS interop vs libopus within 1 s16 LSB; PLC sanity)
all pass, and the fork is kept because the ~3% is real and the harness
makes future patches cheap to validate.

## Actual outcome, continued — FFT `m > 1` AVX kernels (2026-11-13)

Phuong asked to go after the FFT anyway ("hope get back 10% is already
big win"). Measured first with the profiler (new `mdct-fft` / `fft-m1` /
`fft-m>1` stages): the FFT is 4.4 ms of decode on every content type
(~12% on sine), and the `m > 1` stages are 3.8 ms (~11%) — so the
ceiling for all FFT `m > 1` work is ~11%, and a 2–3x kernel speedup
would give ~5–7%. The stage walk for nfft = 480 is radix-4 (m = 1),
radix-2 (m = 4), radix-4 (m = 8), radix-3 (m = 32), radix-5 (m = 96);
work is spread evenly across radices 2/3/4/5 (18/25/28/29%).

Explicit-intrinsic AVX kernels were built for all four radices' `m > 1`
stages (`vendor/rusty-opus/src/kiss_fft.rs`, patch 4 in
`vendor/rusty-opus/PATCHES.md`): `avx_cmul_4` (mirrors the NEON
`neon_cmul_2`), `avx_load_twiddles_4`, and rewritten
`kf_bfly4/5/3_avx_inner` plus a new `kf_bfly2_mm_avx`. The radix-2
kernel is the awkward one — its twiddles are factored constants, so a
general complex multiply would not be bit-exact and the twiddled
operand is built lane by lane. All four are guarded by bit-exact unit
tests (exact `to_bits()` vs scalar) and the parity harness.

Result (JS bench, best of 3, this VM): decode **32.5 → ~30.1 ms**
(~7.5% faster), ratio vs libopus **0.77x → 0.82x**, overall
**1.16x → 1.23x**. Encode also improves (80.8 → 75.7 ms, 1.32x →
1.40x) because encode uses the same FFT. Radix-4 alone gave ~0.6 ms;
radix-5 + radix-3 gave ~1.9 ms more; radix-2 gave ~0.1 ms (within
noise). Short of the hoped-for 10%: the `m > 1` stages were only ~11%
of decode and the kernels recovered ~2.4 of those 3.8 ms; the rest
(PVQ scaffolding, postfilter, rotations) does not vectorise. The
remaining gap to libopus (~25.3 ms decode) is now ~5 ms, mostly the
serial PVQ/postfilter work identified in the original estimate.

## Caveats

- The realistic case assumes the three stages respond as estimated;
  PVQ is the swing factor (it is 42–56% of decode and the hardest to
  move — if it only gives 10%, the realistic total lands near 24 ms).
- Decode must stay bit-exact: the crate's RFC test vectors guard
  correctness, so every optimisation has to be validated against them.
  That is included in the effort estimate.
- A fork means maintenance: the patch set has to be rebased onto each
  upstream release (small if the patches stay localised to
  `quant_all_bands`/`decode_pulses`, `mdct`/`kiss_fft`, and the
  postfilter). Alternatively, the same patches could go upstream as
  contributions — the crate's profiler is encode-only, which suggests
  decode has simply had less optimisation attention so far.
- ROI depends on workload: this only helps decode. Voice Studio mostly
  encodes (TTS output); a Discord bot that mostly decodes incoming
  voice would gain more. For 16 kHz SILK *encode* (measured ~3x slower
  than libopus) the crate has a separate, larger problem — not covered
  by this estimate.

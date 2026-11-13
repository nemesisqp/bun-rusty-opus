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

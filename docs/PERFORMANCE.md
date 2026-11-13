# Performance

Measured with `bench/bench.mjs` (10 s of 48 kHz stereo sine, 20 ms frames,
500 frames, best of 3 rounds). Run it yourself with `npm run bench` (Node)
or `bun bench/bench.mjs`.

## Numbers on this machine

Host: the assistant's Linux VM, shared 1.5 CPU, x86_64, portable
(non-native) release build. Numbers are indicative, not a general claim —
re-run the bench on your own hardware.

| codec (bitrate matched at 64 kbps) | encode | decode | total |
| --- | --- | --- | --- |
| bun-rusty-opus (v0.1.1) | ~68 ms | ~29 ms | ~97 ms |
| @discordjs/opus 0.11.0 (libopus) | ~88 ms | ~22 ms | ~110 ms |

Across runs: **encode 1.27–1.39x faster, decode 0.66–0.77x (slower),
overall 1.09–1.15x**. Both codecs run ~90–100x realtime on this VM
(~4900–5200 frames/s). v0.1.0 decoded at ~33 ms; v0.1.1's SIMD
f32→i16 conversion (below) brought it to ~29 ms.

### What the "1.5x faster" claim really means

The rusty-opus crate advertises ~1.50x libopus on CELT encode
(1.60x stereo music) and says SILK is within 4% — **encode only**.
Our measurements agree with that shape: the encode win is real, but
decode is slower than libopus, so the end-to-end win is smaller than
1.5x and depends on your encode/decode mix. An app that mostly encodes
(Discord bot sending voice, a TTS pipeline) gains more than one that
mostly decodes. Do not quote "1.5x faster" as an overall figure.

The bench matches bitrates explicitly (both at 64000 bps) because the
defaults differ: bun-rusty-opus defaults to 64000 bps, @discordjs/opus
(libopus `OPUS_AUTO`) defaults to 120000 bps. Comparing defaults would
measure bitrate, not codec speed. Packet totals at matched bitrate are
within a few percent (1.03–1.28x across 32–96 kbps on the same sine).

## Reuse path

`encodeInto`/`decodeInto` with a pre-allocated output buffer cost the
same wall time as the allocating `encode`/`decode` (~68 ms / ~28 ms for
the same 10 s) — the win is not wall time, it is **zero allocations per
frame**: no Buffer per packet, no GC pressure at 50 frames/s/stream.
That is the point of the reuse API; measure it with a GC-heavy workload
if you want to see the difference.

## Why decode is slower than libopus, and what was fixed (v0.1.1)

Measured on this VM for 10 s of 48 kHz stereo, 20 ms frames (500 frames),
decode broken down (probes in `examples/` and `bench/probe-decode.mjs`):

| stage | time | note |
| --- | --- | --- |
| rusty-opus `OpusDecoder::decode` (pure Rust, no napi) | 28.3 ms | the codec itself; libopus decodes the same audio in ~22 ms |
| our f32→i16 conversion (scalar loop) | 4.6 ms | **fixed in v0.1.1, see below** |
| `Buffer::from` per packet (allocating `decode` only) | ~2 ms | avoided by `decodeInto` |
| napi call + JS wrapper | ~1 ms | `finalRange()` measures 0.69 µs/call |

**Fixed: SIMD f32→i16 conversion.** The scalar conversion loop
(`clamp, *32767, .round(), saturate`) costs 4.55 ms per 960k samples
because `.round()` defeats auto-vectorisation on the portable SSE2
baseline; a plain cast costs 0.87 ms. `src/lib.rs` now converts with
runtime-dispatched SIMD kernels (AVX2 16-wide / SSE2 8-wide on x86_64,
NEON on aarch64, scalar tail + fallback) — same portable binary
baseline, no `target-cpu=native`. Decode went 33.1 → 28.7 ms in
`bench.mjs` (0.66x → 0.77x vs libopus), `decodeInto` 31.7 → 27.7 ms.
Rounding differs by at most 1 LSB on exact-half values (SIMD uses
round-to-nearest-even, scalar round-half-away-from-zero); Rust unit
tests assert agreement within 1 LSB. The i16→f32 encode conversion was
already vectorised (0.72 ms) and left alone.

**Ruled out (measured, not assumed):**
- *Allocations:* the crate allocates 0 times per frame in steady state
  (counting allocator, `examples/alloc-count.rs`) — a custom allocator
  (mimalloc, as upstream's benches use) would not help.
- *Denormals / FTZ:* setting FTZ+DAZ changed decode by 1.00x.
- *SIMD dispatch:* `RUSTY_OPUS_ISA=scalar` decode is 31.5 ms vs 28.3 ms
  with AVX2 — dispatch works, it just only buys ~10% on decode (vs 35%
  on encode: 111.6 → 72.6 ms). The decode hot paths are mostly scalar
  in the crate.
- *Native CPU flags:* a `target-cpu=native` build decoded at 31.2 ms
  vs 33–34 ms portable — ~2 ms, within noise; not the cause.
- *Packet content:* each codec decoding the *other's* packets shows the
  same gap, so it is the decoder, not the packets.

**Remaining gap (~6 ms pure-Rust) is inside rusty-opus decode itself:**
SILK-only decode (≤ 16 kHz) is at parity or faster than libopus
(12.7 vs 12.9 ms at 16 kHz mono, 7.0 vs 12.0 ms at 8 kHz); the gap is
CELT/Hybrid wideband decode at 24/48 kHz (28.3 vs ~22 ms), in both the
content-dependent part (sine − silence ≈ 10 ms) and the fixed part
(silence alone: 17.8 ms pure Rust, 25.6 ms through JS, vs libopus
15.3 ms). Fixing that means optimising the crate's decode internals
(MDCT/PVQ/range-decoder paths) — upstream work, not a binding change.
It is not attempted here.

**Known limitation, same area:** SILK *encode* at 16 kHz mono is ~3x
slower than libopus in rusty-opus (153 ms vs 51 ms for 10 s) — the
crate's "SILK within 4%" claim does not hold there on this VM. The
48 kHz encode win (1.3x) is unaffected. Not fixed in this release.

## Pre-skip (end-to-end delay)

rusty-opus does **not** pad its output to libopus's uniform 312 samples.
Its delay follows the coding mode, measured here by cross-correlating a
chirp through encode → decode:

| rate | voip / audio | lowDelay |
| --- | --- | --- |
| 8000 Hz | 52 | 20 |
| 12000 Hz | 78 | 30 |
| 16000 Hz | 104 | 40 |
| 24000 Hz | 60 | 60 |
| 48000 Hz | 120 | 120 |

Rule: SILK-only (voip/audio at ≤ 16 kHz) → `round(rate * 312 / 48000)`;
CELT-only / Hybrid (lowDelay at any rate; voip/audio above 16 kHz) →
`round(rate * 120 / 48000)`. Exposed as `encoder.preSkip` and
`opusPreSkip(rate, application)`. Use it as the Ogg OpusHead pre-skip
for streams encoded here — writing libopus's 312 for a 48 kHz
CELT/Hybrid stream would trim 192 real samples (~4 ms) off the start.

Cross-checked against @discordjs/opus: libopus round-trips at 312 in
every mode (its own pre-skip), and the two codecs decode each other's
packets correctly (`test/interop.test.mjs`) once each side is aligned by
its own pre-skip.

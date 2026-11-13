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
| bun-rusty-opus | ~68 ms | ~33 ms | ~102 ms |
| @discordjs/opus 0.11.0 (libopus) | ~87–110 ms | ~22–26 ms | ~109–135 ms |

Across runs: **encode 1.27–1.39x faster, decode 0.58–0.74x (slower),
overall 1.05–1.16x**. Both codecs run ~90–100x realtime on this VM
(~4900 frames/s).

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
same wall time as the allocating `encode`/`decode` (~68 ms / ~32 ms for
the same 10 s) — the win is not wall time, it is **zero allocations per
frame**: no Buffer per packet, no GC pressure at 50 frames/s/stream.
That is the point of the reuse API; measure it with a GC-heavy workload
if you want to see the difference.

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

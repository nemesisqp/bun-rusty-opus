# @ndqp/bun-rusty-opus

> **Personal project — quick test, not production ready.** This is an
> experiment for trying out rusty-opus under Bun/Node. It is not
> hardened, not audited, and not supported for production use. If you
> need a production Opus binding, use
> [@discordjs/opus](https://www.npmjs.com/package/@discordjs/opus) —
> the battle-tested libopus binding whose API this project mirrors.

Bun/Node bindings to [rusty-opus](https://crates.io/crates/rusty-opus) — a
**pure-Rust Opus codec** (RFC 6716/8251, no C, no libopus, no FFI) by
jinti and the Remade-With-Rust team (see [Credits](#credits)).
Drop-in replacement for
[@discordjs/opus](https://www.npmjs.com/package/@discordjs/opus), with the
same `OpusEncoder` shape discord.js voice uses — but the codec underneath
is Rust, and encode is faster. This project is only the thin binding
between the two; the codec and the API it mirrors are other people's
work, credited below.

## Install

```sh
npm install @ndqp/bun-rusty-opus
# or
bun install @ndqp/bun-rusty-opus
```

**Prebuilt binaries only.** The package ships napi prebuilts for 7
platforms (below). There is no install-time build and no fallback to
compiling from source: if no prebuilt fits your machine, install **fails**
with a clear error (`ERR_BUN_RUSTY_OPUS_NO_PREBUILT`) instead of silently
building — or silently succeeding and breaking at first use. If you are
developing this package itself, `npm run build` (or
`scripts/build-local.sh` for a `target-cpu=native` dev build) is the way.

| OS | x86_64 | arm64 |
| --- | --- | --- |
| macOS | — (Intel Mac unsupported) | `darwin-arm64` |
| Windows | `win32-x64-msvc` | `win32-arm64-msvc` |
| Linux glibc | `linux-x64-gnu` | `linux-arm64-gnu` |
| Linux musl (Alpine) | `linux-x64-musl` | `linux-arm64-musl` |

Requires Node >= 18 or Bun >= 1.3.

## Usage

```js
import { OpusEncoder, OpusDecoder } from '@ndqp/bun-rusty-opus';

const encoder = new OpusEncoder(48000, 2); // rate, channels; defaults 48000/2
const packet = encoder.encode(pcmBuffer);   // 20 ms s16le frame (3840 bytes) -> Opus
const pcm = encoder.decode(packet);         // Opus packet -> s16le PCM

const decoder = new OpusDecoder(48000, 2); // decode-only, same decoder
```

`frameSize` (samples per channel) is inferred when omitted: from the PCM
buffer length for `encode`, from the packet TOC byte for `decode`. Valid
frame sizes are 2.5/5/10/20/40/60 ms (and up to 120 ms in the codec); rates
8000/12000/16000/24000/48000; channels 1/2.

### Zero-allocation hot path

For 50 frames/s/stream, `encode` allocates a Buffer per packet. Reuse one
output buffer instead — no allocation per frame, no GC pressure:

```js
const outPacket = Buffer.alloc(1276);   // max Opus packet size
const outPcm = Buffer.alloc(3840);      // one 20 ms stereo frame
const n = encoder.encodeInto(pcmBuffer, outPacket, 960);   // n = bytes written
const m = encoder.decodeInto(packet, outPcm, 960);         // m = PCM bytes written
```

The encoder also reuses a scratch f32 buffer internally and makes no heap
allocation per frame after warm-up.

### Options

```js
new OpusEncoder(48000, 2, {
  application: 'audio',   // 'voip' | 'audio' (default) | 'lowDelay'
  bitrate: 64000,         // default 64000 (see note below)
  complexity: 9,          // 0-10, default 9
  fec: false,             // in-band forward error correction
  packetLoss: 0,          // expected loss, 0-100%
  cbr: false, dtx: false,
  bandwidth: 'auto', maxBandwidth: 'fullband', signal: 'auto',
  lsbDepth: 16,           // 16 for s16 source (default)
});
```

Also available, all @discordjs/opus-compatible: `setBitrate`/`getBitrate`,
`setFEC`, `setPLP` (alias `setPacketLoss`), `setComplexity`, `setCBR`,
`setDTX`, `setBandwidth`, `setMaxBandwidth`, `setSignal`, `setLsbDepth`,
`applyEncoderCTL` (libopus CTL codes 4002/4006/4008/4009/4010/4012/4014/
4016/4024/4036; 4000 application is rejected — set it in the constructor),
`applyDecoderCTL` (always throws: rusty-opus exposes no decoder controls),
`decodeFec(packet, frameSize)`, `decodePacketLoss(frameSize)`,
`finalRange()` / `lastRange()`. Helpers: `packetFrameSize(packet, rate)`,
`opusPreSkip(rate, application)`.

## Differences from @discordjs/opus

These are deliberate, measured, and tested (`test/interop.test.mjs`
decodes each codec's packets with the other):

- **Default bitrate is 64000 bps; @discordjs/opus defaults to 120000 bps**
  (libopus `OPUS_AUTO`). If you switch and want identical output sizes,
  set the bitrate explicitly. At matched bitrate, packet totals are within
  a few percent.
- **Pre-skip is not 312.** libopus pads every stream to a 312-sample
  delay; rusty-opus does not. Its real end-to-end delay is 120 samples at
  48 kHz for CELT/Hybrid modes and 312 (scaled by rate) for SILK-only
  (voip/audio ≤ 16 kHz). Read it from `encoder.preSkip` and use it as the
  Ogg OpusHead pre-skip — writing 312 for a 48 kHz CELT/Hybrid stream
  trims 192 real samples (~4 ms) off the start. See `docs/PERFORMANCE.md`
  for the measured table.
- **No separate native decoder module** — same as @discordjs/opus: one
  class encodes and decodes; `OpusDecoder` is a decode-only convenience.
- **Pure Rust, no libopus.** rusty-opus is a from-scratch Rust port of
  libopus 1.6, bit-exact on the RFC test vectors, and interoperates with
  libopus both ways.

## Performance

Measured on this VM (shared 1.5 CPU, portable build), 10 s of 48 kHz
stereo, 20 ms frames, bitrate matched at 64 kbps — see
`docs/PERFORMANCE.md` for method and full numbers:

- **encode ~1.3x faster** than @discordjs/opus (libopus)
- **decode ~0.77x** (slower than libopus; was 0.66x before v0.1.1's SIMD
  f32→i16 conversion — see `docs/PERFORMANCE.md` for the breakdown)
- **overall ~1.15x**

The crate's "1.5x faster" claim is about **encode** (CELT), which our
measurements support (1.27–1.39x). It is not an overall figure, and this
README does not present it as one. Both codecs run ~90–100x realtime here.

## Why no `target-cpu=native` in the published builds?

The project brief suggested compiling with native CPU flags. That would be
a bug in a published prebuilt: a binary built with `-C target-cpu=native`
on a CI runner can crash with an illegal instruction on a user's older
CPU. rusty-opus already dispatches SIMD at runtime (AVX2/AVX/FMA/SSE2 on
x86_64, NEON on arm64; `RUSTY_OPUS_ISA` can cap it), so the portable build
still uses the fast paths. The release profile uses opt-level 3, fat LTO,
and single codegen unit instead. `scripts/build-local.sh` offers
`target-cpu=native` for your own machine only.

## Development

```sh
npm ci
npm run build        # napi build --platform --release
npm test             # node:test, incl. interop tests vs @discordjs/opus
npm run test:bun     # bun test (interop tests skip: @discordjs/opus has no Bun prebuild)
npm run bench        # bench/bench.mjs
npm run typecheck    # tsc --noEmit
cargo clippy --all-targets -- -D warnings
```

Releasing: push a `v*` tag; `.github/workflows/release.yml` builds all 8
prebuilts and publishes the main package plus the platform packages to
npm (needs the `NPM_TOKEN` secret). `docs/DESIGN.md` documents the
binding layout, the loader, and the gotchas found while building this.

## Credits

This project is a thin binding — almost all of the hard work is other
people's:

- **rusty-opus** — the codec itself: a pure-Rust port of libopus by
  **jinti** (`shenjindi@fourz.cn`) and the **Remade-With-Rust** team
  ([github.com/Remade-With-Rust/rusty-opus](https://github.com/Remade-With-Rust/rusty-opus),
  BSD-3-Clause). The SILK/CELT/Hybrid implementation, the SIMD kernels,
  the bit-exact RFC test vectors — all theirs. The current release
  vendors their 1.1.0 release with a few small decode patches (see
  `vendor/rusty-opus/PATCHES.md`); the patches are mine, the codec is
  theirs.
- **The Opus codec** — rusty-opus is a port of libopus, whose authors
  are Xiph.Org, Skype Limited, Octasic, Jean-Marc Valin, Timothy B.
  Terriberry and contributors (full copyright notice in
  `vendor/rusty-opus/COPYING`).
- **@discordjs/opus** — by **iCrawl** (`icrawltogo@gmail.com`) and the
  discord.js team ([github.com/discordjs/opus](https://github.com/discordjs/opus),
  MIT). This binding mirrors its `OpusEncoder` API and uses it as the
  interop reference in every test and bench. If this project looks
  familiar, that is why.
- **napi-rs** — the binding framework that makes the Rust↔JS boundary
  work.

## License

MIT for the binding code in this repo. rusty-opus (including the
vendored copy in `vendor/rusty-opus/`) is BSD-3-Clause; @discordjs/opus
is MIT. See `vendor/rusty-opus/COPYING` for the codec's copyright
notice.

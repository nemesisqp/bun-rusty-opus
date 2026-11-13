// Basic usage: encode a 1 s sine wave, decode it back.
// Run: bun examples/basic.mjs  (after `npm run build`)
import { OpusEncoder } from 'bun-rusty-opus';

const encoder = new OpusEncoder(48000, 2);
const samples = 48000;
const pcm = Buffer.alloc(samples * 2 * 2);
for (let i = 0; i < samples; i++) {
  const s = Math.round(Math.sin((2 * Math.PI * 440 * i) / 48000) * 0.5 * 32767);
  pcm.writeInt16LE(s, i * 4);
  pcm.writeInt16LE(s, i * 4 + 2);
}

let totalPacketBytes = 0;
const decoded = [];
for (let off = 0; off < pcm.length; off += 960 * 2 * 2) {
  const packet = encoder.encode(pcm.subarray(off, off + 960 * 2 * 2), 960);
  totalPacketBytes += packet.length;
  decoded.push(encoder.decode(packet, 960));
}
console.log(`encoded 1 s of stereo audio into ${totalPacketBytes} bytes of Opus`);
console.log(`decoded back to ${Buffer.concat(decoded).length} bytes of PCM`);

// Zero-alloc path: reuse one output buffer for every frame.
const out = Buffer.alloc(1276);
const frame = pcm.subarray(0, 960 * 2 * 2);
console.log(`encodeInto wrote ${encoder.encodeInto(frame, out)} bytes into the reused buffer`);

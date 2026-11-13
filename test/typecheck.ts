// Compile-only check that index.d.ts matches the documented API.
import { OpusEncoder, OpusDecoder, OPUS_CTL, packetFrameSize } from '../index.js';

const enc = new OpusEncoder(48000, 2, { application: 'audio', bitrate: 64000, fec: true });
const pcm: Buffer = enc.decode(enc.encode(Buffer.alloc(960 * 2 * 2)));
const n: number = enc.encodeInto(Buffer.alloc(960 * 2 * 2), Buffer.alloc(1276));
enc.setBitrate(32000);
const bitrate: number = enc.getBitrate();
enc.setPLP(10);
enc.applyEncoderCTL(OPUS_CTL.SET_BITRATE, 48000);
const size: number = packetFrameSize(pcm, 48000);
const dec = new OpusDecoder(48000, 1);
const out: Buffer = dec.decode(pcm);
void n; void bitrate; void size; void out; void dec;

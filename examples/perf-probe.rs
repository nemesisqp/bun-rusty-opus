//! Profiling probe: where does decode time go?
//!
//! Times, for a given config, each stage in isolation (pure rusty-opus, no
//! napi, no JS):
//!   1. `OpusEncoder::encode` (f32 in, packet out)
//!   2. `OpusDecoder::decode` (packet in, f32 out)
//!   3. the i16 -> f32 conversion our binding does on encode input
//!   4. the f32 -> i16 conversion our binding does on decode output
//!   5. full round-trip: convert in, encode, decode, convert out
//!
//! Run: `cargo run --release --example perf-probe`
//! Env: `RUSTY_OPUS_ISA=scalar|sse2|avx|avx2` caps the crate's SIMD dispatch.

use rusty_opus::{Application, OpusDecoder, OpusEncoder};
use std::time::Instant;

fn sine_f32(seconds: f32, rate: i32, channels: usize) -> Vec<f32> {
    let n = (rate as f32 * seconds) as usize;
    let mut buf = vec![0.0f32; n * channels];
    for i in 0..n {
        let s = (2.0 * std::f32::consts::PI * 440.0 * i as f32 / rate as f32).sin() * 0.5;
        for c in 0..channels {
            buf[i * channels + c] = s;
        }
    }
    buf
}

#[inline]
fn i16_to_f32(sample: i16) -> f32 {
    sample as f32 / 32768.0
}

#[inline]
fn f32_to_i16(sample: f32) -> i16 {
    let v = (sample.clamp(-1.0, 1.0) * 32767.0).round() as i32;
    v.clamp(-32768, 32767) as i16
}

fn best_of<F: FnMut()>(mut f: F, rounds: usize) -> f64 {
    let mut best = f64::MAX;
    for _ in 0..rounds {
        let t0 = Instant::now();
        f();
        best = best.min(t0.elapsed().as_secs_f64() * 1000.0);
    }
    best
}

fn probe(rate: i32, channels: usize, app: Application, app_name: &str) {
    let frame = (rate as usize) / 50; // 20 ms
    let pcm = sine_f32(10.0, rate, channels);
    let frames: Vec<&[f32]> = pcm.chunks_exact(frame * channels).collect();
    let n_frames = frames.len();

    // Encode once to get packets.
    let mut enc = OpusEncoder::new(rate, channels, app).unwrap();
    enc.bitrate_bps = 64000;
    enc.lsb_depth = 16;
    let mut pkt_buf = vec![0u8; 1276];
    let packets: Vec<Vec<u8>> = frames
        .iter()
        .map(|f| {
            let n = enc.encode(f, frame, &mut pkt_buf).unwrap();
            pkt_buf[..n].to_vec()
        })
        .collect();

    let mut dec = OpusDecoder::new(rate, channels).unwrap();
    let mut f32_out = vec![0.0f32; frame * channels];
    let mut i16_buf = vec![0i16; frame * channels];

    let enc_ms = best_of(
        || {
            let mut e = OpusEncoder::new(rate, channels, app).unwrap();
            e.bitrate_bps = 64000;
            e.lsb_depth = 16;
            let mut b = [0u8; 1276];
            for f in &frames {
                let _ = e.encode(f, frame, &mut b).unwrap();
            }
        },
        3,
    );
    let dec_ms = best_of(
        || {
            for p in &packets {
                let _ = dec.decode(p, frame, &mut f32_out).unwrap();
            }
        },
        3,
    );
    let conv_in_ms = best_of(
        || {
            // i16 -> f32 over the same sample count (simulate from i16 pcm)
            let mut scratch = vec![0.0f32; frame * channels];
            for f in &frames {
                for (i, &v) in f.iter().enumerate() {
                    scratch[i] = i16_to_f32((v * 32767.0) as i16);
                }
            }
        },
        3,
    );
    let conv_out_ms = best_of(
        || {
            for _ in 0..n_frames {
                for (i, &v) in f32_out.iter().enumerate() {
                    i16_buf[i] = f32_to_i16(v);
                }
            }
        },
        3,
    );
    // Full round-trip through our binding's stages (encode + decode + both
    // conversions, fresh encoder/decoder each round).
    let rt_ms = best_of(
        || {
            let mut e = OpusEncoder::new(rate, channels, app).unwrap();
            e.bitrate_bps = 64000;
            e.lsb_depth = 16;
            let mut d = OpusDecoder::new(rate, channels).unwrap();
            let mut f32_in = vec![0.0f32; frame * channels];
            let mut f32o = vec![0.0f32; frame * channels];
            let mut b = [0u8; 1276];
            for f in &frames {
                for (i, &v) in f.iter().enumerate() {
                    f32_in[i] = i16_to_f32((v * 32767.0) as i16);
                }
                let n = e.encode(&f32_in, frame, &mut b).unwrap();
                let m = d.decode(&b[..n], frame, &mut f32o).unwrap();
                for (i, &v) in f32o[..m * channels].iter().enumerate() {
                    i16_buf[i] = f32_to_i16(v);
                }
            }
        },
        3,
    );

    println!(
        "{:>5}Hz {:<2}ch {:<9} encode {:6.1} ms  decode {:6.1} ms  conv-in {:5.1} ms  conv-out {:5.1} ms  round-trip {:6.1} ms  ({:.1}x realtime dec)",
        rate,
        channels,
        app_name,
        enc_ms,
        dec_ms,
        conv_in_ms,
        conv_out_ms,
        rt_ms,
        10_000.0 / dec_ms
    );
}

fn main() {
    println!("10 s audio, 20 ms frames, best of 3, pure rusty-opus (no napi/JS)");
    println!(
        "ISA cap: {:?}",
        std::env::var("RUSTY_OPUS_ISA").unwrap_or_default()
    );
    probe(48000, 2, Application::Audio, "audio");
    probe(48000, 1, Application::Audio, "audio");
    probe(48000, 2, Application::Voip, "voip");
    probe(48000, 2, Application::RestrictedLowDelay, "lowDelay");
    probe(16000, 1, Application::Voip, "voip");
    probe(16000, 1, Application::Audio, "audio");
    probe(8000, 1, Application::Voip, "voip");
}

//! Decode-profile probe: what dominates rusty-opus decode time?
//!   * silence vs sine vs noise packets (entropy decode vs IMDCT)
//!   * frame size sweep (per-frame vs per-sample cost)
//!
//! Run: `cargo run --release --example decode-profile`

use rusty_opus::{Application, OpusDecoder, OpusEncoder};
use std::time::Instant;

fn pcm(kind: &str, seconds: f32, rate: i32, channels: usize) -> Vec<f32> {
    let n = (rate as f32 * seconds) as usize;
    let mut buf = vec![0.0f32; n * channels];
    // Deterministic pseudo-noise (xorshift) — no rand dependency.
    let mut state: u32 = 0x1234_5678;
    for i in 0..n {
        let s = match kind {
            "silence" => 0.0,
            "sine" => (2.0 * std::f32::consts::PI * 440.0 * i as f32 / rate as f32).sin() * 0.5,
            "noise" => {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                (state as f32 / u32::MAX as f32 - 0.5) * 0.9
            }
            _ => 0.0,
        };
        for c in 0..channels {
            buf[i * channels + c] = s;
        }
    }
    buf
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

fn main() {
    let rate = 48000;
    let channels = 2usize;
    let app = Application::Audio;

    // 1. Content sweep at 20 ms frames.
    for kind in ["silence", "sine", "noise"] {
        let frame = 960;
        let p = pcm(kind, 10.0, rate, channels);
        let frames: Vec<&[f32]> = p.chunks_exact(frame * channels).collect();
        let mut enc = OpusEncoder::new(rate, channels, app).unwrap();
        enc.bitrate_bps = 64000;
        let mut b = [0u8; 1276];
        let packets: Vec<Vec<u8>> = frames
            .iter()
            .map(|f| {
                let n = enc.encode(f, frame, &mut b).unwrap();
                b[..n].to_vec()
            })
            .collect();
        let avg_pkt = packets.iter().map(|p| p.len()).sum::<usize>() as f64 / packets.len() as f64;
        let mut dec = OpusDecoder::new(rate, channels).unwrap();
        let mut out = vec![0.0f32; frame * channels];
        let dec_ms = best_of(
            || {
                for p in &packets {
                    let _ = dec.decode(p, frame, &mut out).unwrap();
                }
            },
            5,
        );
        println!(
            "content {:<8} avg packet {:6.1} B  decode {:6.1} ms",
            kind, avg_pkt, dec_ms
        );
    }

    // 2. Frame-size sweep (sine): same 10 s, different frames per call.
    for ms in [2.5f32, 5.0, 10.0, 20.0, 40.0, 60.0] {
        let frame = (rate as f32 * ms / 1000.0) as usize;
        let p = pcm("sine", 10.0, rate, channels);
        let frames: Vec<&[f32]> = p.chunks_exact(frame * channels).collect();
        let mut enc = OpusEncoder::new(rate, channels, app).unwrap();
        enc.bitrate_bps = 64000;
        let mut b = [0u8; 1276];
        let packets: Vec<Vec<u8>> = frames
            .iter()
            .map(|f| {
                let n = enc.encode(f, frame, &mut b).unwrap();
                b[..n].to_vec()
            })
            .collect();
        let mut dec = OpusDecoder::new(rate, channels).unwrap();
        let mut out = vec![0.0f32; frame * channels];
        let dec_ms = best_of(
            || {
                for p in &packets {
                    let _ = dec.decode(p, frame, &mut out).unwrap();
                }
            },
            5,
        );
        println!(
            "frame {:>4.1} ms  {:>4} frames  decode {:6.1} ms  ({:.2} us/frame)",
            ms,
            packets.len(),
            dec_ms,
            dec_ms * 1000.0 / packets.len() as f64
        );
    }
}

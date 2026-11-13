//! Decode stage breakdown using the crate's built-in `profile` feature.
//! Run: `cargo run --release --features profile --example decode-stages`
//! (Temporary estimation driver in the /tmp profiler copy of rusty-opus
//! 1.0.2; not part of the published crate.)

use rusty_opus::prof::{self, Stage};
use rusty_opus::{Application, OpusDecoder, OpusEncoder};
use std::time::Instant;

fn sine(seconds: f32, rate: i32, channels: usize) -> Vec<f32> {
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

fn main() {
    let rate = 48000;
    let channels = 2usize;
    let frame = 960;
    let passes = 20usize;
    for kind in ["sine", "silence", "noise"] {
        let pcm = match kind {
            "silence" => vec![0.0f32; (rate as f32 * 10.0) as usize * channels],
            "sine" => sine(10.0, rate, channels),
            _ => {
                let mut v = sine(10.0, rate, channels);
                let mut state: u32 = 0x1234_5678;
                for x in v.iter_mut() {
                    state ^= state << 13;
                    state ^= state >> 17;
                    state ^= state << 5;
                    *x = (state as f32 / u32::MAX as f32 - 0.5) * 0.9;
                }
                v
            }
        };
        let frames: Vec<&[f32]> = pcm.chunks_exact(frame * channels).collect();
        let mut enc = OpusEncoder::new(rate, channels, Application::Audio).unwrap();
        enc.bitrate_bps = 64000;
        enc.lsb_depth = 16;
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
        for p in &packets {
            dec.decode(p, frame, &mut out).unwrap();
        }
        prof::reset();
        let t0 = Instant::now();
        for _ in 0..passes {
            for p in &packets {
                dec.decode(p, frame, &mut out).unwrap();
            }
        }
        let wall = t0.elapsed().as_secs_f64() * 1000.0 / passes as f64;
        let s = prof::snapshot();
        let total = s[Stage::DecTotal as usize].0 / passes as f64;
        println!("{kind}: wall {wall:.1} ms/10s, DecTotal {total:.1} ms/10s");
        for i in 0..prof::N {
            let (ms, calls) = s[i];
            if calls > 0 && ms > 0.0 {
                println!(
                    "  {:<18} {:6.1} ms  {:>3.0}%  {} calls",
                    prof::name(i),
                    ms / passes as f64,
                    100.0 * ms / (total * passes as f64),
                    calls / passes as u64
                );
            }
        }
        // Residue: DecTotal minus the named decode stages.
        let named: f64 = [Stage::DecRange, Stage::DecPvq, Stage::DecPost]
            .iter()
            .map(|st| s[*st as usize].0)
            .sum::<f64>()
            + s[Stage::CeltMdct as usize].0;
        println!(
            "  {:<18} {:6.1} ms  {:>3.0}%  (residue: mode setup, log2amp, anti-collapse, PLC state, resample)",
            "dec-other",
            total - named / passes as f64,
            100.0 * (total - named / passes as f64) / total
        );
    }
}

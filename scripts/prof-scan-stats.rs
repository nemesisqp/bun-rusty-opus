//! Measure cwrsi linear-scan length and compute_u fallback frequency on
//! the libopus corpus. Run: `cargo run --release --example scan-stats`
//! (Temporary driver in the /tmp profiler copy of rusty-opus 1.0.2.)
use rusty_opus::OpusDecoder;
use std::fs;

fn read_packets(path: &str) -> Vec<Vec<u8>> {
    let b = fs::read(path).unwrap();
    let mut r = 0usize;
    let n = u32::from_le_bytes(b[r..r + 4].try_into().unwrap()) as usize;
    r += 4;
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        let len = u32::from_le_bytes(b[r..r + 4].try_into().unwrap()) as usize;
        r += 4;
        out.push(b[r..r + len].to_vec());
        r += len;
    }
    out
}

fn main() {
    let corpus = std::env::var("CORPUS").unwrap_or_else(|_| {
        format!(
            "{}/workspace/bun-rusty-opus/scripts/corpus/packets",
            std::env::var("HOME").unwrap()
        )
    });
    for (name, rate, ch, frame) in [
        ("48k-stereo-audio-64k-20ms", 48000, 2, 960),
        ("48k-stereo-audio-16k-20ms", 48000, 2, 960),
        ("48k-stereo-voip-64k-20ms", 48000, 2, 960),
        ("48k-stereo-lowdelay-64k-20ms", 48000, 2, 960),
        ("16k-mono-voip-24k-20ms", 16000, 1, 320),
        ("48k-stereo-audio-128k-10ms", 48000, 2, 480),
    ] {
        let packets = read_packets(&format!("{corpus}/{name}.bin"));
        let mut dec = OpusDecoder::new(rate, ch).unwrap();
        let mut out = vec![0.0f32; frame * ch];
        for p in &packets {
            dec.decode(p, frame, &mut out).unwrap();
        }
        let (steps, calls, compute_u) = rusty_opus::pvq::cwrsi_stats();
        println!(
            "{name}: cwrsi calls={calls}, scan steps={steps} (avg {:.2}/call), compute_u calls={compute_u}",
            steps as f64 / calls.max(1) as f64
        );
        rusty_opus::pvq::CWRSI_SCAN_STEPS.store(0, std::sync::atomic::Ordering::Relaxed);
        rusty_opus::pvq::CWRSI_CALLS.store(0, std::sync::atomic::Ordering::Relaxed);
        rusty_opus::pvq::COMPUTE_U_CALLS.store(0, std::sync::atomic::Ordering::Relaxed);
    }
}

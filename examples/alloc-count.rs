//! Allocation-count probe: does `OpusDecoder::decode` allocate per frame?
//! Wraps the system allocator with a counter (binary only — never do this
//! in the cdylib). Run: `cargo run --release --example alloc-count`

use rusty_opus::{Application, OpusDecoder, OpusEncoder};
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

static ALLOC_COUNT: AtomicUsize = AtomicUsize::new(0);
static ALLOC_BYTES: AtomicUsize = AtomicUsize::new(0);
static COUNTING: AtomicUsize = AtomicUsize::new(0);

struct Counting;

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if COUNTING.load(Ordering::Relaxed) == 1 {
            ALLOC_COUNT.fetch_add(1, Ordering::Relaxed);
            ALLOC_BYTES.fetch_add(layout.size(), Ordering::Relaxed);
        }
        System.alloc(layout)
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        System.dealloc(ptr, layout)
    }
}

#[global_allocator]
static GLOBAL: Counting = Counting;

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

fn reset() {
    ALLOC_COUNT.store(0, Ordering::Relaxed);
    ALLOC_BYTES.store(0, Ordering::Relaxed);
}

fn report(label: &str, frames: usize) {
    let c = ALLOC_COUNT.load(Ordering::Relaxed);
    let b = ALLOC_BYTES.load(Ordering::Relaxed);
    println!(
        "{:<28} {:>6} allocs / {:>4} frames ({:.2} allocs/frame, {:.0} B/frame)",
        label,
        c,
        frames,
        c as f64 / frames as f64,
        b as f64 / frames as f64
    );
}

fn main() {
    let rate = 48000;
    let channels = 2usize;
    let frame = 960;
    let pcm = sine(10.0, rate, channels);
    let frames: Vec<&[f32]> = pcm.chunks_exact(frame * channels).collect();

    // Warm up (allocations during init don't count).
    let mut enc = OpusEncoder::new(rate, channels, Application::Audio).unwrap();
    enc.bitrate_bps = 64000;
    let mut dec = OpusDecoder::new(rate, channels).unwrap();
    let mut b = [0u8; 1276];
    let mut out = vec![0.0f32; frame * channels];
    let packets: Vec<Vec<u8>> = frames
        .iter()
        .map(|f| {
            let n = enc.encode(f, frame, &mut b).unwrap();
            b[..n].to_vec()
        })
        .collect();
    for p in &packets {
        let _ = dec.decode(p, frame, &mut out).unwrap();
    }

    COUNTING.store(1, Ordering::Relaxed);
    reset();
    for f in &frames {
        let _ = enc.encode(f, frame, &mut b).unwrap();
    }
    COUNTING.store(0, Ordering::Relaxed);
    report("encode 500 frames", frames.len());

    COUNTING.store(1, Ordering::Relaxed);
    reset();
    for p in &packets {
        let _ = dec.decode(p, frame, &mut out).unwrap();
    }
    COUNTING.store(0, Ordering::Relaxed);
    report("decode 500 sine frames", packets.len());

    // Silence packets: encode silence first (outside counting).
    let silence = vec![0.0f32; frame * channels];
    let mut enc2 = OpusEncoder::new(rate, channels, Application::Audio).unwrap();
    enc2.bitrate_bps = 64000;
    let mut b2 = [0u8; 1276];
    let spackets: Vec<Vec<u8>> = (0..500)
        .map(|_| {
            let n = enc2.encode(&silence, frame, &mut b2).unwrap();
            b2[..n].to_vec()
        })
        .collect();
    COUNTING.store(1, Ordering::Relaxed);
    reset();
    for p in &spackets {
        let _ = dec.decode(p, frame, &mut out).unwrap();
    }
    COUNTING.store(0, Ordering::Relaxed);
    report("decode 500 silence frames", spackets.len());

    // PLC: empty packets.
    COUNTING.store(1, Ordering::Relaxed);
    reset();
    for _ in 0..500 {
        let _ = dec.decode(&[], frame, &mut out).unwrap();
    }
    COUNTING.store(0, Ordering::Relaxed);
    report("decode 500 PLC frames", 500);
}

//! Real cost of the f32 -> i16 / i16 -> f32 conversion loops our binding
//! runs per frame, with the result escaped so the optimizer cannot delete
//! the loop. Run: `cargo run --release --example conv-bench`

use std::hint::black_box;
use std::time::Instant;

#[inline]
fn i16_to_f32(sample: i16) -> f32 {
    sample as f32 / 32768.0
}

#[inline]
fn f32_to_i16(sample: f32) -> i16 {
    let v = (sample.clamp(-1.0, 1.0) * 32767.0).round() as i32;
    v.clamp(-32768, 32767) as i16
}

fn main() {
    // 960k samples = 500 frames of 48 kHz stereo 20 ms, same as the bench.
    let n = 960_000usize;
    let mut f32_in = vec![0.0f32; n];
    for (i, v) in f32_in.iter_mut().enumerate() {
        *v = ((i * 2654435761) as u32 as f32 / u32::MAX as f32 - 0.5) * 1.4;
    }
    let mut i16_in = vec![0i16; n];
    for (i, v) in i16_in.iter_mut().enumerate() {
        *v = ((i as i32 * 1103515245 + 12345) >> 16) as i16;
    }
    let mut f32_out = vec![0.0f32; n];
    let mut i16_out = vec![0i16; n];
    let mut pcm_bytes = vec![0u8; n * 2];

    fn time<F: FnMut()>(label: &str, mut f: F) {
        let mut best = f64::MAX;
        for _ in 0..7 {
            let t0 = Instant::now();
            f();
            best = best.min(t0.elapsed().as_secs_f64() * 1000.0);
        }
        println!("{:<42} {:6.2} ms", label, best);
    }

    time("i16 -> f32 (encode input, scalar loop)", || {
        for (i, &s) in i16_in.iter().enumerate() {
            f32_out[i] = i16_to_f32(s);
        }
        black_box(&f32_out);
    });
    time("f32 -> i16 (decode output, scalar loop)", || {
        for (i, &v) in f32_in.iter().enumerate() {
            i16_out[i] = f32_to_i16(v);
        }
        black_box(&i16_out);
    });
    time("f32 -> i16 + write LE bytes (as in decode_into)", || {
        for (i, &v) in f32_in.iter().enumerate() {
            pcm_bytes[i * 2..i * 2 + 2].copy_from_slice(&f32_to_i16(v).to_le_bytes());
        }
        black_box(&pcm_bytes);
    });
    time("f32 -> i16 via iterator collect (Vec alloc)", || {
        let v: Vec<i16> = f32_in.iter().map(|&s| f32_to_i16(s)).collect();
        black_box(&v);
    });
    // What the loop costs if the compiler could use round-to-nearest via
    // plain cast (no .round(), no clamp): a lower bound for a SIMD rewrite.
    time("f32 -> i16, cast only (lower bound)", || {
        for (i, &v) in f32_in.iter().enumerate() {
            i16_out[i] = (v * 32767.0) as i16;
        }
        black_box(&i16_out);
    });
}

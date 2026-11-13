//! Decode/encode driver for the pristine-vs-patched parity check.
//! Reads the corpus produced by `scripts/gen-corpus.mjs` (libopus packets)
//! and decodes it, or encodes raw s16 PCM — writing raw bytes to stdout so
//! the shell harness can hash and compare two builds bit-for-bit.
//!
//! Usage:
//!   parity-decode decode --packets <file> --rate R --channels C --frame F --mode normal|plc|fec
//!   parity-decode encode --pcm <file> --rate R --channels C --frame F --bitrate B --app audio|voip|lowdelay
//!
//! Modes: `normal` decodes every packet; `plc` replaces every 10th packet
//! with an empty input (packet-loss concealment); `fec` drops every 10th
//! packet and decodes the next one with `decode_fec`.

use rusty_opus::{Application, OpusDecoder, OpusEncoder};
use std::fs;
use std::io::Write;
use std::process::exit;

fn arg(name: &str) -> String {
    let args: Vec<String> = std::env::args().collect();
    for w in args.windows(2) {
        if w[0] == name {
            return w[1].clone();
        }
    }
    eprintln!("missing argument {name}");
    exit(2);
}

fn read_packets(path: &str) -> Vec<Vec<u8>> {
    let b = fs::read(path).unwrap_or_else(|e| {
        eprintln!("cannot read {path}: {e}");
        exit(2);
    });
    let mut r = 0usize;
    let take_u32 = |b: &[u8], r: &mut usize| -> u32 {
        let v = u32::from_le_bytes(b[*r..*r + 4].try_into().unwrap());
        *r += 4;
        v
    };
    let n = take_u32(&b, &mut r) as usize;
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        let len = take_u32(&b, &mut r) as usize;
        out.push(b[r..r + len].to_vec());
        r += len;
    }
    out
}

fn write_packets(packets: &[Vec<u8>]) {
    let mut out = Vec::new();
    out.extend_from_slice(&(packets.len() as u32).to_le_bytes());
    for p in packets {
        out.extend_from_slice(&(p.len() as u32).to_le_bytes());
        out.extend_from_slice(p);
    }
    std::io::stdout().write_all(&out).unwrap();
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mode = args.get(1).map_or("", String::as_str);
    match mode {
        "decode" => {
            let packets = read_packets(&arg("--packets"));
            let rate: i32 = arg("--rate").parse().unwrap();
            let channels: usize = arg("--channels").parse().unwrap();
            let frame: usize = arg("--frame").parse().unwrap();
            let dmode = arg("--mode");
            let mut dec = OpusDecoder::new(rate, channels).unwrap();
            let mut out = vec![0.0f32; frame * channels];
            let mut pcm = Vec::new();
            for (i, p) in packets.iter().enumerate() {
                let n = match dmode.as_str() {
                    "normal" => dec.decode(p, frame, &mut out).unwrap(),
                    "plc" => {
                        if i % 10 == 9 {
                            dec.decode(&[], frame, &mut out).unwrap()
                        } else {
                            dec.decode(p, frame, &mut out).unwrap()
                        }
                    }
                    "fec" => {
                        if i % 10 == 9 {
                            dec.decode(&[], frame, &mut out).unwrap()
                        } else if i % 10 == 0 && i > 0 {
                            dec.decode_fec(p, frame, &mut out).unwrap()
                        } else {
                            dec.decode(p, frame, &mut out).unwrap()
                        }
                    }
                    _ => {
                        eprintln!("unknown decode mode {dmode}");
                        exit(2);
                    }
                };
                for &v in &out[..n * channels] {
                    pcm.extend_from_slice(&v.to_le_bytes());
                }
            }
            std::io::stdout().write_all(&pcm).unwrap();
        }
        "encode" => {
            let pcm_bytes = fs::read(arg("--pcm")).unwrap();
            let rate: i32 = arg("--rate").parse().unwrap();
            let channels: usize = arg("--channels").parse().unwrap();
            let frame: usize = arg("--frame").parse().unwrap();
            let bitrate: i32 = arg("--bitrate").parse().unwrap();
            let app = match arg("--app").as_str() {
                "audio" => Application::Audio,
                "voip" => Application::Voip,
                "lowdelay" | "restricted_lowdelay" => Application::RestrictedLowDelay,
                other => {
                    eprintln!("unknown application {other}");
                    exit(2);
                }
            };
            let s16: Vec<i16> = pcm_bytes
                .chunks_exact(2)
                .map(|c| i16::from_le_bytes([c[0], c[1]]))
                .collect();
            let mut enc = OpusEncoder::new(rate, channels, app).unwrap();
            enc.bitrate_bps = bitrate;
            enc.lsb_depth = 16;
            let mut packets = Vec::new();
            let mut buf = [0u8; 1276];
            for chunk in s16.chunks_exact(frame * channels) {
                let f32in: Vec<f32> = chunk.iter().map(|&v| v as f32 / 32768.0).collect();
                let n = enc.encode(&f32in, frame, &mut buf).unwrap();
                packets.push(buf[..n].to_vec());
            }
            write_packets(&packets);
        }
        _ => {
            eprintln!("usage: parity-decode <decode|encode> ...");
            exit(2);
        }
    }
}

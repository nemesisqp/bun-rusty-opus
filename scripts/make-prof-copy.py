#!/usr/bin/env python3
"""Rebuild the instrumented rusty-opus copy used for decode profiling.

/tmp is ephemeral (wiped on VM replacement), so this script recreates
/tmp/rusty-opus-prof from the cargo registry source and re-applies all
profiling instrumentation:

- prof.rs: decode stages DecTotal/DecRange/DecPvq/DecPost (21-24),
  PVQ sub-stages PvqPulses/PvqResynth/PvqRotate (25-27), post sub-stages
  PostComb/PostDeemph (28-29); N=30.
- lib.rs: DecTotal scope at the top of OpusDecoder::decode.
- celt.rs: DecRange/DecPvq/DecPost scopes in decode_impl_from_rc,
  PostComb around the comb-filter block, PostDeemph around deemphasis.
- pvq.rs: PvqPulses/PvqResynth/PvqRotate scopes in alg_unquant, plus
  cwrsi scan-step/call counters and a compute_u call counter.
- examples/decode-stages.rs and examples/scan-stats.rs drivers.

Run: `python3 scripts/make-prof-copy.py` (then `cargo run --release
--features profile --example decode-stages` inside /tmp/rusty-opus-prof).
"""
import glob
import os
import re
import shutil
import sys

REGISTRY = glob.glob(os.path.expanduser("~/.cargo/registry/src/*/rusty-opus-1.0.2"))
assert REGISTRY, "rusty-opus 1.0.2 not found in the cargo registry"
SRC = REGISTRY[0]
DST = "/tmp/rusty-opus-prof"

if os.path.exists(DST):
    shutil.rmtree(DST)
shutil.copytree(SRC, DST)
os.system(f"chmod -R u+w {DST}")

def patch(path, old, new, count=1):
    p = os.path.join(DST, path)
    s = open(p).read()
    assert s.count(old) == count, f"{path}: anchor not unique/found: {old[:60]!r}"
    open(p, "w").write(s.replace(old, new))

# --- prof.rs: stages -------------------------------------------------------
patch(
    "src/prof.rs",
    """    /// Wraps the whole `OpusEncoder::encode()` call — the denominator.
    Total = 20,
}""",
    """    /// Wraps the whole `OpusEncoder::encode()` call — the denominator.
    Total = 20,
    // --- decode stages (added for the bun-rusty-opus decode estimate) ---
    /// Wraps the whole `OpusDecoder::decode()` call.
    DecTotal = 21,
    /// Coarse+fine energy unquant, tf decode, spread, allocation (entropy).
    DecRange = 22,
    /// `denormalise_bands`: PVQ pulse decode + dequantization.
    DecPvq = 23,
    /// Post-IMDCT: deemphasis, postfilter, PLC bookkeeping, state updates.
    DecPost = 24,
    /// `decode_pulses` inside `alg_unquant` (range decode + cwrsi).
    PvqPulses = 25,
    /// `alg_quant_resynth` + collapse mask inside `alg_unquant`.
    PvqResynth = 26,
    /// `exp_rotation` inside `alg_unquant`.
    PvqRotate = 27,
    /// Comb (pitch post-)filter inside the decode tail.
    PostComb = 28,
    /// Deemphasis IIR inside the decode tail.
    PostDeemph = 29,
}""",
)
patch("src/prof.rs", "pub const N: usize = 21;", "pub const N: usize = 30;")
patch(
    "src/prof.rs",
    '''        "TOTAL encode()",
    ];''',
    '''        "TOTAL encode()",
        "dec-total",
        "dec-range/energy",
        "dec-pvq/dequant",
        "dec-post/deemph",
        "pvq-pulses",
        "pvq-resynth",
        "pvq-rotate",
        "post-comb",
        "post-deemph",
    ];''',
)

# --- lib.rs: DecTotal ------------------------------------------------------
patch(
    "src/lib.rs",
    """    ) -> Result<usize, Error> {
        // Lost packet (data==NULL / empty) -> packet-loss concealment.""",
    """    ) -> Result<usize, Error> {
        let _prof_dec_total = crate::prof::scope(crate::prof::Stage::DecTotal);
        // Lost packet (data==NULL / empty) -> packet-loss concealment.""",
)

# --- celt.rs: decode scopes ------------------------------------------------
patch(
    "src/celt.rs",
    """        unquant_coarse_energy(
            mode,
            start_band,
            end_band,
            &mut self.old_band_e,
            intra_ener,
            rc,
            channels,
            lm,
        );""",
    """        let _prof_range = crate::prof::scope(crate::prof::Stage::DecRange);
        unquant_coarse_energy(
            mode,
            start_band,
            end_band,
            &mut self.old_band_e,
            intra_ener,
            rc,
            channels,
            lm,
        );""",
)
patch(
    "src/celt.rs",
    """        unquant_energy_finalise(
            mode,
            start_band,
            end_band,
            &mut self.old_band_e,
            ebits,
            fine_priority,
            total_bits - rc.tell(),
            rc,
            channels,
        );""",
    """        unquant_energy_finalise(
            mode,
            start_band,
            end_band,
            &mut self.old_band_e,
            ebits,
            fine_priority,
            total_bits - rc.tell(),
            rc,
            channels,
        );
        drop(_prof_range);""",
)
patch(
    "src/celt.rs",
    """        if !silence {
            denormalise_bands(""",
    """        if !silence {
            let _prof_pvq = crate::prof::scope(crate::prof::Stage::DecPvq);
            denormalise_bands(""",
)
patch(
    "src/celt.rs",
    """            const SIG_SAT: f32 = 536870911.0;""",
    """            let _prof_post = crate::prof::scope(crate::prof::Stage::DecPost);
            const SIG_SAT: f32 = 536870911.0;""",
)
patch(
    "src/celt.rs",
    """            if pf_on || self.prefilter_gain > 0.0 || self.prefilter_gain_old > 0.0 {""",
    """            let _prof_comb = crate::prof::scope(crate::prof::Stage::PostComb);
            if pf_on || self.prefilter_gain > 0.0 || self.prefilter_gain_old > 0.0 {""",
)
p = os.path.join(DST, "src/celt.rs")
s = open(p).read()
m = re.search(r"( +// deemphasis[^\n]*\n(?: +[^\n]*\n)*? +for i in 0\.\.frame_size \{)", s)
assert m, "deemphasis anchor not found"
s = s[: m.start()] + s[m.start() :].replace(
    m.group(1),
    "            let _prof_deemph = crate::prof::scope(crate::prof::Stage::PostDeemph);\n" + m.group(1),
    1,
)
open(p, "w").write(s)

# --- pvq.rs: alg_unquant scopes + counters --------------------------------
patch(
    "src/pvq.rs",
    """    with_zeroed_scratch(n, |y: &mut [i32]| {
        decode_pulses(y, n as u32, k as u32, rc);

        let mask = extract_collapse_mask(y, n, stride);

        alg_quant_resynth(y, x, n, gain);

        exp_rotation(x, n, -1, stride, k, spread);

        mask
    })""",
    """    with_zeroed_scratch(n, |y: &mut [i32]| {
        let mask = {
            let _prof = crate::prof::scope(crate::prof::Stage::PvqPulses);
            decode_pulses(y, n as u32, k as u32, rc);
            let _prof2 = crate::prof::scope(crate::prof::Stage::PvqResynth);
            let mask = extract_collapse_mask(y, n, stride);
            alg_quant_resynth(y, x, n, gain);
            mask
        };

        {
            let _prof = crate::prof::scope(crate::prof::Stage::PvqRotate);
            exp_rotation(x, n, -1, stride, k, spread);
        }

        mask
    })""",
)
# cwrsi scan counters + compute_u counter (before the #[inline(always)] attr).
patch(
    "src/pvq.rs",
    """#[inline(always)]
pub fn cwrsi(""",
    """pub static CWRSI_SCAN_STEPS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
pub static CWRSI_CALLS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
pub static COMPUTE_U_CALLS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
pub fn cwrsi_stats() -> (u64, u64, u64) {
    (
        CWRSI_SCAN_STEPS.load(std::sync::atomic::Ordering::Relaxed),
        CWRSI_CALLS.load(std::sync::atomic::Ordering::Relaxed),
        COMPUTE_U_CALLS.load(std::sync::atomic::Ordering::Relaxed),
    )
}

#[inline(always)]
pub fn cwrsi(""",
)
patch(
    "src/pvq.rs",
    """pub fn cwrsi(n: u32, k: u32, mut i: u32, y: &mut [i32]) {
    debug_assert!(k > 0, "cwrsi: k must be > 0");""",
    """pub fn cwrsi(n: u32, k: u32, mut i: u32, y: &mut [i32]) {
    debug_assert!(k > 0, "cwrsi: k must be > 0");
    CWRSI_CALLS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);""",
)
for old, new in [
    (
        """                loop {
                    curr_k -= 1;
                    p = celt_pvq_u_lookup(curr_n, curr_k.max(0) as u32);""",
        """                loop {
                    curr_k -= 1;
                    CWRSI_SCAN_STEPS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    p = celt_pvq_u_lookup(curr_n, curr_k.max(0) as u32);""",
    ),
    (
        """                while p > i && curr_k > 0 {
                    curr_k -= 1;
                    p = celt_pvq_u_lookup(curr_n, curr_k as u32);
                }""",
        """                while p > i && curr_k > 0 {
                    curr_k -= 1;
                    CWRSI_SCAN_STEPS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    p = celt_pvq_u_lookup(curr_n, curr_k as u32);
                }""",
    ),
    (
        """            loop {
                curr_k -= 1;
                p = celt_pvq_u_lookup(curr_k.max(0) as u32, curr_n);""",
        """            loop {
                curr_k -= 1;
                CWRSI_SCAN_STEPS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                p = celt_pvq_u_lookup(curr_k.max(0) as u32, curr_n);""",
    ),
]:
    patch("src/pvq.rs", old, new)
# compute_u counter: count every call of compute_u.
p = os.path.join(DST, "src/pvq.rs")
s = open(p).read()
m = re.search(r"(fn compute_u\(n: u32, k: u32\)[^\{]*\{)", s)
assert m, "compute_u anchor not found"
s = s[: m.end()] + "\n    COMPUTE_U_CALLS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);" + s[m.end() :]
open(p, "w").write(s)

# --- Cargo.toml: example entries -------------------------------------------
patch(
    "Cargo.toml",
    """[[example]]
name = "analysis_trace\"""",
    """[[example]]
name = "decode-stages"
path = "examples/decode-stages.rs"

[[example]]
name = "scan-stats"
path = "examples/scan-stats.rs"

[[example]]
name = "analysis_trace\"""",
)

# --- examples ---------------------------------------------------------------
shutil.copy(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "prof-decode-stages.rs"),
    os.path.join(DST, "examples/decode-stages.rs"),
)
shutil.copy(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "prof-scan-stats.rs"),
    os.path.join(DST, "examples/scan-stats.rs"),
)

print(f"profiler copy ready at {DST}")

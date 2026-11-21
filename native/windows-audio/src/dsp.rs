//! Platform-independent DSP: downmix, gain, resampling to 16 kHz and 20 ms framing.
//! Everything here is allocation-bounded and unit tested on any OS.

use crate::protocol::{FRAME_SAMPLES, OUTPUT_SAMPLE_RATE};

/// Average interleaved channels into mono.
pub fn downmix_to_mono(interleaved: &[f32], channels: usize, out: &mut Vec<f32>) {
    out.clear();
    if channels <= 1 {
        out.extend_from_slice(interleaved);
        return;
    }
    let inv = 1.0 / channels as f32;
    for frame in interleaved.chunks_exact(channels) {
        out.push(frame.iter().sum::<f32>() * inv);
    }
}

/// Streaming fractional resampler using a Hann-windowed sinc low-pass filter.
/// Quality is ample for speech recognition; the state persists across calls so
/// chunk boundaries are seamless.
pub struct Resampler {
    in_rate: u32,
    out_rate: u32,
    step: f64,
    /// fractional read position relative to `history` start
    pos: f64,
    history: Vec<f32>,
    half_taps: usize,
    cutoff: f64,
}

impl Resampler {
    pub fn new(in_rate: u32, out_rate: u32) -> Self {
        let half_taps = 16;
        // Cut a little below the output Nyquist to suppress aliasing.
        let cutoff = 0.92 * (out_rate.min(in_rate) as f64 / in_rate as f64);
        Resampler {
            in_rate,
            out_rate,
            step: in_rate as f64 / out_rate as f64,
            pos: half_taps as f64,
            history: vec![0.0; half_taps],
            half_taps,
            cutoff,
        }
    }

    pub fn in_rate(&self) -> u32 {
        self.in_rate
    }

    pub fn is_passthrough(&self) -> bool {
        self.in_rate == self.out_rate
    }

    pub fn process(&mut self, input: &[f32], out: &mut Vec<f32>) {
        if self.is_passthrough() {
            out.extend_from_slice(input);
            return;
        }
        self.history.extend_from_slice(input);
        let ht = self.half_taps as isize;
        while (self.pos as isize) + ht < self.history.len() as isize {
            let center = self.pos.floor() as isize;
            let frac = self.pos - center as f64;
            let mut acc = 0.0f64;
            let mut wsum = 0.0f64;
            for k in (-ht + 1)..=ht {
                let idx = center + k;
                if idx < 0 || idx as usize >= self.history.len() {
                    continue;
                }
                let x = k as f64 - frac;
                let w = sinc(x * self.cutoff) * hann(x, ht as f64);
                acc += self.history[idx as usize] as f64 * w;
                wsum += w;
            }
            out.push(if wsum.abs() > 1e-9 {
                (acc / wsum) as f32
            } else {
                0.0
            });
            self.pos += self.step;
        }
        // Drop consumed samples, keep enough history for the filter.
        let keep_from = (self.pos.floor() as isize - ht).max(0) as usize;
        if keep_from > 0 {
            self.history.drain(0..keep_from);
            self.pos -= keep_from as f64;
        }
    }
}

fn sinc(x: f64) -> f64 {
    if x.abs() < 1e-9 {
        1.0
    } else {
        let px = std::f64::consts::PI * x;
        px.sin() / px
    }
}

fn hann(x: f64, half: f64) -> f64 {
    if x.abs() >= half {
        0.0
    } else {
        0.5 * (1.0 + (std::f64::consts::PI * x / half).cos())
    }
}

/// Converts f32 samples to i16 with gain, returns true if any sample clipped.
pub fn to_i16_with_gain(input: &[f32], gain: f32, out: &mut Vec<i16>) -> bool {
    let mut clipped = false;
    for &s in input {
        let v = s * gain;
        let v = if v > 1.0 {
            clipped = true;
            1.0
        } else if v < -1.0 {
            clipped = true;
            -1.0
        } else {
            v
        };
        out.push((v * 32767.0).round() as i16);
    }
    clipped
}

/// Accumulates 16 kHz mono samples and yields exact 20 ms frames.
pub struct Framer {
    pending: Vec<i16>,
}

impl Default for Framer {
    fn default() -> Self {
        Self::new()
    }
}

impl Framer {
    pub fn new() -> Self {
        Framer {
            pending: Vec::with_capacity(FRAME_SAMPLES * 4),
        }
    }

    pub fn push(&mut self, samples: &[i16]) {
        self.pending.extend_from_slice(samples);
    }

    pub fn pop_frame(&mut self) -> Option<Vec<i16>> {
        if self.pending.len() >= FRAME_SAMPLES {
            let frame: Vec<i16> = self.pending.drain(0..FRAME_SAMPLES).collect();
            Some(frame)
        } else {
            None
        }
    }

    pub fn pending_len(&self) -> usize {
        self.pending.len()
    }
}

/// Converts raw device bytes into f32 samples for the supported formats.
pub fn bytes_to_f32(bytes: &[u8], bits: u16, is_float: bool, out: &mut Vec<f32>) {
    out.clear();
    match (is_float, bits) {
        (true, 32) => {
            for c in bytes.as_chunks::<4>().0 {
                out.push(f32::from_le_bytes(*c));
            }
        }
        (false, 16) => {
            for c in bytes.as_chunks::<2>().0 {
                out.push(i16::from_le_bytes(*c) as f32 / 32768.0);
            }
        }
        (false, 24) => {
            for c in bytes.as_chunks::<3>().0 {
                let v = ((c[2] as i32) << 24 | (c[1] as i32) << 16 | (c[0] as i32) << 8) >> 8;
                out.push(v as f32 / 8_388_608.0);
            }
        }
        (false, 32) => {
            for c in bytes.as_chunks::<4>().0 {
                out.push(i32::from_le_bytes(*c) as f32 / 2_147_483_648.0);
            }
        }
        _ => {}
    }
}

/// Root-mean-square level in dBFS of an i16 frame (silence floor -100 dB).
pub fn rms_dbfs(frame: &[i16]) -> f32 {
    if frame.is_empty() {
        return -100.0;
    }
    let sum: f64 = frame.iter().map(|&s| (s as f64 / 32768.0).powi(2)).sum();
    let rms = (sum / frame.len() as f64).sqrt();
    if rms <= 1e-5 {
        -100.0
    } else {
        (20.0 * rms.log10()) as f32
    }
}

pub const TARGET_RATE: u32 = OUTPUT_SAMPLE_RATE;

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(freq: f32, rate: u32, n: usize) -> Vec<f32> {
        (0..n)
            .map(|i| (2.0 * std::f32::consts::PI * freq * i as f32 / rate as f32).sin() * 0.5)
            .collect()
    }

    /// Estimate dominant frequency by counting zero crossings.
    fn zero_cross_freq(x: &[f32], rate: u32) -> f32 {
        let crossings = x
            .windows(2)
            .filter(|w| (w[0] <= 0.0) != (w[1] <= 0.0))
            .count();
        crossings as f32 / 2.0 / (x.len() as f32 / rate as f32)
    }

    #[test]
    fn resample_48k_to_16k_preserves_frequency_and_length() {
        let input = sine(440.0, 48_000, 48_000);
        let mut r = Resampler::new(48_000, 16_000);
        let mut out = Vec::new();
        // feed in uneven chunks to exercise state carry-over
        for chunk in input.chunks(487) {
            r.process(chunk, &mut out);
        }
        assert!((out.len() as i64 - 16_000).abs() < 40, "len {}", out.len());
        let f = zero_cross_freq(&out[200..], 16_000);
        assert!((f - 440.0).abs() < 5.0, "freq {f}");
        let peak = out[200..].iter().fold(0.0f32, |m, v| m.max(v.abs()));
        assert!((peak - 0.5).abs() < 0.03, "peak {peak}");
    }

    #[test]
    fn resample_44100_to_16k() {
        let input = sine(1000.0, 44_100, 44_100);
        let mut r = Resampler::new(44_100, 16_000);
        let mut out = Vec::new();
        for chunk in input.chunks(441) {
            r.process(chunk, &mut out);
        }
        assert!((out.len() as i64 - 16_000).abs() < 40);
        let f = zero_cross_freq(&out[200..], 16_000);
        assert!((f - 1000.0).abs() < 8.0, "freq {f}");
    }

    #[test]
    fn resampler_attenuates_above_nyquist() {
        // 12 kHz tone cannot be represented at 16 kHz and must be strongly attenuated.
        let input = sine(12_000.0, 48_000, 48_000);
        let mut r = Resampler::new(48_000, 16_000);
        let mut out = Vec::new();
        r.process(&input, &mut out);
        let peak = out[200..].iter().fold(0.0f32, |m, v| m.max(v.abs()));
        assert!(peak < 0.12, "alias peak {peak}");
    }

    #[test]
    fn passthrough_when_rates_match() {
        let mut r = Resampler::new(16_000, 16_000);
        let mut out = Vec::new();
        r.process(&[0.1, 0.2, 0.3], &mut out);
        assert_eq!(out, vec![0.1, 0.2, 0.3]);
    }

    #[test]
    fn downmix_and_convert() {
        let mut mono = Vec::new();
        downmix_to_mono(&[1.0, 0.0, 0.5, 0.5], 2, &mut mono);
        assert_eq!(mono, vec![0.5, 0.5]);
        let mut pcm = Vec::new();
        let clipped = to_i16_with_gain(&[0.5, 2.0, -3.0], 1.0, &mut pcm);
        assert!(clipped);
        assert_eq!(pcm, vec![16384, 32767, -32767]);
    }

    #[test]
    fn framer_emits_exact_frames() {
        let mut f = Framer::new();
        f.push(&vec![1i16; 500]);
        assert_eq!(f.pop_frame().unwrap().len(), FRAME_SAMPLES);
        assert!(f.pop_frame().is_none());
        assert_eq!(f.pending_len(), 180);
        f.push(&vec![1i16; 140]);
        assert!(f.pop_frame().is_some());
        assert_eq!(f.pending_len(), 0);
    }

    #[test]
    fn bytes_formats() {
        let mut out = Vec::new();
        bytes_to_f32(&0.25f32.to_le_bytes(), 32, true, &mut out);
        assert_eq!(out, vec![0.25]);
        bytes_to_f32(&16384i16.to_le_bytes(), 16, false, &mut out);
        assert_eq!(out, vec![0.5]);
        // 24-bit: 0x400000 = 0.5
        bytes_to_f32(&[0x00, 0x00, 0x40], 24, false, &mut out);
        assert!((out[0] - 0.5).abs() < 1e-6);
    }

    #[test]
    fn rms_levels() {
        assert_eq!(rms_dbfs(&[0; 320]), -100.0);
        let full: Vec<i16> = (0..320)
            .map(|i| if i % 2 == 0 { 32767 } else { -32767 })
            .collect();
        assert!(rms_dbfs(&full) > -0.1);
    }
}

//! WASAPI capture threads (microphone, system loopback, per-process loopback)
//! with automatic recovery on device loss and default-device changes.

use crate::devices::DefaultTracker;
use crate::dsp::{self, Framer, Resampler};
use crate::output::{now_us, Output};
use crate::protocol::{
    SourceId, FLAG_CLIPPED, FLAG_DISCONTINUITY, FLAG_SILENCE_PADDED, FRAME_MS, FRAME_SAMPLES,
    OUTPUT_SAMPLE_RATE,
};
use serde_json::json;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use wasapi::{AudioClient, DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat};

#[derive(Clone, Debug)]
pub enum CaptureTarget {
    /// Microphone / input endpoint. `None` follows the Windows default.
    Mic { device_id: Option<String> },
    /// Loopback of an output endpoint. `None` follows the Windows default.
    System { device_id: Option<String> },
    /// Per-process loopback (Windows 10 build 20348+).
    App { pid: u32 },
}

impl CaptureTarget {
    pub fn source(&self) -> SourceId {
        match self {
            CaptureTarget::Mic { .. } => SourceId::Mic,
            CaptureTarget::System { .. } => SourceId::System,
            CaptureTarget::App { .. } => SourceId::App,
        }
    }
}

pub struct CaptureHandle {
    pub stop: Arc<AtomicBool>,
    pub gain_bits: Arc<AtomicU32>,
    pub join: Option<JoinHandle<()>>,
    pub target: CaptureTarget,
}

impl CaptureHandle {
    pub fn set_gain(&self, gain: f32) {
        self.gain_bits
            .store(gain.clamp(0.0, 8.0).to_bits(), Ordering::Relaxed);
    }

    pub fn stop_and_join(mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(j) = self.join.take() {
            let _ = j.join();
        }
    }
}

enum SessionEnd {
    Stopped,
    DefaultChanged,
}

const MAX_CONSECUTIVE_FAILURES: u32 = 12;

pub fn spawn(
    target: CaptureTarget,
    out: Arc<Output>,
    tracker: Arc<DefaultTracker>,
    gain: f32,
) -> CaptureHandle {
    let stop = Arc::new(AtomicBool::new(false));
    let gain_bits = Arc::new(AtomicU32::new(gain.to_bits()));
    let t = target.clone();
    let s = stop.clone();
    let g = gain_bits.clone();
    let join = thread::Builder::new()
        .name(format!("capture-{}", target.source().as_str()))
        .spawn(move || run(t, out, tracker, s, g))
        .expect("spawn capture thread");
    CaptureHandle {
        stop,
        gain_bits,
        join: Some(join),
        target,
    }
}

fn status(out: &Output, source: SourceId, state: &str, extra: serde_json::Value) {
    let mut v =
        json!({"type": "status", "source": source.as_str(), "state": state, "ts": now_us()});
    if let (Some(obj), Some(extra)) = (v.as_object_mut(), extra.as_object()) {
        for (k, val) in extra {
            obj.insert(k.clone(), val.clone());
        }
    }
    out.send_event(v);
}

fn run(
    target: CaptureTarget,
    out: Arc<Output>,
    tracker: Arc<DefaultTracker>,
    stop: Arc<AtomicBool>,
    gain: Arc<AtomicU32>,
) {
    let source = target.source();
    let _ = wasapi::initialize_mta();
    let mut failures: u32 = 0;
    status(&out, source, "starting", json!({}));
    while !stop.load(Ordering::SeqCst) {
        match session(&target, &out, &tracker, &stop, &gain, &mut failures) {
            Ok(SessionEnd::Stopped) => break,
            Ok(SessionEnd::DefaultChanged) => {
                status(
                    &out,
                    source,
                    "reconnecting",
                    json!({"reason": "default_device_changed"}),
                );
                failures = 0;
            }
            Err(err) => {
                failures += 1;
                out.stats_for(source)
                    .restarts
                    .fetch_add(1, Ordering::Relaxed);
                if failures > MAX_CONSECUTIVE_FAILURES {
                    status(
                        &out,
                        source,
                        "failed",
                        json!({"message": err, "attempts": failures}),
                    );
                    return;
                }
                status(
                    &out,
                    source,
                    "reconnecting",
                    json!({"reason": "error", "message": err, "attempt": failures}),
                );
                // Exponential backoff (200 ms → 5 s), interruptible by stop.
                let wait = (200u64 << failures.min(5)).min(5000);
                let until = Instant::now() + Duration::from_millis(wait);
                while Instant::now() < until && !stop.load(Ordering::SeqCst) {
                    thread::sleep(Duration::from_millis(25));
                }
            }
        }
    }
    status(&out, source, "stopped", json!({}));
}

struct Opened {
    client: AudioClient,
    device_name: String,
    device_id: Option<String>,
    follows_default: Option<Direction>,
    /// Format actually delivered by the capture client.
    rate: u32,
    channels: usize,
    bits: u16,
    is_float: bool,
    autoconvert: bool,
}

fn open(target: &CaptureTarget) -> Result<Opened, String> {
    let e = |x: wasapi::WasapiError| x.to_string();
    let (mut client, device_name, device_id, follows_default, is_app) = match target {
        CaptureTarget::Mic { device_id } | CaptureTarget::System { device_id } => {
            let dir = if matches!(target, CaptureTarget::Mic { .. }) {
                Direction::Capture
            } else {
                Direction::Render
            };
            let enumerator = DeviceEnumerator::new().map_err(e)?;
            let device = match device_id {
                Some(id) => enumerator.get_device(id).map_err(e)?,
                None => enumerator.get_default_device(dir).map_err(e)?,
            };
            let name = device
                .get_friendlyname()
                .unwrap_or_else(|_| "Unknown".into());
            let id = device.get_id().ok();
            let client = device.get_iaudioclient().map_err(e)?;
            (client, name, id, device_id.is_none().then_some(dir), false)
        }
        CaptureTarget::App { pid } => {
            let client = AudioClient::new_application_loopback_client(*pid, true).map_err(e)?;
            (client, format!("process {pid}"), None, None, true)
        }
    };

    // 100 ms device buffer gives headroom against scheduling hiccups.
    let buffer_hns: i64 = 1_000_000;
    // Preferred: let the Windows audio engine convert to 16 kHz mono float.
    let wanted = WaveFormat::new(
        32,
        32,
        SampleType::Float,
        OUTPUT_SAMPLE_RATE as usize,
        1,
        None,
    );
    let attempt = client.initialize_client(
        &wanted,
        Direction::Capture,
        StreamMode::EventsShared {
            autoconvert: true,
            buffer_duration_hns: if is_app { 0 } else { buffer_hns },
        },
        None,
    );
    if attempt.is_ok() {
        return Ok(Opened {
            client,
            device_name,
            device_id,
            follows_default,
            rate: OUTPUT_SAMPLE_RATE,
            channels: 1,
            bits: 32,
            is_float: true,
            autoconvert: true,
        });
    }

    // Fallback: native mix format (or 48 kHz stereo for process loopback) and our own DSP.
    // A client cannot be re-initialized, so build a fresh one.
    let mut client = match target {
        CaptureTarget::App { pid } => {
            AudioClient::new_application_loopback_client(*pid, true).map_err(e)?
        }
        _ => {
            let enumerator = DeviceEnumerator::new().map_err(e)?;
            let dev = match &device_id {
                Some(id) => enumerator.get_device(id).map_err(e)?,
                None => return Err("device disappeared during open".into()),
            };
            dev.get_iaudioclient().map_err(e)?
        }
    };
    let (fmt, autoconvert) = if is_app {
        (
            WaveFormat::new(32, 32, SampleType::Float, 48_000, 2, None),
            true,
        )
    } else {
        (client.get_mixformat().map_err(e)?, false)
    };
    client
        .initialize_client(
            &fmt,
            Direction::Capture,
            StreamMode::EventsShared {
                autoconvert,
                buffer_duration_hns: if is_app { 0 } else { buffer_hns },
            },
            None,
        )
        .map_err(|x| format!("initialize failed (autoconvert and mix format): {x}"))?;
    let is_float = matches!(fmt.get_subformat(), Ok(SampleType::Float));
    Ok(Opened {
        client,
        device_name,
        device_id,
        follows_default,
        rate: fmt.get_samplespersec(),
        channels: fmt.get_nchannels() as usize,
        bits: fmt.get_bitspersample(),
        is_float,
        autoconvert,
    })
}

fn session(
    target: &CaptureTarget,
    out: &Arc<Output>,
    tracker: &Arc<DefaultTracker>,
    stop: &Arc<AtomicBool>,
    gain: &Arc<AtomicU32>,
    failures: &mut u32,
) -> Result<SessionEnd, String> {
    let source = target.source();
    let stats = out.stats_for(source);
    let generation_at_open = |dir: Direction| tracker.generation(dir);
    let opened = open(target)?;
    let gen0 = opened.follows_default.map(generation_at_open);
    let is_loopback = !matches!(target, CaptureTarget::Mic { .. });
    let e = |x: wasapi::WasapiError| x.to_string();

    let h_event = opened.client.set_get_eventhandle().map_err(e)?;
    let capture = opened.client.get_audiocaptureclient().map_err(e)?;
    let block_align = (opened.bits as usize / 8) * opened.channels;
    if block_align == 0 {
        return Err("unsupported capture format".into());
    }
    let mut resampler = Resampler::new(opened.rate, OUTPUT_SAMPLE_RATE);
    let mut framer = Framer::new();
    let mut raw: VecDeque<u8> = VecDeque::with_capacity(block_align * 4800);
    let mut bytes: Vec<u8> = Vec::with_capacity(block_align * 4800);
    let mut interleaved: Vec<f32> = Vec::with_capacity(9600);
    let mut mono: Vec<f32> = Vec::with_capacity(4800);
    let mut resampled: Vec<f32> = Vec::with_capacity(1600);
    let mut pcm: Vec<i16> = Vec::with_capacity(1600);

    opened.client.start_stream().map_err(e)?;
    status(
        out,
        source,
        "streaming",
        json!({
            "deviceName": opened.device_name,
            "deviceId": opened.device_id,
            "followsDefault": opened.follows_default.is_some(),
            "format": {"sampleRate": opened.rate, "channels": opened.channels, "bits": opened.bits, "float": opened.is_float, "engineAutoconvert": opened.autoconvert},
            "outputFormat": {"sampleRate": OUTPUT_SAMPLE_RATE, "channels": 1, "bits": 16, "frameMs": FRAME_MS},
        }),
    );
    *failures = 0;

    let started = Instant::now();
    let mut emitted_samples: u64 = 0;
    let mut last_data = Instant::now();
    let mut pending_flags: u8 = 0;

    let result = loop {
        if stop.load(Ordering::SeqCst) {
            break Ok(SessionEnd::Stopped);
        }
        if let (Some(dir), Some(g0)) = (opened.follows_default, gen0) {
            if tracker.generation(dir) != g0 {
                break Ok(SessionEnd::DefaultChanged);
            }
        }
        // 20 ms wake-up cadence: event-driven when audio flows, timed otherwise.
        let _ = h_event.wait_for_event(20);

        let mut got = false;
        loop {
            let n = match capture.get_next_packet_size() {
                Ok(v) => v.unwrap_or(0),
                Err(x) => return finish(&opened, Err(x.to_string())),
            };
            if n == 0 {
                break;
            }
            match capture.read_from_device_to_deque(&mut raw) {
                Ok(info) => {
                    if info.flags.data_discontinuity {
                        stats.discontinuities.fetch_add(1, Ordering::Relaxed);
                        pending_flags |= FLAG_DISCONTINUITY;
                    }
                    got = true;
                }
                Err(x) => return finish(&opened, Err(x.to_string())),
            }
        }

        if got {
            last_data = Instant::now();
            let whole = raw.len() - raw.len() % block_align;
            bytes.clear();
            bytes.extend(raw.drain(..whole));
            dsp::bytes_to_f32(&bytes, opened.bits, opened.is_float, &mut interleaved);
            dsp::downmix_to_mono(&interleaved, opened.channels, &mut mono);
            resampled.clear();
            resampler.process(&mono, &mut resampled);
            pcm.clear();
            let g = f32::from_bits(gain.load(Ordering::Relaxed));
            if dsp::to_i16_with_gain(&resampled, g, &mut pcm) {
                pending_flags |= FLAG_CLIPPED;
            }
            framer.push(&pcm);
            while let Some(frame) = framer.pop_frame() {
                stats.frames_captured.fetch_add(1, Ordering::Relaxed);
                if pending_flags & FLAG_CLIPPED != 0 {
                    stats.clipped_frames.fetch_add(1, Ordering::Relaxed);
                }
                out.send_audio(source, pending_flags, &frame);
                pending_flags = 0;
                emitted_samples += FRAME_SAMPLES as u64;
            }
        } else if is_loopback {
            // Loopback endpoints deliver no packets while nothing is playing. Keep a
            // real-time cadence of explicit silence so downstream VAD/endpointing can
            // close utterances. Padded frames are flagged and counted separately.
            let expected =
                (started.elapsed().as_micros() as u64 * OUTPUT_SAMPLE_RATE as u64) / 1_000_000;
            if last_data.elapsed() > Duration::from_millis(60)
                && expected > emitted_samples + 2 * FRAME_SAMPLES as u64
            {
                let missing = ((expected - emitted_samples) / FRAME_SAMPLES as u64).min(50);
                let zeros = [0i16; FRAME_SAMPLES];
                for _ in 0..missing {
                    stats.frames_padded.fetch_add(1, Ordering::Relaxed);
                    out.send_audio(source, FLAG_SILENCE_PADDED, &zeros);
                    emitted_samples += FRAME_SAMPLES as u64;
                }
            }
        } else if last_data.elapsed() > Duration::from_secs(3) {
            // Microphones deliver packets continuously (even silence). A 3 s stall
            // means the endpoint is wedged (sleep/resume, driver reset): reopen.
            break Err("microphone stopped delivering audio for 3 s".to_string());
        }
    };
    finish(&opened, result)
}

fn finish(opened: &Opened, r: Result<SessionEnd, String>) -> Result<SessionEnd, String> {
    let _ = opened.client.stop_stream();
    r
}

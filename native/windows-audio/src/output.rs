//! Single-writer stdout pipeline with a bounded queue, a monotonic clock and counters.

use crate::protocol::{self, SourceId};
use serde_json::Value;
use std::io::Write;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, OnceLock};
use std::thread;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

static START: OnceLock<(Instant, u64)> = OnceLock::new();

/// Initializes the process clock. Returns (start instant, unix epoch ms at start).
pub fn clock_init() -> (Instant, u64) {
    *START.get_or_init(|| {
        let epoch_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        (Instant::now(), epoch_ms)
    })
}

/// Monotonic microseconds since helper start (QueryPerformanceCounter-backed on Windows).
pub fn now_us() -> u64 {
    clock_init().0.elapsed().as_micros() as u64
}

/// Queue capacity in messages. 400 audio frames ≈ 4 s for two 20 ms sources.
pub const QUEUE_CAPACITY: usize = 400;

#[derive(Default)]
pub struct SourceStats {
    pub frames_captured: AtomicU64,
    pub frames_sent: AtomicU64,
    pub frames_dropped: AtomicU64,
    pub frames_padded: AtomicU64,
    pub discontinuities: AtomicU64,
    pub clipped_frames: AtomicU64,
    pub restarts: AtomicU64,
    pub seq: AtomicU32,
}

impl SourceStats {
    pub fn snapshot(&self) -> Value {
        serde_json::json!({
            "framesCaptured": self.frames_captured.load(Ordering::Relaxed),
            "framesSent": self.frames_sent.load(Ordering::Relaxed),
            "framesDropped": self.frames_dropped.load(Ordering::Relaxed),
            "framesPadded": self.frames_padded.load(Ordering::Relaxed),
            "discontinuities": self.discontinuities.load(Ordering::Relaxed),
            "clippedFrames": self.clipped_frames.load(Ordering::Relaxed),
            "restarts": self.restarts.load(Ordering::Relaxed),
        })
    }
}

pub struct Output {
    tx: SyncSender<Vec<u8>>,
    event_seq: AtomicU32,
    queued: Arc<AtomicU64>,
    pub mic: SourceStats,
    pub system: SourceStats,
    pub app: SourceStats,
}

impl Output {
    /// Spawns the writer thread. The writer exits the process when stdout breaks
    /// (the parent is gone), so the helper can never outlive Electron.
    pub fn start() -> Arc<Output> {
        let (tx, rx) = sync_channel::<Vec<u8>>(QUEUE_CAPACITY);
        let queued = Arc::new(AtomicU64::new(0));
        let out = Arc::new(Output {
            tx,
            event_seq: AtomicU32::new(0),
            queued: queued.clone(),
            mic: SourceStats::default(),
            system: SourceStats::default(),
            app: SourceStats::default(),
        });
        thread::Builder::new()
            .name("stdout-writer".into())
            .spawn(move || writer_loop(rx, queued))
            .expect("spawn writer");
        out
    }

    pub fn stats_for(&self, source: SourceId) -> &SourceStats {
        match source {
            SourceId::Mic => &self.mic,
            SourceId::App => &self.app,
            _ => &self.system,
        }
    }

    pub fn queue_depth(&self) -> u64 {
        self.queued.load(Ordering::Relaxed)
    }

    /// Non-blocking audio send. A full queue drops the frame and counts it.
    pub fn send_audio(&self, source: SourceId, flags: u8, pcm: &[i16]) {
        let stats = self.stats_for(source);
        let seq = stats.seq.fetch_add(1, Ordering::Relaxed);
        let bytes = protocol::encode_audio(source, seq, now_us(), flags, pcm);
        match self.tx.try_send(bytes) {
            Ok(()) => {
                self.queued.fetch_add(1, Ordering::Relaxed);
                stats.frames_sent.fetch_add(1, Ordering::Relaxed);
            }
            Err(TrySendError::Full(_)) => {
                stats.frames_dropped.fetch_add(1, Ordering::Relaxed);
            }
            Err(TrySendError::Disconnected(_)) => std::process::exit(0),
        }
    }

    /// Events are small and important: block (briefly) instead of dropping.
    pub fn send_event(&self, value: Value) {
        let seq = self.event_seq.fetch_add(1, Ordering::Relaxed);
        let json = value.to_string();
        let bytes = protocol::encode_event(seq, now_us(), &json);
        self.queued.fetch_add(1, Ordering::Relaxed);
        if self.tx.send(bytes).is_err() {
            std::process::exit(0);
        }
    }
}

fn writer_loop(rx: Receiver<Vec<u8>>, queued: Arc<AtomicU64>) {
    let stdout = std::io::stdout();
    let mut lock = stdout.lock();
    while let Ok(first) = rx.recv() {
        let mut ok = lock.write_all(&first).is_ok();
        queued.fetch_sub(1, Ordering::Relaxed);
        // Coalesce whatever is already queued into one flush.
        while ok {
            match rx.try_recv() {
                Ok(next) => {
                    ok = lock.write_all(&next).is_ok();
                    queued.fetch_sub(1, Ordering::Relaxed);
                }
                Err(_) => break,
            }
        }
        if !ok || lock.flush().is_err() {
            // Parent closed the pipe: nothing left to do.
            std::process::exit(0);
        }
    }
}

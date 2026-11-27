//! doing-audio — long-lived helper process.
//!
//! stdin : newline-delimited JSON commands `{"id": 1, "cmd": "...", ...}`
//! stdout: framed binary messages (see `protocol.rs`)
//! stderr: human-readable diagnostics only (never audio, never secrets)
//!
//! No audio is captured until an explicit `start` command arrives.

#[cfg(windows)]
fn main() {
    windows_main::run();
}

#[cfg(not(windows))]
fn main() {
    eprintln!("doing-audio only supports Windows");
    std::process::exit(2);
}

#[cfg(windows)]
mod windows_main {
    use doing_audio::capture::{self, CaptureHandle, CaptureTarget};
    use doing_audio::devices::{self, DefaultTracker};
    use doing_audio::output::{clock_init, Output, QUEUE_CAPACITY};
    use doing_audio::protocol::{SourceId, FRAME_MS, OUTPUT_SAMPLE_RATE, VERSION};
    use doing_audio::screen;
    use serde_json::{json, Value};
    use std::collections::HashMap;
    use std::io::BufRead;
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;
    use std::thread;
    use std::time::Duration;

    pub fn run() {
        let (_, start_epoch_ms) = clock_init();
        screen::set_dpi_aware();
        let _ = wasapi::initialize_mta();
        let out = Output::start();
        let tracker = Arc::new(DefaultTracker::default());
        let stop_all = Arc::new(AtomicBool::new(false));
        devices::spawn_monitor(tracker.clone(), out.clone(), stop_all.clone());

        out.send_event(json!({
            "type": "hello",
            "protocol": VERSION,
            "version": env!("CARGO_PKG_VERSION"),
            "pid": std::process::id(),
            "startEpochMs": start_epoch_ms,
            "sampleRate": OUTPUT_SAMPLE_RATE,
            "frameMs": FRAME_MS,
            "queueCapacity": QUEUE_CAPACITY,
        }));

        // Periodic stats so the app can show drop/overrun counters live.
        {
            let out = out.clone();
            thread::Builder::new()
                .name("stats".into())
                .spawn(move || loop {
                    thread::sleep(Duration::from_secs(2));
                    out.send_event(stats_json(&out));
                })
                .expect("spawn stats");
        }

        let mut captures: HashMap<SourceId, CaptureHandle> = HashMap::new();
        let stdin = std::io::stdin();
        for line in stdin.lock().lines() {
            let Ok(line) = line else { break };
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let cmd: Value = match serde_json::from_str(line) {
                Ok(v) => v,
                Err(e) => {
                    out.send_event(
                        json!({"type":"error","code":"bad_command","message": e.to_string()}),
                    );
                    continue;
                }
            };
            let id = cmd.get("id").cloned().unwrap_or(Value::Null);
            let name = cmd.get("cmd").and_then(Value::as_str).unwrap_or("");
            let reply = |ok: bool, data: Value| {
                out.send_event(if ok {
                    json!({"type":"response","id": id,"ok": true,"data": data})
                } else {
                    json!({"type":"response","id": id,"ok": false,"error": data})
                });
            };
            match name {
                "ping" => reply(true, json!("pong")),
                "list_devices" => match devices::list_devices() {
                    Ok(v) => reply(true, v),
                    Err(e) => reply(false, json!(e)),
                },
                "list_audio_apps" => match devices::list_audio_apps() {
                    Ok(v) => reply(true, v),
                    Err(e) => reply(false, json!(e)),
                },
                "start" => {
                    let source = cmd
                        .get("source")
                        .and_then(Value::as_str)
                        .and_then(SourceId::parse);
                    let device_id = cmd
                        .get("deviceId")
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty())
                        .map(str::to_string);
                    let gain = cmd.get("gain").and_then(Value::as_f64).unwrap_or(1.0) as f32;
                    let target = match source {
                        Some(SourceId::Mic) => Some(CaptureTarget::Mic { device_id }),
                        // deviceId "all" = every output endpoint, mixed (CaptureTarget::SystemAll).
                        Some(SourceId::System) if device_id.as_deref() == Some("all") => {
                            Some(CaptureTarget::SystemAll)
                        }
                        Some(SourceId::System) => Some(CaptureTarget::System { device_id }),
                        Some(SourceId::App) => cmd
                            .get("pid")
                            .and_then(Value::as_u64)
                            .map(|pid| CaptureTarget::App { pid: pid as u32 }),
                        _ => None,
                    };
                    match target {
                        Some(target) => {
                            let src = target.source();
                            if let Some(old) = captures.remove(&src) {
                                old.stop_and_join();
                            }
                            let handle = capture::spawn(target, out.clone(), tracker.clone(), gain);
                            captures.insert(src, handle);
                            reply(true, json!({"source": src.as_str()}));
                        }
                        None => reply(
                            false,
                            json!("start requires source mic|system|app (app needs pid)"),
                        ),
                    }
                }
                "stop" => {
                    let source = cmd
                        .get("source")
                        .and_then(Value::as_str)
                        .and_then(SourceId::parse);
                    match source.and_then(|s| captures.remove(&s)) {
                        Some(h) => {
                            h.stop_and_join();
                            reply(true, json!(null))
                        }
                        None => reply(true, json!("not running")),
                    }
                }
                "stop_all" => {
                    for (_, h) in captures.drain() {
                        h.stop_and_join();
                    }
                    reply(true, json!(null));
                }
                "set_gain" => {
                    let source = cmd
                        .get("source")
                        .and_then(Value::as_str)
                        .and_then(SourceId::parse);
                    let gain = cmd.get("gain").and_then(Value::as_f64).unwrap_or(1.0) as f32;
                    match source.and_then(|s| captures.get(&s)) {
                        Some(h) => {
                            h.set_gain(gain);
                            reply(true, json!(null))
                        }
                        None => reply(false, json!("source not running")),
                    }
                }
                "stats" => reply(true, stats_json(&out)),
                "capture_probe" => {
                    let g = |k: &str| cmd.get(k).and_then(Value::as_i64).unwrap_or(0) as i32;
                    match screen::gdi_sample(g("x"), g("y"), g("w"), g("h")) {
                        Ok(v) => reply(true, v),
                        Err(e) => reply(false, json!(e)),
                    }
                }
                "shutdown" => {
                    reply(true, json!(null));
                    break;
                }
                other => reply(false, json!(format!("unknown command: {other}"))),
            }
        }
        // stdin closed (parent exited) or shutdown requested.
        for (_, h) in captures.drain() {
            h.stop_and_join();
        }
        thread::sleep(Duration::from_millis(50));
        std::process::exit(0);
    }

    fn stats_json(out: &Output) -> Value {
        json!({
            "type": "stats",
            "queueDepth": out.queue_depth(),
            "queueCapacity": QUEUE_CAPACITY,
            "mic": out.mic.snapshot(),
            "system": out.system.snapshot(),
            "app": out.app.snapshot(),
        })
    }
}

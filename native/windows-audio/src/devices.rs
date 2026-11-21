//! Device enumeration, default-device tracking and audio-session (per-app) listing.

use crate::output::Output;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use wasapi::{DeviceEnumerator, Direction};

#[derive(Default)]
pub struct DefaultTracker {
    pub capture_generation: AtomicU64,
    pub render_generation: AtomicU64,
    pub last: Mutex<(Option<String>, Option<String>, u64)>,
}

impl DefaultTracker {
    pub fn generation(&self, dir: Direction) -> u64 {
        match dir {
            Direction::Capture => self.capture_generation.load(Ordering::SeqCst),
            Direction::Render => self.render_generation.load(Ordering::SeqCst),
        }
    }
}

fn default_id(enumerator: &DeviceEnumerator, dir: Direction) -> Option<String> {
    enumerator
        .get_default_device(dir)
        .ok()
        .and_then(|d| d.get_id().ok())
}

fn list_direction(enumerator: &DeviceEnumerator, dir: Direction) -> Vec<Value> {
    let default = default_id(enumerator, dir);
    let mut out = Vec::new();
    if let Ok(collection) = enumerator.get_device_collection(dir) {
        let n = collection.get_nbr_devices().unwrap_or(0);
        for i in 0..n {
            if let Ok(dev) = collection.get_device_at_index(i) {
                let id = dev.get_id().unwrap_or_default();
                let name = dev
                    .get_friendlyname()
                    .unwrap_or_else(|_| "Unknown device".into());
                let format = dev.get_device_format().ok().map(|f| {
                    json!({"sampleRate": f.get_samplespersec(), "channels": f.get_nchannels(), "bits": f.get_bitspersample()})
                });
                out.push(json!({
                    "id": id,
                    "name": name,
                    "isDefault": default.as_deref() == Some(id.as_str()),
                    "format": format,
                }));
            }
        }
    }
    out
}

pub fn list_devices() -> Result<Value, String> {
    let enumerator = DeviceEnumerator::new().map_err(|e| e.to_string())?;
    Ok(json!({
        "capture": list_direction(&enumerator, Direction::Capture),
        "render": list_direction(&enumerator, Direction::Render),
    }))
}

fn device_list_fingerprint(enumerator: &DeviceEnumerator) -> u64 {
    // Cheap change detector: hash of all active endpoint IDs in both directions.
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    for dir in [Direction::Capture, Direction::Render] {
        if let Ok(c) = enumerator.get_device_collection(dir) {
            let n = c.get_nbr_devices().unwrap_or(0);
            for i in 0..n {
                if let Ok(d) = c.get_device_at_index(i) {
                    d.get_id().unwrap_or_default().hash(&mut h);
                }
            }
        }
    }
    h.finish()
}

/// Polls default endpoints and the active device set once per second. Polling
/// (instead of IMMNotificationClient callbacks) keeps COM threading trivial and
/// still reacts to hot-plug, Bluetooth reconnects and default-device switches
/// well within the 1–2 s users expect.
pub fn spawn_monitor(tracker: Arc<DefaultTracker>, out: Arc<Output>, stop: Arc<AtomicBool>) {
    thread::Builder::new()
        .name("device-monitor".into())
        .spawn(move || {
            let _ = wasapi::initialize_mta();
            let enumerator = match DeviceEnumerator::new() {
                Ok(e) => e,
                Err(e) => {
                    out.send_event(json!({"type":"error","code":"device_enum_failed","message": e.to_string()}));
                    return;
                }
            };
            {
                let mut last = tracker.last.lock().unwrap();
                *last = (
                    default_id(&enumerator, Direction::Capture),
                    default_id(&enumerator, Direction::Render),
                    device_list_fingerprint(&enumerator),
                );
            }
            while !stop.load(Ordering::SeqCst) {
                thread::sleep(Duration::from_millis(1000));
                let cap = default_id(&enumerator, Direction::Capture);
                let ren = default_id(&enumerator, Direction::Render);
                let fp = device_list_fingerprint(&enumerator);
                let mut last = tracker.last.lock().unwrap();
                let cap_changed = last.0 != cap;
                let ren_changed = last.1 != ren;
                let list_changed = last.2 != fp;
                if cap_changed {
                    tracker.capture_generation.fetch_add(1, Ordering::SeqCst);
                }
                if ren_changed {
                    tracker.render_generation.fetch_add(1, Ordering::SeqCst);
                }
                if cap_changed || ren_changed || list_changed {
                    *last = (cap.clone(), ren.clone(), fp);
                    out.send_event(json!({
                        "type": "devices_changed",
                        "defaultCaptureChanged": cap_changed,
                        "defaultRenderChanged": ren_changed,
                        "listChanged": list_changed,
                    }));
                }
            }
        })
        .expect("spawn monitor");
}

/// Lists processes that currently own an audio session on the default render
/// endpoint — candidates for per-application loopback capture.
pub fn list_audio_apps() -> Result<Value, String> {
    let enumerator = DeviceEnumerator::new().map_err(|e| e.to_string())?;
    let device = enumerator
        .get_default_device(Direction::Render)
        .map_err(|e| e.to_string())?;
    let manager = device
        .get_iaudiosessionmanager()
        .map_err(|e| e.to_string())?;
    let sessions = manager
        .get_audiosessionenumerator()
        .map_err(|e| e.to_string())?;
    let count = sessions.get_count().map_err(|e| e.to_string())?;
    let mut apps: Vec<Value> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for i in 0..count {
        let Ok(session) = sessions.get_session(i) else {
            continue;
        };
        let pid = session.get_process_id().unwrap_or(0);
        if pid == 0 || !seen.insert(pid) {
            continue;
        }
        let state = session
            .get_state()
            .map(|s| format!("{s:?}").to_lowercase())
            .unwrap_or_else(|_| "unknown".into());
        let display = session.get_display_name().unwrap_or_default();
        apps.push(json!({
            "pid": pid,
            "exe": process_image_name(pid).unwrap_or_default(),
            "displayName": display,
            "state": state,
        }));
    }
    Ok(Value::Array(apps))
}

fn process_image_name(pid: u32) -> Option<String> {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let res = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(buf.as_mut_ptr()),
            &mut len,
        );
        let _ = CloseHandle(handle);
        res.ok()?;
        let full = String::from_utf16_lossy(&buf[..len as usize]);
        full.rsplit('\\').next().map(|s| s.to_string())
    }
}

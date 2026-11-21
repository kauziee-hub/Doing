//! GDI screen-capture probe used by the in-app Capture Compatibility Check.
//!
//! It samples a screen rectangle with `BitBlt(SRCCOPY | CAPTUREBLT)` from the
//! desktop DC — the classic capture path used by many legacy recorders — and
//! returns the average colour. The app paints a known test pattern in the
//! overlay and compares: if the pattern is visible in the sample, the overlay was
//! captured by this method. This *measures* one capture path; it is not a
//! guarantee for any other software.

use serde_json::{json, Value};
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
    ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS,
    SRCCOPY,
};

pub fn set_dpi_aware() {
    use windows::Win32::UI::HiDpi::{
        SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
    };
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
}

/// Coordinates are physical screen pixels.
pub fn gdi_sample(x: i32, y: i32, w: i32, h: i32) -> Result<Value, String> {
    if w <= 0 || h <= 0 || w > 4096 || h > 4096 {
        return Err("invalid rectangle".into());
    }
    unsafe {
        let screen = GetDC(None);
        if screen.is_invalid() {
            return Err("GetDC failed".into());
        }
        let mem = CreateCompatibleDC(Some(screen));
        let bmp = CreateCompatibleBitmap(screen, w, h);
        let old = SelectObject(mem, bmp.into());
        let blt = BitBlt(mem, 0, 0, w, h, Some(screen), x, y, SRCCOPY | CAPTUREBLT);
        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h, // top-down
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut pixels = vec![0u8; (w * h * 4) as usize];
        let lines = GetDIBits(
            mem,
            bmp,
            0,
            h as u32,
            Some(pixels.as_mut_ptr() as *mut _),
            &mut info,
            DIB_RGB_COLORS,
        );
        SelectObject(mem, old);
        let _ = DeleteObject(bmp.into());
        let _ = DeleteDC(mem);
        ReleaseDC(None, screen);
        blt.map_err(|e| format!("BitBlt failed: {e}"))?;
        if lines == 0 {
            return Err("GetDIBits failed".into());
        }
        let (mut r, mut g, mut b) = (0u64, 0u64, 0u64);
        let n = (w * h) as u64;
        for px in pixels.as_chunks::<4>().0 {
            b += px[0] as u64;
            g += px[1] as u64;
            r += px[2] as u64;
        }
        Ok(json!({
            "method": "gdi-bitblt-captureblt",
            "avg": {"r": r / n, "g": g / n, "b": b / n},
            "width": w,
            "height": h,
        }))
    }
}

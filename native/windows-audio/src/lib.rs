//! Hirora native audio helper library.
//!
//! The platform-independent parts (protocol framing, DSP, output queue) compile
//! and are unit-tested everywhere. WASAPI capture, device enumeration and the GDI
//! capture probe are Windows-only.

pub mod dsp;
pub mod output;
pub mod protocol;

#[cfg(windows)]
pub mod capture;
#[cfg(windows)]
pub mod devices;
#[cfg(windows)]
pub mod screen;

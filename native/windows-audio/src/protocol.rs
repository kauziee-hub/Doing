//! Framed binary protocol between the native helper (stdout) and the Electron main process.
//!
//! Every message is a fixed 24-byte little-endian header followed by `payload_len` bytes.
//!
//! | offset | size | field                                              |
//! |-------:|-----:|----------------------------------------------------|
//! | 0      | 2    | magic `b"VC"`                                      |
//! | 2      | 1    | protocol version (currently 1)                     |
//! | 3      | 1    | kind: 1 = PCM audio frame, 2 = JSON event          |
//! | 4      | 1    | source: 0 none, 1 mic, 2 system loopback, 3 app    |
//! | 5      | 1    | flags: bit0 silence-padded, bit1 discontinuity, bit2 clipped |
//! | 6      | 2    | reserved (0)                                       |
//! | 8      | 4    | sequence number (per source for audio)             |
//! | 12     | 8    | monotonic timestamp, microseconds since helper start |
//! | 20     | 4    | payload length in bytes                            |
//!
//! Audio payload: signed 16-bit little-endian PCM, mono, 16 kHz, 20 ms (320 samples).
//! Event payload: UTF-8 JSON object with a `type` field.

pub const MAGIC: [u8; 2] = *b"VC";
pub const VERSION: u8 = 1;
pub const HEADER_LEN: usize = 24;
pub const KIND_AUDIO: u8 = 1;
pub const KIND_EVENT: u8 = 2;

pub const OUTPUT_SAMPLE_RATE: u32 = 16_000;
pub const FRAME_MS: u32 = 20;
pub const FRAME_SAMPLES: usize = (OUTPUT_SAMPLE_RATE as usize * FRAME_MS as usize) / 1000;
/// Hard cap on a single payload, protects the reader from corrupt lengths.
pub const MAX_PAYLOAD: usize = 4 * 1024 * 1024;

pub const FLAG_SILENCE_PADDED: u8 = 0b001;
pub const FLAG_DISCONTINUITY: u8 = 0b010;
pub const FLAG_CLIPPED: u8 = 0b100;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum SourceId {
    None = 0,
    Mic = 1,
    System = 2,
    App = 3,
}

impl SourceId {
    pub fn as_str(self) -> &'static str {
        match self {
            SourceId::None => "none",
            SourceId::Mic => "mic",
            SourceId::System => "system",
            SourceId::App => "app",
        }
    }

    pub fn parse(s: &str) -> Option<SourceId> {
        match s {
            "mic" => Some(SourceId::Mic),
            "system" => Some(SourceId::System),
            "app" => Some(SourceId::App),
            _ => None,
        }
    }

    pub fn from_u8(v: u8) -> SourceId {
        match v {
            1 => SourceId::Mic,
            2 => SourceId::System,
            3 => SourceId::App,
            _ => SourceId::None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FrameHeader {
    pub kind: u8,
    pub source: SourceId,
    pub flags: u8,
    pub seq: u32,
    pub timestamp_us: u64,
    pub payload_len: u32,
}

pub fn encode(header: &FrameHeader, payload: &[u8]) -> Vec<u8> {
    debug_assert_eq!(header.payload_len as usize, payload.len());
    let mut out = Vec::with_capacity(HEADER_LEN + payload.len());
    out.extend_from_slice(&MAGIC);
    out.push(VERSION);
    out.push(header.kind);
    out.push(header.source as u8);
    out.push(header.flags);
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&header.seq.to_le_bytes());
    out.extend_from_slice(&header.timestamp_us.to_le_bytes());
    out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    out.extend_from_slice(payload);
    out
}

pub fn encode_audio(
    source: SourceId,
    seq: u32,
    timestamp_us: u64,
    flags: u8,
    pcm: &[i16],
) -> Vec<u8> {
    let mut payload = Vec::with_capacity(pcm.len() * 2);
    for s in pcm {
        payload.extend_from_slice(&s.to_le_bytes());
    }
    encode(
        &FrameHeader {
            kind: KIND_AUDIO,
            source,
            flags,
            seq,
            timestamp_us,
            payload_len: payload.len() as u32,
        },
        &payload,
    )
}

pub fn encode_event(seq: u32, timestamp_us: u64, json: &str) -> Vec<u8> {
    let bytes = json.as_bytes();
    encode(
        &FrameHeader {
            kind: KIND_EVENT,
            source: SourceId::None,
            flags: 0,
            seq,
            timestamp_us,
            payload_len: bytes.len() as u32,
        },
        bytes,
    )
}

#[derive(Debug, PartialEq, Eq)]
pub enum DecodeError {
    BadMagic,
    BadVersion(u8),
    TooLarge(usize),
}

/// Incremental decoder used by tests (and mirrored in TypeScript). Returns
/// `Ok(Some((header, payload, consumed)))` when a full frame is available.
pub fn decode(buf: &[u8]) -> Result<Option<(FrameHeader, Vec<u8>, usize)>, DecodeError> {
    if buf.len() < HEADER_LEN {
        return Ok(None);
    }
    if buf[0..2] != MAGIC {
        return Err(DecodeError::BadMagic);
    }
    if buf[2] != VERSION {
        return Err(DecodeError::BadVersion(buf[2]));
    }
    let payload_len = u32::from_le_bytes([buf[20], buf[21], buf[22], buf[23]]) as usize;
    if payload_len > MAX_PAYLOAD {
        return Err(DecodeError::TooLarge(payload_len));
    }
    if buf.len() < HEADER_LEN + payload_len {
        return Ok(None);
    }
    let header = FrameHeader {
        kind: buf[3],
        source: SourceId::from_u8(buf[4]),
        flags: buf[5],
        seq: u32::from_le_bytes([buf[8], buf[9], buf[10], buf[11]]),
        timestamp_us: u64::from_le_bytes([
            buf[12], buf[13], buf[14], buf[15], buf[16], buf[17], buf[18], buf[19],
        ]),
        payload_len: payload_len as u32,
    };
    let payload = buf[HEADER_LEN..HEADER_LEN + payload_len].to_vec();
    Ok(Some((header, payload, HEADER_LEN + payload_len)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_samples_is_20ms_at_16k() {
        assert_eq!(FRAME_SAMPLES, 320);
    }

    #[test]
    fn audio_roundtrip() {
        let pcm: Vec<i16> = (0..FRAME_SAMPLES as i32)
            .map(|i| (i * 7 - 1000) as i16)
            .collect();
        let bytes = encode_audio(SourceId::System, 42, 123_456_789, FLAG_CLIPPED, &pcm);
        assert_eq!(bytes.len(), HEADER_LEN + FRAME_SAMPLES * 2);
        let (h, payload, used) = decode(&bytes).unwrap().unwrap();
        assert_eq!(used, bytes.len());
        assert_eq!(h.kind, KIND_AUDIO);
        assert_eq!(h.source, SourceId::System);
        assert_eq!(h.seq, 42);
        assert_eq!(h.timestamp_us, 123_456_789);
        assert_eq!(h.flags, FLAG_CLIPPED);
        let decoded: Vec<i16> = payload
            .as_chunks::<2>()
            .0
            .iter()
            .map(|c| i16::from_le_bytes(*c))
            .collect();
        assert_eq!(decoded, pcm);
    }

    #[test]
    fn event_roundtrip_and_partial_reads() {
        let bytes = encode_event(7, 99, r#"{"type":"hello"}"#);
        // Partial buffers must not decode.
        for cut in 0..bytes.len() {
            assert_eq!(decode(&bytes[..cut]).unwrap(), None);
        }
        let (h, payload, _) = decode(&bytes).unwrap().unwrap();
        assert_eq!(h.kind, KIND_EVENT);
        assert_eq!(
            std::str::from_utf8(&payload).unwrap(),
            r#"{"type":"hello"}"#
        );
    }

    #[test]
    fn rejects_bad_magic_and_oversize() {
        let mut bytes = encode_event(1, 1, "{}");
        bytes[0] = b'X';
        assert_eq!(decode(&bytes), Err(DecodeError::BadMagic));
        let mut big = encode_event(1, 1, "{}");
        big[20..24].copy_from_slice(&(MAX_PAYLOAD as u32 + 1).to_le_bytes());
        assert!(matches!(decode(&big), Err(DecodeError::TooLarge(_))));
    }

    #[test]
    fn source_parse() {
        assert_eq!(SourceId::parse("mic"), Some(SourceId::Mic));
        assert_eq!(SourceId::parse("system"), Some(SourceId::System));
        assert_eq!(SourceId::parse("bogus"), None);
        assert_eq!(SourceId::from_u8(2).as_str(), "system");
    }
}

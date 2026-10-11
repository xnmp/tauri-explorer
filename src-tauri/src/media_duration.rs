//! Video playback length for the Details view's Length column (#995).

use std::io::{Read, Seek};
use std::path::Path;

/// Duration in seconds of a supported video file, or `None` when unreadable.
pub(crate) fn probe_duration(_path: &Path) -> Option<f64> {
    None
}

/// ISO-BMFF (MP4/MOV/M4V): `moov/mvhd` duration ÷ timescale.
fn mp4_duration<R: Read + Seek>(_reader: &mut R) -> Option<f64> {
    None
}

/// Matroska/WebM: `Segment/Info/Duration` × `TimestampScale` nanoseconds.
fn matroska_duration<R: Read + Seek>(_reader: &mut R) -> Option<f64> {
    None
}

/// Parses the `Duration: HH:MM:SS.ff` line ffmpeg prints for its input.
fn parse_ffmpeg_duration(_stderr: &str) -> Option<f64> {
    None
}

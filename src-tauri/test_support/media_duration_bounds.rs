//! Malformed-input bounds for the native duration parsers and the ffmpeg probe
//! (ADR 0028).

use super::*;
use std::io::{Cursor, Seek};

/// Counts every read and seek the parser issues; an Info child costs a few
/// (header bytes, position checks, skip), so the bound is per element.
struct Counting<R> {
    inner: R,
    calls: usize,
}

impl<R: Read> Read for Counting<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        self.calls += 1;
        self.inner.read(buf)
    }
}

impl<R: Seek> Seek for Counting<R> {
    fn seek(&mut self, pos: SeekFrom) -> std::io::Result<u64> {
        self.calls += 1;
        self.inner.seek(pos)
    }
}

fn mp4_box(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
    let mut out = ((payload.len() + 8) as u32).to_be_bytes().to_vec();
    out.extend_from_slice(kind);
    out.extend_from_slice(payload);
    out
}

/// EBML header, then an unknown-size Segment holding `children`.
fn matroska(children: &[u8]) -> Vec<u8> {
    let mut out = vec![0x1A, 0x45, 0xDF, 0xA3, 0x84, 0x42, 0x86, 0x81, 0x01];
    out.extend_from_slice(&[
        0x18, 0x53, 0x80, 0x67, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
    ]);
    out.extend_from_slice(children);
    out
}

/// Info element with an 8-byte size field, so any payload length fits.
fn info(payload: &[u8]) -> Vec<u8> {
    let mut out = vec![0x15, 0x49, 0xA9, 0x66, 0x01];
    out.extend_from_slice(&(payload.len() as u64).to_be_bytes()[1..]);
    out.extend_from_slice(payload);
    out
}

fn duration_f64(milliseconds: f64) -> Vec<u8> {
    let mut out = vec![0x44, 0x89, 0x88];
    out.extend_from_slice(&milliseconds.to_be_bytes());
    out
}

#[test]
fn matroska_info_scan_stops_at_the_sibling_budget() {
    // 100,000 zero-length Void children, then a valid Duration.
    let mut payload = [0xEC, 0x80].repeat(100_000);
    payload.extend(duration_f64(754_000.0));
    let mut reader = Counting {
        inner: Cursor::new(matroska(&info(&payload))),
        calls: 0,
    };
    assert_eq!(matroska_duration(&mut reader), None);
    assert!(
        reader.calls < 8 * MAX_SIBLINGS + 64,
        "oversized Info took {} reads/seeks",
        reader.calls
    );
}

#[test]
fn matroska_info_child_crossing_the_info_boundary_is_rejected() {
    // Info declares only the Duration element's 3-byte header; the 8 value
    // bytes that follow belong to the Segment, not to Info.
    let mut children = info(&[0x44, 0x89, 0x88]);
    children.extend_from_slice(&754_000.0f64.to_be_bytes());
    assert_eq!(
        matroska_duration(&mut Cursor::new(matroska(&children))),
        None
    );
}

#[test]
fn matroska_timestamp_scale_crossing_the_info_boundary_is_rejected() {
    let mut payload = duration_f64(754.0);
    payload.extend_from_slice(&[0x2A, 0xD7, 0xB1, 0x83]); // TimestampScale, 3 bytes
    let mut children = info(&payload);
    children.extend_from_slice(&[0x0F, 0x42, 0x40]);
    assert_eq!(
        matroska_duration(&mut Cursor::new(matroska(&children))),
        None
    );
}

/// `moov` holding an `mvhd` with `mvhd_payload`, followed by a sibling `trak`
/// whose payload starts with a plausible timescale (1000) and duration (60 s).
fn moov_with_short_mvhd(mvhd_payload: &[u8]) -> Vec<u8> {
    let mut trak = Vec::new();
    for _ in 0..4 {
        trak.extend_from_slice(&1000u32.to_be_bytes());
        trak.extend_from_slice(&60_000u32.to_be_bytes());
    }
    let mut moov = mp4_box(b"mvhd", mvhd_payload);
    moov.extend(mp4_box(b"trak", &trak));
    let mut out = mp4_box(b"ftyp", b"isom\0\0\x02\0");
    out.extend(mp4_box(b"moov", &moov));
    out
}

#[test]
fn mp4_short_mvhd_does_not_borrow_bytes_from_its_sibling() {
    assert_eq!(
        mp4_duration(&mut Cursor::new(moov_with_short_mvhd(&[0, 0, 0, 0]))),
        None
    );
    // Version 0 needs 20 payload bytes; 19 is one short.
    let mut v0 = vec![0u8; 12];
    v0.extend_from_slice(&1000u32.to_be_bytes());
    v0.extend_from_slice(&[0xEA, 0x60, 0x00]);
    assert_eq!(
        mp4_duration(&mut Cursor::new(moov_with_short_mvhd(&v0))),
        None
    );
    // Version 1 needs 32 payload bytes.
    let mut v1 = vec![1u8, 0, 0, 0];
    v1.extend_from_slice(&[0u8; 16]);
    assert_eq!(
        mp4_duration(&mut Cursor::new(moov_with_short_mvhd(&v1))),
        None
    );
}

#[test]
fn mp4_mvhd_of_exact_minimum_length_is_read() {
    let mut v0 = vec![0u8; 12];
    v0.extend_from_slice(&1000u32.to_be_bytes());
    v0.extend_from_slice(&60_000u32.to_be_bytes());
    let seconds = mp4_duration(&mut Cursor::new(moov_with_short_mvhd(&v0))).unwrap();
    assert!((seconds - 60.0).abs() < 1e-9);
}

#[cfg(unix)]
fn fake_ffmpeg(dir: &Path, body: &str) -> std::path::PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let script = dir.join("ffmpeg");
    std::fs::write(&script, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    script
}

#[cfg(unix)]
#[test]
fn ffmpeg_probe_kills_a_child_that_outlives_its_deadline() {
    let dir = tempfile::tempdir().unwrap();
    let ffmpeg = fake_ffmpeg(
        dir.path(),
        "echo '  Duration: 00:01:02.50, start: 0' >&2\nexec sleep 30",
    );
    let started = std::time::Instant::now();
    let result = ffmpeg_probe(&ffmpeg, Path::new("clip.avi"), Duration::from_millis(300));
    assert_eq!(result, None);
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "probe waited {:?} for a hung ffmpeg",
        started.elapsed()
    );
}

#[cfg(unix)]
#[test]
fn ffmpeg_probe_reads_the_duration_of_a_child_that_exits() {
    let dir = tempfile::tempdir().unwrap();
    let ffmpeg = fake_ffmpeg(
        dir.path(),
        "echo '  Duration: 00:01:02.50, start: 0' >&2\nexit 1",
    );
    let seconds = ffmpeg_probe(&ffmpeg, Path::new("clip.avi"), Duration::from_secs(10)).unwrap();
    assert!((seconds - 62.5).abs() < 1e-9);
}

#[test]
fn ffmpeg_duration_ignores_duration_text_in_paths_and_tags() {
    let stderr = "Input #0, avi, from 'Duration: 09:00:00.00, x.avi':\n  Metadata:\n    title           : Duration: 05:00:00.00\n  Duration: 00:00:42.00, start: 0.000000, bitrate: 1 kb/s\n";
    assert_eq!(parse_ffmpeg_duration(stderr), Some(42.0));
}

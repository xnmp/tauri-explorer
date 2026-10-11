use super::*;
use std::io::Cursor;

fn mp4_box(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
    let mut out = ((payload.len() + 8) as u32).to_be_bytes().to_vec();
    out.extend_from_slice(kind);
    out.extend_from_slice(payload);
    out
}

fn mvhd_v0(timescale: u32, duration: u32) -> Vec<u8> {
    let mut payload = vec![0u8; 4 + 8]; // version/flags, creation, modification
    payload.extend_from_slice(&timescale.to_be_bytes());
    payload.extend_from_slice(&duration.to_be_bytes());
    payload.extend_from_slice(&[0u8; 80]);
    mp4_box(b"mvhd", &payload)
}

fn mvhd_v1(timescale: u32, duration: u64) -> Vec<u8> {
    let mut payload = vec![1u8, 0, 0, 0];
    payload.extend_from_slice(&[0u8; 16]); // 64-bit creation, modification
    payload.extend_from_slice(&timescale.to_be_bytes());
    payload.extend_from_slice(&duration.to_be_bytes());
    payload.extend_from_slice(&[0u8; 80]);
    mp4_box(b"mvhd", &payload)
}

fn mp4_file(mvhd: Vec<u8>) -> Vec<u8> {
    let mut out = mp4_box(b"ftyp", b"isom\0\0\x02\0isomiso2mp41");
    out.extend(mp4_box(b"free", &[0u8; 16]));
    // moov after a sizeable mdat, as written by most encoders without faststart.
    out.extend(mp4_box(b"mdat", &vec![0xAB; 4096]));
    let mut moov_payload = mp4_box(b"udta", &[0u8; 8]);
    moov_payload.extend(mvhd);
    out.extend(mp4_box(b"moov", &moov_payload));
    out
}

#[test]
fn mp4_reads_mvhd_v0_duration() {
    let bytes = mp4_file(mvhd_v0(1000, 754_250));
    let seconds = mp4_duration(&mut Cursor::new(bytes)).unwrap();
    assert!((seconds - 754.25).abs() < 1e-9);
}

#[test]
fn mp4_reads_mvhd_v1_duration_after_a_64_bit_box() {
    let mut bytes = mp4_box(b"ftyp", b"qt  \0\0\0\0");
    // 64-bit largesize header: size field 1, then the real size.
    bytes.extend_from_slice(&1u32.to_be_bytes());
    bytes.extend_from_slice(b"mdat");
    bytes.extend_from_slice(&(16u64 + 32).to_be_bytes());
    bytes.extend_from_slice(&[0u8; 32]);
    bytes.extend(mp4_box(b"moov", &mvhd_v1(90_000, 90_000 * 3725)));
    let seconds = mp4_duration(&mut Cursor::new(bytes)).unwrap();
    assert!((seconds - 3725.0).abs() < 1e-9);
}

#[test]
fn mp4_without_a_usable_duration_is_none() {
    assert_eq!(mp4_duration(&mut Cursor::new(mp4_file(mvhd_v0(0, 10)))), None);
    assert_eq!(mp4_duration(&mut Cursor::new(mp4_file(mvhd_v0(1000, 0)))), None);
    assert_eq!(mp4_duration(&mut Cursor::new(mp4_file(mvhd_v0(1000, u32::MAX)))), None);
    assert_eq!(mp4_duration(&mut Cursor::new(b"not an mp4 at all".to_vec())), None);
    // A box claiming to be smaller than its own header must not loop forever.
    let mut corrupt = 4u32.to_be_bytes().to_vec();
    corrupt.extend_from_slice(b"free");
    assert_eq!(mp4_duration(&mut Cursor::new(corrupt)), None);
}

fn ebml_header() -> Vec<u8> {
    vec![0x1A, 0x45, 0xDF, 0xA3, 0x84, 0x42, 0x86, 0x81, 0x01]
}

fn segment(children: &[u8]) -> Vec<u8> {
    // Unknown-size segment, as written by live/streaming muxers.
    let mut out = vec![0x18, 0x53, 0x80, 0x67, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF];
    out.extend_from_slice(children);
    out
}

fn info(payload: &[u8]) -> Vec<u8> {
    let mut out = vec![0x15, 0x49, 0xA9, 0x66, 0x80 | payload.len() as u8];
    out.extend_from_slice(payload);
    out
}

#[test]
fn matroska_reads_float64_duration_with_timestamp_scale() {
    let mut payload = vec![0x2A, 0xD7, 0xB1, 0x83, 0x0F, 0x42, 0x40]; // TimestampScale = 1 ms
    payload.extend_from_slice(&[0x44, 0x89, 0x88]);
    payload.extend_from_slice(&754_000.0f64.to_be_bytes());
    let mut children = vec![0xEC, 0x83, 0, 0, 0]; // Void element before Info
    children.extend(info(&payload));
    let mut bytes = ebml_header();
    bytes.extend(segment(&children));
    let seconds = matroska_duration(&mut Cursor::new(bytes)).unwrap();
    assert!((seconds - 754.0).abs() < 1e-6);
}

#[test]
fn matroska_reads_float32_duration_with_default_scale() {
    let mut payload = vec![0x44, 0x89, 0x84];
    payload.extend_from_slice(&3_725_000.0f32.to_be_bytes());
    let mut bytes = ebml_header();
    bytes.extend(segment(&info(&payload)));
    let seconds = matroska_duration(&mut Cursor::new(bytes)).unwrap();
    assert!((seconds - 3725.0).abs() < 1e-3);
}

#[test]
fn matroska_without_info_duration_is_none() {
    // Unknown-size cluster before any Info: stop instead of scanning media data.
    let mut bytes = ebml_header();
    bytes.extend(segment(&[0x1F, 0x43, 0xB6, 0x75, 0xFF, 0xA3, 0x81, 0x00]));
    assert_eq!(matroska_duration(&mut Cursor::new(bytes)), None);
    // Info without a Duration element (e.g. a live recording still in progress).
    let mut bytes = ebml_header();
    bytes.extend(segment(&info(&[0x2A, 0xD7, 0xB1, 0x83, 0x0F, 0x42, 0x40])));
    assert_eq!(matroska_duration(&mut Cursor::new(bytes)), None);
    assert_eq!(matroska_duration(&mut Cursor::new(b"RIFF....AVI ".to_vec())), None);
}

#[test]
fn ffmpeg_duration_line_is_parsed() {
    let stderr = "Input #0, avi, from 'clip.avi':\n  Duration: 01:02:05.50, start: 0.000000, bitrate: 1234 kb/s\n";
    assert_eq!(parse_ffmpeg_duration(stderr), Some(3725.5));
    assert_eq!(parse_ffmpeg_duration("  Duration: 00:12:34.00, start"), Some(754.0));
    assert_eq!(parse_ffmpeg_duration("  Duration: N/A, bitrate: N/A"), None);
    assert_eq!(parse_ffmpeg_duration("clip.avi: Invalid data found when processing input"), None);
}

#[test]
fn probe_reads_supported_video_files_only() {
    let dir = tempfile::tempdir().unwrap();
    let video = dir.path().join("clip.MP4");
    std::fs::write(&video, mp4_file(mvhd_v0(600, 600 * 65))).unwrap();
    let text = dir.path().join("clip.txt");
    std::fs::write(&text, mp4_file(mvhd_v0(600, 600 * 65))).unwrap();

    assert_eq!(probe_duration(&video), Some(65.0));
    assert_eq!(probe_duration(&text), None);
    assert_eq!(probe_duration(dir.path()), None);
    assert_eq!(probe_duration(&dir.path().join("missing.mp4")), None);
}

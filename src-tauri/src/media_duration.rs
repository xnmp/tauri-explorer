//! Video playback length for the Details view's Length column (#995).
//!
//! MP4/MOV/M4V (ISO-BMFF `moov/mvhd`) and MKV/WebM (Matroska `Info/Duration`)
//! are read natively from container headers, which costs a few small reads even
//! when `moov` sits after the media data. Other video containers, and native
//! files whose header carries no usable duration (e.g. fragmented MP4), fall
//! back to ffmpeg when it is available. Anything unreadable yields `None`; the
//! frontend renders that as an empty cell and caches it per file revision.
//! Parser bounds, ffmpeg ownership and limits are fixed by ADR 0028.

use crate::error::AppError;
use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::Path;
use std::time::Duration;

/// Upper bound on boxes/elements visited per level, so a corrupt or hostile
/// file cannot turn a metadata probe into an unbounded scan.
const MAX_SIBLINGS: usize = 4096;

/// Duration in seconds of a supported video file, or `None` when unreadable.
pub(crate) fn probe_duration(path: &Path) -> Option<f64> {
    if !path.is_file() || !crate::thumbnails::is_supported_video(path) {
        return None;
    }
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    let native = match ext.as_str() {
        "mp4" | "mov" | "m4v" => open(path).and_then(|mut r| mp4_duration(&mut r)),
        "mkv" | "webm" => open(path).and_then(|mut r| matroska_duration(&mut r)),
        _ => None,
    };
    native.or_else(|| ffmpeg_duration(path))
}

fn open(path: &Path) -> Option<BufReader<File>> {
    File::open(path).ok().map(BufReader::new)
}

fn valid(seconds: f64) -> Option<f64> {
    (seconds.is_finite() && seconds > 0.0).then_some(seconds)
}

fn read_array<const N: usize, R: Read>(reader: &mut R) -> Option<[u8; N]> {
    let mut buf = [0u8; N];
    reader.read_exact(&mut buf).ok()?;
    Some(buf)
}

fn read_u32<R: Read>(reader: &mut R) -> Option<u32> {
    read_array::<4, _>(reader).map(u32::from_be_bytes)
}

fn read_u64<R: Read>(reader: &mut R) -> Option<u64> {
    read_array::<8, _>(reader).map(u64::from_be_bytes)
}

/// ISO-BMFF (MP4/MOV/M4V): `moov/mvhd` duration ÷ timescale.
fn mp4_duration<R: Read + Seek>(reader: &mut R) -> Option<f64> {
    let end = reader.seek(SeekFrom::End(0)).ok()?;
    let (moov_start, moov_end) = find_box(reader, 0, end, b"moov")?;
    let (mvhd_start, mvhd_end) = find_box(reader, moov_start, moov_end, b"mvhd")?;
    reader.seek(SeekFrom::Start(mvhd_start)).ok()?;
    let version = read_array::<4, _>(reader)?[0];
    // Version/flags, creation and modification times, timescale, duration:
    // the fields must lie inside mvhd, never in the box that follows it.
    let needed = match version {
        0 => 4 + 8 + 4 + 4,
        1 => 4 + 16 + 4 + 8,
        _ => return None,
    };
    if mvhd_end - mvhd_start < needed {
        return None;
    }
    let (timescale, duration) = match version {
        0 => {
            reader.seek(SeekFrom::Current(8)).ok()?;
            let timescale = read_u32(reader)?;
            let duration = read_u32(reader)?;
            // All-ones marks an unknown duration.
            (
                timescale,
                (duration != u32::MAX).then_some(u64::from(duration))?,
            )
        }
        1 => {
            reader.seek(SeekFrom::Current(16)).ok()?;
            let timescale = read_u32(reader)?;
            let duration = read_u64(reader)?;
            (timescale, (duration != u64::MAX).then_some(duration)?)
        }
        _ => return None,
    };
    if timescale == 0 {
        return None;
    }
    valid(duration as f64 / f64::from(timescale))
}

/// Finds the first `kind` box among the boxes in `[start, end)` and returns
/// its payload range.
fn find_box<R: Read + Seek>(
    reader: &mut R,
    start: u64,
    end: u64,
    kind: &[u8; 4],
) -> Option<(u64, u64)> {
    let mut pos = start;
    for _ in 0..MAX_SIBLINGS {
        if end.saturating_sub(pos) < 8 {
            return None;
        }
        reader.seek(SeekFrom::Start(pos)).ok()?;
        let size = read_u32(reader)?;
        let box_kind = read_array::<4, _>(reader)?;
        let (header, size) = match size {
            0 => (8, end - pos),
            1 => (16, read_u64(reader)?),
            size => (8, u64::from(size)),
        };
        if size < header || size > end - pos {
            return None;
        }
        if &box_kind == kind {
            return Some((pos + header, pos + size));
        }
        pos += size;
    }
    None
}

const EBML_HEADER: u64 = 0x1A45_DFA3;
const SEGMENT: u64 = 0x1853_8067;
const INFO: u64 = 0x1549_A966;
const CLUSTER: u64 = 0x1F43_B675;
const TIMESTAMP_SCALE: u64 = 0x2A_D7B1;
const DURATION: u64 = 0x4489;

/// Matroska/WebM: `Segment/Info/Duration` × `TimestampScale` nanoseconds.
fn matroska_duration<R: Read + Seek>(reader: &mut R) -> Option<f64> {
    let end = reader.seek(SeekFrom::End(0)).ok()?;
    reader.seek(SeekFrom::Start(0)).ok()?;
    let (id, size) = ebml_element(reader)?;
    if id != EBML_HEADER {
        return None;
    }
    reader
        .seek(SeekFrom::Current(i64::try_from(size?).ok()?))
        .ok()?;
    let (id, size) = ebml_element(reader)?;
    if id != SEGMENT {
        return None;
    }
    // Children must lie inside the Segment; an unknown-size Segment (live or
    // streaming muxers) runs to the end of the file.
    let segment_end = match size {
        Some(size) => reader.stream_position().ok()?.checked_add(size)?.min(end),
        None => end,
    };
    // Segment children: skip to Info, never into media data.
    for _ in 0..MAX_SIBLINGS {
        if reader.stream_position().ok()? >= segment_end {
            return None;
        }
        let (id, size) = ebml_element(reader)?;
        if id == CLUSTER {
            return None;
        }
        let child_end = reader.stream_position().ok()?.checked_add(size?)?;
        if child_end > segment_end {
            return None;
        }
        if id == INFO {
            return matroska_info_duration(reader, child_end);
        }
        reader.seek(SeekFrom::Start(child_end)).ok()?;
    }
    None
}

fn matroska_info_duration<R: Read + Seek>(reader: &mut R, end: u64) -> Option<f64> {
    let mut scale = 1_000_000u64;
    let mut duration = None;
    let mut visited = 0;
    while reader.stream_position().ok()? < end {
        // An exhausted budget means the scan is incomplete, not that Info ended.
        if visited == MAX_SIBLINGS {
            return None;
        }
        visited += 1;
        let (id, size) = ebml_element(reader)?;
        let size = size?;
        // Each child must end inside Info; never complete one from the bytes
        // of the element that follows.
        if reader.stream_position().ok()?.checked_add(size)? > end {
            return None;
        }
        match (id, size) {
            (TIMESTAMP_SCALE, 1..=8) => {
                let mut value = 0u64;
                for byte in read_bytes(reader, size)? {
                    value = (value << 8) | u64::from(byte);
                }
                scale = value;
            }
            (DURATION, 4) => duration = Some(f64::from(f32::from_be_bytes(read_array(reader)?))),
            (DURATION, 8) => duration = Some(f64::from_be_bytes(read_array(reader)?)),
            _ => {
                reader
                    .seek(SeekFrom::Current(i64::try_from(size).ok()?))
                    .ok()?;
            }
        }
    }
    valid(duration? * scale as f64 / 1e9)
}

fn read_bytes<R: Read>(reader: &mut R, len: u64) -> Option<Vec<u8>> {
    let mut buf = vec![0u8; usize::try_from(len).ok()?];
    reader.read_exact(&mut buf).ok()?;
    Some(buf)
}

/// Reads an element header: the ID (marker bits kept) and the data size, which
/// is `None` for the reserved "unknown size" value.
fn ebml_element<R: Read>(reader: &mut R) -> Option<(u64, Option<u64>)> {
    let first = read_array::<1, _>(reader)?[0];
    let id_len = first.leading_zeros() as usize + 1;
    if id_len > 4 {
        return None;
    }
    let mut id = u64::from(first);
    for _ in 1..id_len {
        id = (id << 8) | u64::from(read_array::<1, _>(reader)?[0]);
    }

    let first = read_array::<1, _>(reader)?[0];
    let size_len = first.leading_zeros() as usize + 1;
    if size_len > 8 {
        return None;
    }
    let mut size = u64::from(first) & (0xFF >> size_len);
    for _ in 1..size_len {
        size = (size << 8) | u64::from(read_array::<1, _>(reader)?[0]);
    }
    let unknown = (1u64 << (7 * size_len)) - 1;
    Some((id, (size != unknown).then_some(size)))
}

/// Longest an ffmpeg probe may run before it is killed (ADR 0028).
const FFMPEG_PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// Most ffmpeg stderr bytes kept. `Duration:` follows the container metadata
/// dump, which large tags (lyrics, long comments) can stretch to many KiB.
const MAX_FFMPEG_STDERR: u64 = 1024 * 1024;

fn ffmpeg_duration(path: &Path) -> Option<f64> {
    let ffmpeg = crate::thumbnails::ffmpeg_path()?;
    ffmpeg_probe(&ffmpeg, path, FFMPEG_PROBE_TIMEOUT)
}

/// Asks ffmpeg to describe the input; it prints `Duration:` on stderr and then
/// exits non-zero because no output was requested.
/// The child is owned until reaped: stderr is drained on a helper thread up to
/// `MAX_FFMPEG_STDERR` bytes, and a child still running at `timeout` is killed.
fn ffmpeg_probe(ffmpeg: &Path, path: &Path, timeout: Duration) -> Option<f64> {
    use crate::process_ext::NoConsole;
    use std::time::Instant;
    let mut child = std::process::Command::new(ffmpeg)
        .args(["-hide_banner", "-nostdin", "-i"])
        .arg(path)
        .no_console()
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .ok()?;
    let stderr = child.stderr.take()?;
    let drain = std::thread::Builder::new()
        .name("ffmpeg-duration-stderr".into())
        .spawn(move || {
            let mut text = Vec::new();
            let _ = stderr.take(MAX_FFMPEG_STDERR).read_to_end(&mut text);
            text
        });
    let Ok(drain) = drain else {
        let _ = child.kill();
        let _ = child.wait();
        return None;
    };
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let text = drain.join().ok()?;
    parse_ffmpeg_duration(&String::from_utf8_lossy(&text))
}

/// Parses the `Duration: HH:MM:SS.ff` line ffmpeg prints for its input. Only a
/// line that starts with `Duration:` counts: the input path and metadata tags
/// are printed earlier and may contain the same text.
fn parse_ffmpeg_duration(stderr: &str) -> Option<f64> {
    let rest = stderr
        .lines()
        .find_map(|line| line.trim_start().strip_prefix("Duration:"))?
        .trim_start();
    let stamp = rest.split(|c: char| c == ',' || c.is_whitespace()).next()?;
    let mut parts = stamp.split(':');
    let hours: f64 = parts.next()?.parse().ok()?;
    let minutes: f64 = parts.next()?.parse().ok()?;
    let seconds: f64 = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    valid(hours * 3600.0 + minutes * 60.0 + seconds)
}

/// Playback length in seconds for each path, in order (`null` when unreadable).
#[tauri::command]
pub async fn get_media_durations(paths: Vec<String>) -> Result<Vec<Option<f64>>, AppError> {
    tokio::task::spawn_blocking(move || {
        paths
            .iter()
            .map(|path| probe_duration(Path::new(path)))
            .collect()
    })
    .await
    .map_err(|e| AppError::Other(format!("Task join error: {}", e)))
}

#[cfg(test)]
#[path = "../test_support/media_duration.rs"]
mod tests;

#[cfg(test)]
#[path = "../test_support/media_duration_bounds.rs"]
mod bounds_tests;

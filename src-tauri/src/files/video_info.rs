//! Best-effort video codec identification and save-a-copy for previews the
//! webview cannot decode. Probing reads bounded head/tail windows only.
use super::object_id::ObjectId;
use crate::error::AppError;
use serde::Serialize;
use std::fs::Metadata;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

const WINDOW: u64 = 4 * 1024 * 1024;

#[derive(Serialize, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct VideoCodecInfo {
    pub container: Option<String>,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// Pure sniffing over a head+tail byte sample.
pub fn sniff(sample: &[u8]) -> VideoCodecInfo {
    let mut info = VideoCodecInfo::default();
    if sample.len() >= 12 && &sample[4..8] == b"ftyp" {
        info.container = Some(
            if &sample[8..12] == b"qt  " {
                "MOV"
            } else {
                "MP4"
            }
            .into(),
        );
        // Sample entries in `stsd` use the codec FourCC directly.
        const VIDEO: &[(&[u8], &str)] = &[
            (b"avc1", "H.264"),
            (b"hvc1", "H.265 (HEVC)"),
            (b"hev1", "H.265 (HEVC)"),
            (b"av01", "AV1"),
            (b"vp09", "VP9"),
            (b"mp4v", "MPEG-4 Visual"),
            (b"apch", "ProRes"),
            (b"apcn", "ProRes"),
            (b"apcs", "ProRes"),
            (b"ap4h", "ProRes"),
            (b"dvh1", "Dolby Vision"),
            (b"dvhe", "Dolby Vision"),
        ];
        const AUDIO: &[(&[u8], &str)] = &[
            (b"mp4a", "AAC"),
            (b"ac-3", "AC-3"),
            (b"ec-3", "E-AC-3"),
            (b"Opus", "Opus"),
            (b"alac", "ALAC"),
            (b"fLaC", "FLAC"),
        ];
        info.video_codec = VIDEO
            .iter()
            .find(|(k, _)| find(sample, k).is_some())
            .map(|(_, v)| (*v).into());
        info.audio_codec = AUDIO
            .iter()
            .find(|(k, _)| find(sample, k).is_some())
            .map(|(_, v)| (*v).into());
    } else if sample.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) {
        let webm = find(sample, b"webm").is_some();
        info.container = Some(if webm { "WebM" } else { "Matroska" }.into());
        const VIDEO: &[(&[u8], &str)] = &[
            (b"V_MPEGH/ISO/HEVC", "H.265 (HEVC)"),
            (b"V_MPEG4/ISO/AVC", "H.264"),
            (b"V_VP9", "VP9"),
            (b"V_VP8", "VP8"),
            (b"V_AV1", "AV1"),
            (b"V_MPEG4/ISO/ASP", "MPEG-4 Visual"),
            (b"V_MS/VFW/FOURCC", "VFW video"),
        ];
        const AUDIO: &[(&[u8], &str)] = &[
            (b"A_AAC", "AAC"),
            (b"A_OPUS", "Opus"),
            (b"A_VORBIS", "Vorbis"),
            (b"A_FLAC", "FLAC"),
            (b"A_EAC3", "E-AC-3"),
            (b"A_AC3", "AC-3"),
            (b"A_DTS", "DTS"),
            (b"A_MPEG/L3", "MP3"),
        ];
        info.video_codec = VIDEO
            .iter()
            .find(|(k, _)| find(sample, k).is_some())
            .map(|(_, v)| (*v).into());
        info.audio_codec = AUDIO
            .iter()
            .find(|(k, _)| find(sample, k).is_some())
            .map(|(_, v)| (*v).into());
    } else if sample.len() >= 12 && &sample[0..4] == b"RIFF" && &sample[8..12] == b"AVI " {
        info.container = Some("AVI".into());
        for (k, v) in [
            (&b"H264"[..], "H.264"),
            (b"XVID", "Xvid"),
            (b"DIVX", "DivX"),
            (b"MJPG", "Motion JPEG"),
            (b"WMV3", "WMV"),
        ] {
            if find(sample, k).is_some() {
                info.video_codec = Some(v.into());
                break;
            }
        }
    }
    info
}

fn read_sample(path: &str) -> std::io::Result<Vec<u8>> {
    let mut file = std::fs::File::open(path)?;
    let len = file.metadata()?.len();
    let mut sample = Vec::new();
    file.by_ref().take(WINDOW).read_to_end(&mut sample)?;
    if len > WINDOW {
        file.seek(SeekFrom::Start(len.saturating_sub(WINDOW).max(WINDOW)))?;
        file.by_ref().take(WINDOW).read_to_end(&mut sample)?;
    }
    Ok(sample)
}

#[tauri::command]
pub async fn probe_video_codec(path: String) -> VideoCodecInfo {
    // Probing failure is not an error: the UI falls back to an unknown codec.
    tokio::task::spawn_blocking(move || read_sample(&path).map(|s| sniff(&s)).unwrap_or_default())
        .await
        .unwrap_or_default()
}

/// Copies `source` to the user-chosen `destination` with the platform copy
/// (`fs::copy`: an existing destination is overwritten in place, a dangling
/// symlink's target is created). The source is never modified (#1588):
///
/// - The source must be a regular file, judged from metadata without opening
///   it (a FIFO would block): missing is `NotFound`, anything else
///   `InvalidPath`.
/// - An existing destination (after following symlinks) must be a regular
///   file, and must not be the source under another spelling: symlink, hard
///   link, `..`, symlinked parent, `/proc/self/fd`. `fs::copy` truncates the
///   destination before reading the source, so copying a file onto itself
///   empties it. Identity is compared, not paths.
///
/// Residual: a concurrent process that swaps the destination for an alias of
/// the source between this check and the copy can still truncate the source.
/// Before #1588 every alias did; now only that race does.
#[tauri::command]
pub async fn save_file_copy(source: String, destination: String) -> Result<(), AppError> {
    tokio::task::spawn_blocking(move || {
        save_copy(
            Path::new(&source),
            Path::new(&destination),
            super::file_identity::of_path,
        )
    })
    .await
    .map_err(|e| AppError::Other(format!("Task join error: {e}")))?
}

fn save_copy(
    source: &Path,
    destination: &Path,
    identity: impl Fn(&Path, &Metadata) -> std::io::Result<ObjectId>,
) -> Result<(), AppError> {
    let source_metadata = match std::fs::metadata(source) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(AppError::NotFound(source.to_string_lossy().into_owned()))
        }
        other => other?,
    };
    if !source_metadata.is_file() {
        return Err(AppError::InvalidPath("Source is not a regular file".into()));
    }
    match std::fs::metadata(destination) {
        // Missing, or a dangling symlink whose target the copy creates.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
        Ok(meta) if meta.is_dir() => {
            return Err(AppError::InvalidPath("Destination is a folder".into()))
        }
        Ok(meta) if !meta.is_file() => {
            return Err(AppError::InvalidPath(
                "Destination is not a regular file".into(),
            ))
        }
        Ok(meta) => {
            if is_same_file((source, &source_metadata), (destination, &meta), identity)? {
                return Err(AppError::InvalidPath(
                    "Choose a different destination".into(),
                ));
            }
        }
    }
    std::fs::copy(source, destination)
        .map(drop)
        .map_err(AppError::from)
}

/// Whether two existing paths name one file. When a file identity cannot be
/// read (a filesystem or redirector without file IDs), canonical paths are
/// compared instead: that still catches symlink and `..` spellings, though not
/// hard links. A path that cannot be canonicalised fails the save.
fn is_same_file(
    (a, a_metadata): (&Path, &Metadata),
    (b, b_metadata): (&Path, &Metadata),
    identity: impl Fn(&Path, &Metadata) -> std::io::Result<ObjectId>,
) -> Result<bool, AppError> {
    match (identity(a, a_metadata), identity(b, b_metadata)) {
        (Ok(a), Ok(b)) => Ok(a == b),
        (Err(error), _) | (_, Err(error)) => {
            log::warn!("save_file_copy: file identity unavailable ({error}); comparing paths");
            Ok(same_canonical_path(
                &std::fs::canonicalize(a)?,
                &std::fs::canonicalize(b)?,
            ))
        }
    }
}

/// Windows paths are case-insensitive; elsewhere identity never fails, so
/// exact comparison is only a fallback for the injected test seam.
fn same_canonical_path(a: &Path, b: &Path) -> bool {
    if cfg!(windows) {
        a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
    } else {
        a == b
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mp4_hevc_aac_is_named() {
        let mut b = vec![0, 0, 0, 0x18];
        b.extend_from_slice(b"ftypisom");
        b.extend_from_slice(&[0; 8]);
        b.extend_from_slice(b"....hvc1....mp4a");
        let i = sniff(&b);
        assert_eq!(i.container.as_deref(), Some("MP4"));
        assert_eq!(i.video_codec.as_deref(), Some("H.265 (HEVC)"));
        assert_eq!(i.audio_codec.as_deref(), Some("AAC"));
    }

    #[test]
    fn matroska_codec_ids_are_named() {
        let mut b = vec![0x1A, 0x45, 0xDF, 0xA3];
        b.extend_from_slice(b"matroska..V_MPEGH/ISO/HEVC..A_EAC3");
        let i = sniff(&b);
        assert_eq!(i.container.as_deref(), Some("Matroska"));
        assert_eq!(i.video_codec.as_deref(), Some("H.265 (HEVC)"));
        assert_eq!(i.audio_codec.as_deref(), Some("E-AC-3"));
    }

    #[test]
    fn unknown_bytes_yield_no_codec() {
        assert_eq!(sniff(b"not a video at all"), VideoCodecInfo::default());
    }

    #[tokio::test]
    async fn save_copy_leaves_source_unchanged() {
        let dir = std::env::temp_dir().join(format!("vi-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (s, d) = (dir.join("a.mkv"), dir.join("b.mkv"));
        std::fs::write(&s, b"data").unwrap();
        save_file_copy(s.to_string_lossy().into(), d.to_string_lossy().into())
            .await
            .unwrap();
        assert_eq!(std::fs::read(&d).unwrap(), b"data");
        assert_eq!(std::fs::read(&s).unwrap(), b"data");
        assert!(
            save_file_copy(s.to_string_lossy().into(), s.to_string_lossy().into())
                .await
                .is_err()
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// When file identity is unavailable (Windows filesystems or
    /// redirectors without file IDs), the alias check falls back to
    /// canonical paths instead of failing every save.
    #[test]
    fn issue_1588_identity_failure_falls_back_to_canonical_paths() {
        let unavailable = |_: &Path, _: &Metadata| -> std::io::Result<ObjectId> {
            Err(std::io::Error::from_raw_os_error(87))
        };
        let root = tempfile::tempdir().unwrap();
        let dir = root.path();
        let src = dir.join("a.mkv");
        std::fs::write(&src, b"precious").unwrap();
        let base = dir.file_name().unwrap().to_str().unwrap();
        let mut aliases = vec![dir.join("..").join(base).join("a.mkv")];
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&src, dir.join("link.mkv")).unwrap();
            aliases.push(dir.join("link.mkv"));
        }
        #[cfg(windows)]
        aliases.push(dir.join("A.MKV"));
        for alias in aliases {
            let r = save_copy(&src, &alias, unavailable);
            assert!(
                matches!(r, Err(AppError::InvalidPath(_))),
                "{alias:?}: {r:?}"
            );
            assert_eq!(std::fs::read(&src).unwrap(), b"precious");
        }
        let other = dir.join("b.mkv");
        std::fs::write(&other, b"old").unwrap();
        save_copy(&src, &other, unavailable).unwrap();
        assert_eq!(std::fs::read(&other).unwrap(), b"precious");
    }
}

#[cfg(test)]
#[path = "../../test_support/save_file_copy_test.rs"]
mod save_file_copy_tests;

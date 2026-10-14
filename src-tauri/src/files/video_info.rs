//! Best-effort video codec identification and save-a-copy for previews the
//! webview cannot decode. Probing reads bounded head/tail windows only.
use crate::error::AppError;
use serde::Serialize;
use std::io::{Read, Seek, SeekFrom};

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
        info.container = Some(if &sample[8..12] == b"qt  " { "MOV" } else { "MP4" }.into());
        // Sample entries in `stsd` use the codec FourCC directly.
        const VIDEO: &[(&[u8], &str)] = &[
            (b"avc1", "H.264"), (b"hvc1", "H.265 (HEVC)"), (b"hev1", "H.265 (HEVC)"),
            (b"av01", "AV1"), (b"vp09", "VP9"), (b"mp4v", "MPEG-4 Visual"),
            (b"apch", "ProRes"), (b"apcn", "ProRes"), (b"apcs", "ProRes"), (b"ap4h", "ProRes"),
            (b"dvh1", "Dolby Vision"), (b"dvhe", "Dolby Vision"),
        ];
        const AUDIO: &[(&[u8], &str)] = &[
            (b"mp4a", "AAC"), (b"ac-3", "AC-3"), (b"ec-3", "E-AC-3"), (b"Opus", "Opus"),
            (b"alac", "ALAC"), (b"fLaC", "FLAC"),
        ];
        info.video_codec = VIDEO.iter().find(|(k, _)| find(sample, k).is_some()).map(|(_, v)| (*v).into());
        info.audio_codec = AUDIO.iter().find(|(k, _)| find(sample, k).is_some()).map(|(_, v)| (*v).into());
    } else if sample.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) {
        let webm = find(sample, b"webm").is_some();
        info.container = Some(if webm { "WebM" } else { "Matroska" }.into());
        const VIDEO: &[(&[u8], &str)] = &[
            (b"V_MPEGH/ISO/HEVC", "H.265 (HEVC)"), (b"V_MPEG4/ISO/AVC", "H.264"),
            (b"V_VP9", "VP9"), (b"V_VP8", "VP8"), (b"V_AV1", "AV1"),
            (b"V_MPEG4/ISO/ASP", "MPEG-4 Visual"), (b"V_MS/VFW/FOURCC", "VFW video"),
        ];
        const AUDIO: &[(&[u8], &str)] = &[
            (b"A_AAC", "AAC"), (b"A_OPUS", "Opus"), (b"A_VORBIS", "Vorbis"), (b"A_FLAC", "FLAC"),
            (b"A_EAC3", "E-AC-3"), (b"A_AC3", "AC-3"), (b"A_DTS", "DTS"), (b"A_MPEG/L3", "MP3"),
        ];
        info.video_codec = VIDEO.iter().find(|(k, _)| find(sample, k).is_some()).map(|(_, v)| (*v).into());
        info.audio_codec = AUDIO.iter().find(|(k, _)| find(sample, k).is_some()).map(|(_, v)| (*v).into());
    } else if sample.len() >= 12 && &sample[0..4] == b"RIFF" && &sample[8..12] == b"AVI " {
        info.container = Some("AVI".into());
        for (k, v) in [(&b"H264"[..], "H.264"), (b"XVID", "Xvid"), (b"DIVX", "DivX"), (b"MJPG", "Motion JPEG"), (b"WMV3", "WMV")] {
            if find(sample, k).is_some() { info.video_codec = Some(v.into()); break; }
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

/// Copies `source` to the user-chosen `destination`; the source is never modified.
#[tauri::command]
pub async fn save_file_copy(source: String, destination: String) -> Result<(), AppError> {
    let (src, dst) = (std::path::PathBuf::from(&source), std::path::PathBuf::from(&destination));
    if src == dst {
        return Err(AppError::InvalidPath("Choose a different destination".into()));
    }
    if !src.is_file() {
        return Err(AppError::NotFound(source));
    }
    tokio::fs::copy(&src, &dst).await.map(|_| ()).map_err(AppError::from)
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
        save_file_copy(s.to_string_lossy().into(), d.to_string_lossy().into()).await.unwrap();
        assert_eq!(std::fs::read(&d).unwrap(), b"data");
        assert_eq!(std::fs::read(&s).unwrap(), b"data");
        assert!(save_file_copy(s.to_string_lossy().into(), s.to_string_lossy().into()).await.is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
}

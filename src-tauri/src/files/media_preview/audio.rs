//! Companion audio for videos whose audio the WebView cannot decode (#1171).
//!
//! WebKitGTK plays an MP4's H.264 picture but silently drops its AAC track when
//! no GStreamer AAC decoder is installed (gst-libav is optional on most
//! distributions): no media error, `audioTracks.length === 0`. The app's ffmpeg
//! decodes that first audio stream into a private file in a format GStreamer's
//! base/good plugins always handle, and the media server publishes it under its
//! own capability for a synchronized `<audio>` element.
use crate::{error::AppError, process_ext::NoConsole};
use std::{
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, SystemTime},
};

/// stderr ffmpeg may return; stream lines follow a possibly large tag dump.
const MAX_STDERR: usize = 1024 * 1024;
/// Earlier sessions' leftovers (a crash skips cleanup) are removed after this.
const STALE_AFTER: Duration = Duration::from_secs(24 * 60 * 60);

/// Output formats in preference order: compact Opus first, then FLAC, whose
/// encoder every ffmpeg build includes. Both decode with stock GStreamer.
const FORMATS: &[(&str, &[&str], &str, &str)] = &[
    ("libopus", &["-b:a", "160k"], "webm", "audio/webm"),
    ("flac", &[], "flac", "audio/flac"),
];

pub(crate) struct Extractor {
    pub ffmpeg: PathBuf,
    /// Private (0700) directory owned by this app for derived files.
    pub directory: PathBuf,
    /// Unique file stem; the capability token.
    pub stem: String,
}

/// True when ffmpeg's input description lists an audio stream.
pub(crate) fn lists_audio_stream(stderr: &str) -> bool {
    stderr
        .lines()
        .any(|line| line.trim_start().starts_with("Stream #") && line.contains(": Audio:"))
}

fn run(
    command: &mut Command,
    cancelled: &impl Fn() -> bool,
) -> Result<std::process::Output, AppError> {
    crate::process_ext::output_controlled(
        command.no_console(),
        cancelled,
        (MAX_STDERR, MAX_STDERR),
        "Video preview was released",
    )
}

impl Extractor {
    /// Decodes `source`'s first audio stream; `None` when it has none.
    pub fn extract(
        &self,
        source: &Path,
        cancelled: impl Fn() -> bool,
    ) -> Result<Option<(PathBuf, &'static str)>, AppError> {
        let probe = run(
            Command::new(&self.ffmpeg)
                .args(["-hide_banner", "-nostdin", "-i"])
                .arg(source),
            &cancelled,
        )?;
        if !lists_audio_stream(&String::from_utf8_lossy(&probe.stderr)) {
            return Ok(None);
        }
        prepare_directory(&self.directory)?;
        let mut failure = String::new();
        for (encoder, options, extension, mime) in FORMATS {
            let output = self.directory.join(format!("{}.{extension}", self.stem));
            let result = run(
                Command::new(&self.ffmpeg)
                    .args(["-hide_banner", "-nostdin", "-v", "error", "-y", "-i"])
                    .arg(source)
                    .args([
                        "-map", "0:a:0", "-vn", "-sn", "-dn", "-ac", "2", "-c:a", encoder,
                    ])
                    .args(*options)
                    .arg(&output),
                &cancelled,
            );
            match result {
                Ok(done) if done.status.success() => return Ok(Some((output, mime))),
                Ok(done) => {
                    let _ = std::fs::remove_file(&output);
                    failure = String::from_utf8_lossy(&done.stderr).trim().to_string();
                    log::warn!("[video-audio] {encoder} decode failed: {failure}");
                }
                Err(error) => {
                    let _ = std::fs::remove_file(&output);
                    return Err(error);
                }
            }
        }
        Err(AppError::Other(format!(
            "Cannot decode this video's audio: {}",
            failure.lines().last().unwrap_or("ffmpeg failed")
        )))
    }
}

/// Creates the private directory and removes stale leftovers from earlier sessions.
fn prepare_directory(directory: &Path) -> Result<(), AppError> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(directory)?;
    let now = SystemTime::now();
    for entry in std::fs::read_dir(directory)?.flatten() {
        let stale = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .is_ok_and(|modified| now.duration_since(modified).unwrap_or_default() > STALE_AFTER);
        if stale {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    Ok(())
}

/// Where derived audio lives: beside the thumbnail cache, never in shared /tmp.
pub(crate) fn directory() -> Option<PathBuf> {
    dirs::cache_dir().map(|cache| cache.join("tauri-explorer").join("video-audio"))
}

//! Window-owned local media capabilities. JavaScript receives URLs, never video bytes.
mod audio;
mod http;
#[cfg(feature = "e2e-hooks")]
mod metrics;
mod range;
mod service;

#[cfg(test)]
#[path = "../../test_support/media_preview.rs"]
mod tests;

use crate::{error::AppError, renderer_owner};
use std::sync::Arc;
use tauri::Manager;
static SERVER: tokio::sync::OnceCell<Arc<http::Server>> = tokio::sync::OnceCell::const_new();

async fn server() -> Result<&'static Arc<http::Server>, AppError> {
    SERVER
        .get_or_try_init(|| async {
            http::start(Arc::new(service::Service::default()))
                .await
                .map_err(AppError::from)
        })
        .await
}
pub(crate) fn retire_owners() {
    if let Some(server) = SERVER.get() {
        server.service.retire_owners();
    }
}
#[tauri::command]
pub async fn begin_video_preview(
    window: tauri::Window,
    session_id: String,
) -> Result<String, AppError> {
    let owner = renderer_owner::acquire_owner(&window, &session_id)?;
    let token = server().await?.service.begin(owner)?;
    #[cfg(feature = "e2e-hooks")]
    log::info!(
        "Video(begin): window={} session={} token={}",
        window.label(),
        session_id,
        token
    );
    Ok(token)
}
#[tauri::command]
pub async fn prepare_video_preview(
    window: tauri::Window,
    session_id: String,
    token: String,
    path: String,
) -> Result<String, AppError> {
    let owner = renderer_owner::acquire_owner(&window, &session_id)?;
    let scope = window.asset_protocol_scope();
    let server = server().await?;
    server
        .service
        .prepare(&token, &owner, path, move |path| scope.is_allowed(path))
        .await?;
    Ok(format!("http://{}/media/{}", server.address, token))
}
/// Companion audio for a video whose own audio track the WebView dropped
/// (#1171). `None` when the file has no audio stream; the capability is retired.
#[tauri::command]
pub async fn prepare_video_audio_preview(
    window: tauri::Window,
    session_id: String,
    token: String,
    path: String,
) -> Result<Option<String>, AppError> {
    let owner = renderer_owner::acquire_owner(&window, &session_id)?;
    let scope = window.asset_protocol_scope();
    let extractor = audio::Extractor {
        ffmpeg: crate::thumbnails::ffmpeg_path().ok_or_else(|| {
            AppError::Other(
                "Cannot play this video's audio: install GStreamer's libav plugins (gst-libav) or ffmpeg"
                    .into(),
            )
        })?,
        directory: audio::directory()
            .ok_or_else(|| AppError::Other("No cache directory for video audio".into()))?,
        stem: token.clone(),
    };
    let server = server().await?;
    let published = server
        .service
        .prepare_audio(
            &token,
            &owner,
            path,
            move |path| scope.is_allowed(path),
            extractor,
        )
        .await?;
    Ok(published.then(|| format!("http://{}/media/{}", server.address, token)))
}
#[tauri::command]
pub async fn release_video_preview(window: tauri::Window, session_id: String, token: String) {
    let server = SERVER.get();
    let owner = renderer_owner::release_owner(&window, &session_id);
    #[cfg(feature = "e2e-hooks")]
    log::info!(
        "Video(release): window={} session={} token={} server={} owner={}",
        window.label(),
        session_id,
        token,
        server.is_some(),
        owner.is_some()
    );
    if let (Some(server), Some(owner)) = (server, owner) {
        server.service.release(&token, &owner);
        #[cfg(feature = "e2e-hooks")]
        log::info!(
            "Video(released): token={} remains={}",
            token,
            server.service.lookup(&token).is_some()
        );
    }
}

#[cfg(feature = "e2e-hooks")]
#[tauri::command]
pub async fn e2e_video_preview_stats() -> serde_json::Value {
    serde_json::to_value(metrics::snapshot(
        SERVER.get().map(|server| server.service.as_ref()),
    ))
    .unwrap()
}

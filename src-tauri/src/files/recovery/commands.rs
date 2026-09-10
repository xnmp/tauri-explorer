//! Renderer requests name native operation IDs, never artifact or user paths.
use super::model::{parse_generation, RecoveryChoice, RecoverySnapshot};
use crate::error::AppError;

#[cfg(target_os = "linux")]
pub(crate) fn owner(
    window: &tauri::Window,
) -> Result<(super::Runtime, std::path::PathBuf), AppError> {
    use tauri::Manager;
    Ok((
        window.state::<super::Runtime>().inner().clone(),
        window
            .path()
            .app_local_data_dir()
            .map_err(|error| AppError::Other(error.to_string()))?
            .join("file-recovery"),
    ))
}

fn validate_id(id: &str) -> Result<(), AppError> {
    if id.len() != 64
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(AppError::Other("Recovery operation ID is invalid".into()));
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn file_recovery_list(
    window: tauri::Window,
    session_id: String,
) -> Result<RecoverySnapshot, AppError> {
    let _renderer = crate::renderer_owner::acquire_owner(&window, &session_id)?;
    #[cfg(target_os = "linux")]
    {
        let (runtime, path) = owner(&window)?;
        runtime.list(path).await
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = window;
        Ok(RecoverySnapshot {
            revision: 0,
            items: vec![],
            error: None,
        })
    }
}

#[tauri::command]
pub(crate) async fn file_recovery_inspect(
    window: tauri::Window,
    session_id: String,
    id: String,
) -> Result<RecoverySnapshot, AppError> {
    validate_id(&id)?;
    let _renderer = crate::renderer_owner::acquire_owner(&window, &session_id)?;
    #[cfg(target_os = "linux")]
    {
        let (runtime, path) = owner(&window)?;
        runtime.inspect(path, id).await
    }
    #[cfg(not(target_os = "linux"))]
    Err(AppError::Other(
        "Native file recovery is not yet supported on this platform".into(),
    ))
}

#[tauri::command]
pub(crate) async fn file_recovery_resolve(
    window: tauri::Window,
    session_id: String,
    id: String,
    generation: String,
    choice: RecoveryChoice,
) -> Result<RecoverySnapshot, AppError> {
    validate_id(&id)?;
    let generation = parse_generation(&generation)?;
    let _renderer = crate::renderer_owner::acquire_owner(&window, &session_id)?;
    #[cfg(target_os = "linux")]
    {
        let (runtime, path) = owner(&window)?;
        runtime.resolve(path, id, generation, choice).await
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (generation, choice);
        Err(AppError::Other(
            "Native file recovery is not yet supported on this platform".into(),
        ))
    }
}

fn subscription_token(value: &str) -> Result<u64, AppError> {
    let token = parse_generation(value)?;
    if token == 0 {
        return Err(AppError::Other(
            "Recovery subscription token is invalid".into(),
        ));
    }
    Ok(token)
}

#[tauri::command]
pub(crate) async fn file_recovery_subscribe(
    window: tauri::Window,
    session_id: String,
    subscription_id: String,
    updates: tauri::ipc::Channel<RecoverySnapshot>,
) -> Result<RecoverySnapshot, AppError> {
    let token = subscription_token(&subscription_id)?;
    let renderer = crate::renderer_owner::acquire_owner(&window, &session_id)?;
    #[cfg(all(target_os = "linux", feature = "e2e-renderer-recovery"))]
    let updates =
        super::native_probe::ObservedChannel::new(updates, window.label(), &session_id, token);
    #[cfg(target_os = "linux")]
    {
        let (runtime, path) = owner(&window)?;
        runtime
            .subscribe(path, renderer, token, move |snapshot| {
                updates.send(snapshot.clone()).is_ok()
            })
            .await
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (renderer, token, updates);
        Ok(RecoverySnapshot {
            revision: 0,
            items: vec![],
            error: None,
        })
    }
}

#[tauri::command]
pub(crate) async fn file_recovery_unsubscribe(
    window: tauri::Window,
    session_id: String,
    subscription_id: String,
) -> Result<(), AppError> {
    let token = subscription_token(&subscription_id)?;
    #[cfg(all(target_os = "linux", feature = "e2e-renderer-recovery"))]
    super::native_probe::released(window.label(), &session_id, token);
    if let Some(renderer) = crate::renderer_owner::release_owner(&window, &session_id) {
        #[cfg(target_os = "linux")]
        {
            use tauri::Manager;
            window
                .state::<super::Runtime>()
                .unsubscribe(&renderer, token)?;
        }
        #[cfg(not(target_os = "linux"))]
        let _ = (renderer, token);
    }
    Ok(())
}

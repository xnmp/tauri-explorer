//! Installed application choice without changing the file's default association.

use crate::error::AppError;
#[cfg(target_os = "linux")]
use std::path::Path;
use std::path::PathBuf;

#[derive(serde::Serialize)]
pub struct OpenWithApplication {
    id: String,
    name: String,
}

fn regular_file(path: &str) -> Result<PathBuf, AppError> {
    let path = std::path::absolute(path)?;
    let metadata = std::fs::metadata(&path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            AppError::NotFound(path.to_string_lossy().into_owned())
        } else {
            AppError::Io(error)
        }
    })?;
    if !metadata.is_file() {
        return Err(AppError::Other(
            "Choose one regular file to open with an application".into(),
        ));
    }
    Ok(path)
}

#[cfg(target_os = "linux")]
fn applications_for(path: &Path) -> Result<Vec<gio::AppInfo>, AppError> {
    use gio::prelude::*;
    use std::collections::HashSet;
    let file = gio::File::for_path(path);
    let info = file
        .query_info(
            "standard::content-type",
            gio::FileQueryInfoFlags::NONE,
            gio::Cancellable::NONE,
        )
        .map_err(|error| AppError::Other(format!("Could not identify this file type: {error}")))?;
    let content_type = info
        .content_type()
        .ok_or_else(|| AppError::Other("Could not identify this file type".into()))?;
    let mut seen = HashSet::new();
    let mut applications: Vec<_> = gio::AppInfo::default_for_type(&content_type, false)
        .into_iter()
        .chain(gio::AppInfo::all_for_type(&content_type))
        .filter(|application| {
            application.should_show()
                && (application.supports_files() || application.supports_uris())
        })
        .filter(|application| {
            application
                .id()
                .is_some_and(|id| seen.insert(id.to_string()))
        })
        .collect();
    applications
        .sort_by_key(|application| (application.display_name().to_lowercase(), application.id()));
    Ok(applications)
}

fn list(path: &str) -> Result<Vec<OpenWithApplication>, AppError> {
    let path = regular_file(path)?;
    #[cfg(target_os = "linux")]
    {
        use gio::prelude::*;
        Ok(applications_for(&path)?
            .into_iter()
            .filter_map(|application| {
                Some(OpenWithApplication {
                    id: application.id()?.to_string(),
                    name: application.display_name().to_string(),
                })
            })
            .collect())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = path;
        Err(AppError::Other(
            "Open with is currently available on Linux".into(),
        ))
    }
}

fn launch(path: &str, application_id: &str) -> Result<(), AppError> {
    let path = regular_file(path)?;
    #[cfg(target_os = "linux")]
    {
        use gio::prelude::*;
        // Revalidate the catalogue at launch; the client supplies an installed
        // desktop ID, never a shell command or an arbitrary executable path.
        if !applications_for(&path)?
            .iter()
            .any(|application| application.id().as_deref() == Some(application_id))
        {
            return Err(AppError::Other(
                "The selected application is no longer available for this file".into(),
            ));
        }
        let application = gio_unix::DesktopAppInfo::new(application_id).ok_or_else(|| {
            AppError::Other("The selected application is no longer installed".into())
        })?;
        application
            .launch(
                &[gio::File::for_path(&path)],
                None::<&gio::AppLaunchContext>,
            )
            .map_err(|error| {
                AppError::Other(format!(
                    "Could not open file with {}: {error}",
                    application.display_name()
                ))
            })
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (path, application_id);
        Err(AppError::Other(
            "Open with is currently available on Linux".into(),
        ))
    }
}

#[tauri::command]
pub async fn list_open_with_applications(
    path: String,
) -> Result<Vec<OpenWithApplication>, AppError> {
    super::run_blocking(move || list(&path)).await
}

#[tauri::command]
pub async fn open_file_with_application(
    path: String,
    application_id: String,
) -> Result<(), AppError> {
    super::run_blocking(move || launch(&path, &application_id)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_directories_and_missing_files_before_launch() {
        let directory = tempfile::tempdir().unwrap();
        assert!(list(directory.path().to_str().unwrap()).is_err());
        assert!(launch(directory.path().to_str().unwrap(), "alternate.desktop").is_err());
        assert!(matches!(
            list(directory.path().join("missing").to_str().unwrap()),
            Err(AppError::NotFound(_))
        ));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn rejects_unregistered_commands_and_preserves_selected_file_bytes() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("a space ü ' $(touch injected).txt");
        std::fs::write(&path, "unchanged").unwrap();
        assert!(launch(path.to_str().unwrap(), "sh -c touch injected").is_err());
        assert!(!directory.path().join("injected").exists());
        assert_eq!(std::fs::read(&path).unwrap(), b"unchanged");
    }
}

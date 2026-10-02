#[cfg(target_os = "linux")]
use super::file_manager1_service_unavailable;

#[cfg(target_os = "linux")]
#[test]
fn issue_757_fallback_only_after_definite_file_manager1_unavailability() {
    let error = |error| zbus::Error::FDO(Box::new(error));
    assert!(file_manager1_service_unavailable(&error(
        zbus::fdo::Error::ServiceUnknown("no file manager".into())
    )));
    assert!(file_manager1_service_unavailable(&error(
        zbus::fdo::Error::UnknownMethod("no ShowFolders".into())
    )));
    assert!(!file_manager1_service_unavailable(&error(
        zbus::fdo::Error::TimedOut("activation may still complete".into())
    )));
    assert!(!file_manager1_service_unavailable(&error(
        zbus::fdo::Error::AccessDenied("activation rejected".into())
    )));
}

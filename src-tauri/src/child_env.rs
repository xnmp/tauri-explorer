//! Environment hygiene for processes the app launches (#1079).
//!
//! On Linux the app sets WebKitGTK renderer variables in its own environment
//! (see `webkit_renderer`). Those are a choice for *our* webview; children
//! (terminal shells, Open With, default apps, launchers) must not inherit them,
//! or every other WebKitGTK app started from the explorer runs with our
//! renderer. Variables the user set themselves are never recorded here and
//! pass through unchanged.

use std::sync::OnceLock;

/// Marker naming the variables the app applied, so a self-restarted process
/// can tell its own choices from the user's. Never passed to children.
pub(crate) const APPLIED_MARKER_VAR: &str = "TAURI_EXPLORER_WEBKIT_RENDERER_APPLIED";

static APP_SET: OnceLock<Vec<&'static str>> = OnceLock::new();

/// Record the variables the app set. First call wins.
#[cfg(target_os = "linux")]
pub(crate) fn record_app_set(names: Vec<&'static str>) {
    let _ = APP_SET.set(names);
}

/// Variables the app set itself (never user-set ones).
pub(crate) fn app_set_vars() -> &'static [&'static str] {
    APP_SET.get().map(Vec::as_slice).unwrap_or(&[])
}

/// Names to strip from a child's environment: app-set variables + the marker.
pub(crate) fn scrub_names() -> impl Iterator<Item = &'static str> {
    let marker = (!app_set_vars().is_empty()).then_some(APPLIED_MARKER_VAR);
    app_set_vars().iter().copied().chain(marker)
}

/// Remove app-set variables from a `std::process::Command`'s environment.
pub(crate) fn scrub_command(command: &mut std::process::Command) -> &mut std::process::Command {
    for name in scrub_names() {
        command.env_remove(name);
    }
    command
}

/// Remove app-set variables from a pty `CommandBuilder`'s environment.
pub(crate) fn scrub_pty(command: &mut portable_pty::CommandBuilder) {
    for name in scrub_names() {
        command.env_remove(name);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A spawned child must not see an app-set variable but must see a
    /// user-set one.
    #[test]
    #[cfg(unix)]
    fn child_does_not_see_app_set_variable_but_sees_user_set_one() {
        std::env::set_var("WEBKIT_FORCE_DMABUF_RENDERER", "1"); // app-set
        std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "user"); // user-set
        std::env::set_var(APPLIED_MARKER_VAR, "WEBKIT_FORCE_DMABUF_RENDERER");
        record_app_set_for_test(vec!["WEBKIT_FORCE_DMABUF_RENDERER"]);

        let mut command = std::process::Command::new("/bin/sh");
        command.args([
            "-c",
            "echo \"a=${WEBKIT_FORCE_DMABUF_RENDERER-unset};u=${WEBKIT_DISABLE_COMPOSITING_MODE-unset};m=${TAURI_EXPLORER_WEBKIT_RENDERER_APPLIED-unset}\"",
        ]);
        scrub_command(&mut command);
        let out = command.output().unwrap();
        assert_eq!(
            String::from_utf8_lossy(&out.stdout).trim(),
            "a=unset;u=user;m=unset"
        );
    }

    #[cfg(unix)]
    fn record_app_set_for_test(names: Vec<&'static str>) {
        let _ = APP_SET.set(names);
    }
}

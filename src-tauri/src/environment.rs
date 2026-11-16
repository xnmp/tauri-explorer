//! Environment summary for user reports, crash files and the log (#1683).
//!
//! Bug reports used to say only `linux (x86_64)`, hiding the facts most Tauri
//! bugs depend on: distro, webview engine version, Wayland/X11 and desktop,
//! and how the app was installed. Parsing, classification and rendering here
//! are pure; the platform probes are thin adapters that return `None` rather
//! than failing, so a missing file or registry value renders as "unknown".
//!
//! Nothing here leaves the machine on its own: a report carries it only when
//! the user submits one. Values never include paths or user names: install
//! location is reduced to a category before it is stored.
//!
//! The summary is computed once per process, off the startup path
//! (`spawn_startup_probe`), and the panic hook only ever reads the cache.

use serde::Serialize;
use std::sync::OnceLock;

/// Upper bound for one rendered value; probes read attacker-sized inputs
/// (environment variables, `/etc/os-release`).
const MAX_VALUE_CHARS: usize = 100;
/// `/etc/os-release` is a few hundred bytes; anything larger is not one.
#[cfg(all(unix, not(target_os = "macos")))]
const MAX_OS_RELEASE_BYTES: u64 = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EnvironmentField {
    pub label: &'static str,
    pub value: String,
}

/// How the running executable was installed, reduced to a category so the
/// report never carries the executable's path (which contains user names).
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Install {
    AppImage,
    Flatpak,
    Snap,
    SystemPackage,
    Homebrew,
    Applications,
    Translocated,
    WindowsAllUsers,
    WindowsPerUser,
    SourceBuild,
    #[default]
    Other,
}

impl Install {
    fn label(self) -> &'static str {
        match self {
            Install::AppImage => "AppImage",
            Install::Flatpak => "Flatpak",
            Install::Snap => "Snap",
            Install::SystemPackage => "system package",
            Install::Homebrew => "Homebrew",
            Install::Applications => "app bundle in Applications",
            // Gatekeeper runs quarantined apps from a randomized read-only
            // copy until they are moved; a distinct class of bugs.
            Install::Translocated => "translocated app bundle (not moved to Applications)",
            Install::WindowsAllUsers => "installer (all users)",
            Install::WindowsPerUser => "installer (current user)",
            Install::SourceBuild => "source build",
            Install::Other => "other location",
        }
    }
}

/// Raw platform facts gathered by `probe()`. The pure `summarize` decides how
/// absence renders.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct Probe {
    pub os_name: Option<String>,
    pub os: &'static str,
    pub arch: &'static str,
    pub webview_engine: &'static str,
    pub webview_version: Option<String>,
    pub renderer: Option<String>,
    pub session_type: Option<String>,
    pub desktop: Option<String>,
    pub gdk_backend: Option<String>,
    pub wsl: bool,
    pub install: Install,
}

/// Strip control characters, collapse whitespace and bound the length.
pub(crate) fn clean(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .filter(|character| !character.is_control())
        .take(MAX_VALUE_CHARS)
        .collect()
}

fn field(label: &'static str, value: impl AsRef<str>) -> EnvironmentField {
    EnvironmentField {
        label,
        value: clean(value.as_ref()),
    }
}

fn present(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

pub(crate) fn summarize(probe: &Probe) -> Vec<EnvironmentField> {
    let os_name = present(probe.os_name.as_deref()).unwrap_or(probe.os);
    let mut fields = vec![
        field("OS", format!("{os_name} ({})", probe.arch)),
        field(
            "Webview",
            format!(
                "{} {}",
                probe.webview_engine,
                present(probe.webview_version.as_deref()).unwrap_or("unknown")
            ),
        ),
    ];
    if let Some(renderer) = present(probe.renderer.as_deref()) {
        fields.push(field("Renderer", renderer));
    }
    let session: Vec<String> = [
        present(probe.session_type.as_deref()).map(str::to_owned),
        present(probe.desktop.as_deref()).map(str::to_owned),
        present(probe.gdk_backend.as_deref()).map(|backend| format!("GDK_BACKEND={backend}")),
        // Presence only: a WSL distro name is user-chosen (and can contain a
        // name), while the OS line already identifies the distribution.
        probe.wsl.then(|| "WSL".to_owned()),
    ]
    .into_iter()
    .flatten()
    .collect();
    if !session.is_empty() {
        fields.push(field("Session", session.join(", ")));
    }
    fields.push(field("Install", probe.install.label()));
    fields
}

/// The display scale of the window the report was written in, when known.
pub(crate) fn display_scale_field(scale: Option<f64>) -> Option<EnvironmentField> {
    let scale = scale.filter(|scale| scale.is_finite() && *scale > 0.0 && *scale < 100.0)?;
    let rendered = format!("{scale:.2}");
    let rendered = rendered.trim_end_matches('0').trim_end_matches('.');
    Some(field("Display scale", rendered))
}

/// `- Label: value` lines for the issue body, version first, within
/// `max_units` UTF-16 units (the relay's measure). A line that does not fit
/// is dropped whole, never cut, and later shorter lines may still fit.
pub(crate) fn render_report_lines(
    version: &str,
    fields: &[EnvironmentField],
    max_units: usize,
) -> String {
    let lines = std::iter::once(format!("- Tauri Explorer: v{}", clean(version))).chain(
        fields
            .iter()
            .map(|field| format!("- {}: {}", field.label, clean(&field.value))),
    );
    let mut used = 0;
    let mut kept = Vec::new();
    for line in lines {
        let cost = line.encode_utf16().count() + usize::from(!kept.is_empty());
        if used + cost <= max_units {
            used += cost;
            kept.push(line);
        }
    }
    kept.join("\n")
}

/// `label: value` header lines for a crash file. Lowercase labels keep the
/// historical `os:` line, which existing tooling greps for.
pub(crate) fn render_crash_lines(fields: &[EnvironmentField]) -> String {
    fields
        .iter()
        .map(|field| format!("{}: {}", field.label.to_ascii_lowercase(), field.value))
        .collect::<Vec<_>>()
        .join("\n")
}

/// One self-describing log line, so a pasted log names its environment.
pub(crate) fn render_log_line(fields: &[EnvironmentField]) -> String {
    fields
        .iter()
        .map(|field| format!("{}={}", field.label, field.value))
        .collect::<Vec<_>>()
        .join("; ")
}

/// Crash-file header for the current process. Never probes: the panic hook
/// may run inside the probe itself, and a panicking thread must not block.
pub(crate) fn crash_header() -> String {
    cached()
        .map(render_crash_lines)
        .unwrap_or_else(|| format!("os: {} ({})", std::env::consts::OS, std::env::consts::ARCH))
}

/// Parse `/etc/os-release` (freedesktop format) into a display name.
#[cfg(any(test, all(unix, not(target_os = "macos"))))]
pub(crate) fn parse_os_release(text: &str) -> Option<String> {
    let mut pretty = None;
    let mut name = None;
    let mut version = None;
    for line in text.lines().take(200) {
        let Some((key, raw)) = line.trim().split_once('=') else {
            continue;
        };
        let value = unquote(raw.trim());
        if value.trim().is_empty() {
            continue;
        }
        match key.trim() {
            "PRETTY_NAME" => pretty = Some(value),
            "NAME" => name = Some(value),
            "VERSION_ID" => version = Some(value),
            _ => {}
        }
    }
    pretty
        .or_else(|| match (name, version) {
            (Some(name), Some(version)) => Some(format!("{name} {version}")),
            (name, _) => name,
        })
        .map(|value| clean(&value))
        .filter(|value| !value.is_empty())
}

/// Shell-style value unquoting as the os-release spec allows.
#[cfg(any(test, all(unix, not(target_os = "macos"))))]
fn unquote(raw: &str) -> String {
    let inner = ['"', '\'']
        .iter()
        .find_map(|quote| {
            raw.strip_prefix(*quote)
                .and_then(|rest| rest.strip_suffix(*quote))
        })
        .unwrap_or(raw);
    let mut out = String::with_capacity(inner.len());
    let mut chars = inner.chars();
    while let Some(character) = chars.next() {
        if character == '\\' {
            if let Some(escaped) = chars.next() {
                out.push(escaped);
            }
        } else {
            out.push(character);
        }
    }
    out
}

#[cfg(any(test, windows))]
/// Windows marketing name from the registry's build facts. Windows 11 still
/// reports `ProductName` "Windows 10"; the build number is authoritative.
pub(crate) fn windows_version_name(
    build: Option<u32>,
    ubr: Option<u32>,
    display_version: Option<&str>,
) -> Option<String> {
    let build = build?;
    let name = match build {
        22000.. => "Windows 11",
        10240.. => "Windows 10",
        _ => "Windows",
    };
    let display = present(display_version)
        .map(|value| format!(" {value}"))
        .unwrap_or_default();
    let build = match ubr {
        Some(ubr) => format!("{build}.{ubr}"),
        None => build.to_string(),
    };
    Some(format!("{name}{display} (build {build})"))
}

#[cfg(any(test, target_os = "macos"))]
pub(crate) fn macos_product_version(bytes: &[u8]) -> Option<String> {
    let value = plist::Value::from_reader(std::io::Cursor::new(bytes)).ok()?;
    let version = value.as_dictionary()?.get("ProductVersion")?.as_string()?;
    present(Some(version)).map(|version| format!("macOS {}", clean(version)))
}

/// Classify the install from environment markers and the executable path.
/// `env_set` reports only presence, so no environment value is retained.
pub(crate) fn classify_install(
    os: &str,
    env_set: &dyn Fn(&str) -> bool,
    exe: Option<&str>,
) -> Install {
    let path = exe.unwrap_or_default().replace('\\', "/");
    let lower = path.to_ascii_lowercase();
    let segments: Vec<&str> = lower.split('/').filter(|s| !s.is_empty()).collect();
    let source_build = segments.iter().enumerate().any(|(index, segment)| {
        *segment == "target"
            && segments[index + 1..]
                .iter()
                .any(|later| *later == "debug" || *later == "release")
    });
    match os {
        "linux" | "freebsd" | "openbsd" | "netbsd" | "dragonfly" => {
            if env_set("APPIMAGE") {
                Install::AppImage
            } else if env_set("FLATPAK_ID") {
                Install::Flatpak
            } else if env_set("SNAP") {
                Install::Snap
            } else if source_build {
                Install::SourceBuild
            } else if path.starts_with("/usr/") || path.starts_with("/opt/") {
                Install::SystemPackage
            } else {
                Install::Other
            }
        }
        "macos" => {
            if source_build {
                Install::SourceBuild
            } else if lower.contains("/apptranslocation/") {
                Install::Translocated
            } else if lower.contains("/caskroom/")
                || lower.starts_with("/opt/homebrew/")
                || lower.starts_with("/usr/local/cellar/")
            {
                Install::Homebrew
            } else if lower.starts_with("/applications/")
                || (lower.starts_with("/users/") && lower.contains("/applications/"))
            {
                Install::Applications
            } else {
                Install::Other
            }
        }
        "windows" => {
            if source_build {
                Install::SourceBuild
            } else if segments
                .iter()
                .any(|segment| segment.starts_with("program files"))
            {
                Install::WindowsAllUsers
            } else if lower.contains("/appdata/local/") {
                Install::WindowsPerUser
            } else {
                Install::Other
            }
        }
        _ => Install::Other,
    }
}

#[cfg(target_os = "linux")]
const WEBVIEW_ENGINE: &str = "WebKitGTK";
#[cfg(target_os = "macos")]
const WEBVIEW_ENGINE: &str = "WKWebView";
#[cfg(windows)]
const WEBVIEW_ENGINE: &str = "WebView2";
#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
const WEBVIEW_ENGINE: &str = "WebKitGTK";

#[cfg(all(unix, not(target_os = "macos")))]
fn os_name() -> Option<String> {
    use std::io::Read;
    ["/etc/os-release", "/usr/lib/os-release"]
        .iter()
        .find_map(|path| {
            let mut text = String::new();
            std::fs::File::open(path)
                .ok()?
                .take(MAX_OS_RELEASE_BYTES)
                .read_to_string(&mut text)
                .ok()?;
            parse_os_release(&text)
        })
}

#[cfg(target_os = "macos")]
fn os_name() -> Option<String> {
    let bytes = std::fs::read("/System/Library/CoreServices/SystemVersion.plist").ok()?;
    macos_product_version(&bytes)
}

#[cfg(windows)]
fn os_name() -> Option<String> {
    use windows_sys::Win32::{
        Foundation::ERROR_SUCCESS,
        System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_DWORD, RRF_RT_REG_SZ},
    };
    let wide = |s: &str| s.encode_utf16().chain([0]).collect::<Vec<u16>>();
    let key = wide(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion");
    let read_string = |name: &str| -> Option<String> {
        let value = wide(name);
        let mut buffer = [0u16; 128];
        let mut size = std::mem::size_of_val(&buffer) as u32;
        // SAFETY: both names are NUL-terminated and outlive the call; `size`
        // is `buffer`'s byte capacity, and RRF_RT_REG_SZ guarantees a
        // terminated string on success (a longer value fails with MORE_DATA).
        let status = unsafe {
            RegGetValueW(
                HKEY_LOCAL_MACHINE,
                key.as_ptr(),
                value.as_ptr(),
                RRF_RT_REG_SZ,
                std::ptr::null_mut(),
                buffer.as_mut_ptr().cast(),
                &mut size,
            )
        };
        if status != ERROR_SUCCESS {
            return None;
        }
        let units = (size as usize / 2).min(buffer.len());
        let end = buffer[..units]
            .iter()
            .position(|&unit| unit == 0)
            .unwrap_or(units);
        String::from_utf16(&buffer[..end]).ok()
    };
    let read_dword = |name: &str| -> Option<u32> {
        let value = wide(name);
        let mut data = 0u32;
        let mut size = std::mem::size_of::<u32>() as u32;
        // SAFETY: as above; `data` is a writable DWORD of `size` bytes.
        let status = unsafe {
            RegGetValueW(
                HKEY_LOCAL_MACHINE,
                key.as_ptr(),
                value.as_ptr(),
                RRF_RT_REG_DWORD,
                std::ptr::null_mut(),
                (&mut data as *mut u32).cast(),
                &mut size,
            )
        };
        (status == ERROR_SUCCESS).then_some(data)
    };
    windows_version_name(
        read_string("CurrentBuild").and_then(|build| build.trim().parse().ok()),
        read_dword("UBR"),
        read_string("DisplayVersion").as_deref(),
    )
}

#[cfg(not(any(unix, windows)))]
fn os_name() -> Option<String> {
    None
}

fn probe() -> Probe {
    let env_value = |key: &str| {
        std::env::var(key)
            .ok()
            .filter(|value| !value.trim().is_empty())
    };
    let env_set = |key: &str| std::env::var_os(key).is_some_and(|value| !value.is_empty());
    let exe = std::env::current_exe().ok();
    let linux_like = cfg!(all(unix, not(target_os = "macos")));
    let session_type = linux_like
        .then(|| {
            env_value("XDG_SESSION_TYPE")
                .or_else(|| env_set("WAYLAND_DISPLAY").then(|| "wayland".to_owned()))
                .or_else(|| env_set("DISPLAY").then(|| "x11".to_owned()))
        })
        .flatten();
    Probe {
        os_name: os_name(),
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        webview_engine: WEBVIEW_ENGINE,
        webview_version: tauri::webview_version().ok(),
        renderer: RENDERER.get().cloned(),
        session_type,
        desktop: linux_like
            .then(|| env_value("XDG_CURRENT_DESKTOP"))
            .flatten(),
        gdk_backend: linux_like.then(|| env_value("GDK_BACKEND")).flatten(),
        wsl: linux_like && env_set("WSL_DISTRO_NAME"),
        install: classify_install(
            std::env::consts::OS,
            &env_set,
            exe.as_deref().and_then(|path| path.to_str()),
        ),
    }
}

static SUMMARY: OnceLock<Vec<EnvironmentField>> = OnceLock::new();
static RENDERER: OnceLock<String> = OnceLock::new();

/// Record the renderer mode chosen at startup (Linux WebKitGTK workarounds).
/// Call before `spawn_startup_probe` so the summary includes it.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn record_renderer(mode: String) {
    let _ = RENDERER.set(mode);
}

/// The process's environment summary, probing on first use.
pub(crate) fn summary() -> &'static [EnvironmentField] {
    SUMMARY.get_or_init(|| summarize(&probe()))
}

/// The summary if a probe has completed; never probes.
pub(crate) fn cached() -> Option<&'static [EnvironmentField]> {
    SUMMARY.get().map(Vec::as_slice)
}

/// Probe on a background thread at startup and log the result once.
pub(crate) fn spawn_startup_probe() {
    let spawned = std::thread::Builder::new()
        .name("environment-probe".into())
        .spawn(|| log::info!("Environment: {}", render_log_line(summary())));
    if let Err(error) = spawned {
        log::warn!("Environment probe thread failed to start: {error}");
    }
}

#[cfg(test)]
#[path = "../test_support/environment_test.rs"]
mod tests;

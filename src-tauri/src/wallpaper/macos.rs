//! macOS "Set as Wallpaper" for every display and, on macOS 14+, every
//! Space (#1441).
//!
//! 1. Public API: `NSWorkspace.setDesktopImageURL(_:for:options:)` once per
//!    `NSScreen` (run through JXA, so no new bindings). This changes every
//!    display, but only on the current Space.
//! 2. macOS 14+: once macOS has persisted that choice to the private
//!    wallpaper store, point every Space/display entry of the store at it
//!    (`macos_store`) and restart `WallpaperAgent` so it reloads the store.
//! 3. Anything that could not be done is reported back as a notice for the
//!    toast; a store this code does not recognise is never written.
//!
//! macOS 13 and earlier keep per-Space choices in the Dock's
//! `desktoppicture.db`, whose schema is undocumented and shared with other
//! preferences, so it is not edited; the notice says other Spaces kept their
//! wallpaper. See `docs/lessons/1441-macos-wallpaper-all-spaces.md`.

use super::macos_store;
use super::WallpaperOutcome;
use crate::error::AppError;
use std::time::Duration;

/// First macOS release with the `com.apple.wallpaper` store (Sonoma).
pub const STORE_MIN_MAJOR: u32 = 14;

/// How long to wait for macOS to persist the NSWorkspace change before
/// modelling the new entries on another image entry instead.
const STORE_POLL_ATTEMPTS: u32 = 12;
const STORE_POLL_INTERVAL: Duration = Duration::from_millis(250);

/// Result of the per-display NSWorkspace step.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
pub struct ScreenReport {
    /// Displays attached (`NSScreen.screens.count`).
    pub screens: usize,
    /// Displays whose wallpaper was set.
    pub set: usize,
    #[serde(default)]
    pub errors: Vec<String>,
}

/// What happened to Spaces other than the current one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OtherSpaces {
    /// Every Space/display entry of the store now shows the image.
    Changed,
    /// This macOS version has no store this code can edit.
    Unsupported { major: Option<u32> },
    /// The store step was attempted and skipped; nothing was written unless
    /// the reason says so.
    NotChanged { reason: String },
}

/// The OS operations `set_wallpaper` needs, injected so its decisions can be
/// tested without a Mac.
pub trait MacWallpaperOs {
    /// `sw_vers -productVersion`, e.g. "14.6.1".
    fn product_version(&mut self) -> Result<String, String>;
    /// NSWorkspace desktop image for every screen (current Space).
    fn set_on_every_screen(&mut self, image_path: &str) -> Result<ScreenReport, String>;
    /// The wallpaper store; `Ok(None)` when it does not exist.
    fn read_store(&mut self) -> Result<Option<Vec<u8>>, String>;
    /// Replace the wallpaper store atomically.
    fn write_store(&mut self, bytes: &[u8]) -> Result<(), String>;
    /// Make WallpaperAgent reload the store.
    fn restart_wallpaper_agent(&mut self) -> Result<(), String>;
    fn sleep(&mut self, duration: Duration);
}

/// Major version of a `sw_vers -productVersion` string ("14.6.1" → 14,
/// "26" → 26). None for anything unparseable.
pub fn parse_major(version: &str) -> Option<u32> {
    version.trim().split('.').next()?.parse().ok()
}

/// Parse the JXA step's JSON output.
pub fn parse_screen_report(stdout: &str) -> Result<ScreenReport, String> {
    let report: ScreenReport = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("unexpected response from the display step ({e})"))?;
    if report.set > report.screens {
        return Err("unexpected response from the display step".into());
    }
    Ok(report)
}

/// The toast notice for a partial result, or None when every display and
/// every Space was changed.
pub fn summarize(screens: &ScreenReport, other_spaces: &OtherSpaces) -> Option<String> {
    let displays = if screens.set == screens.screens {
        None
    } else {
        let detail = match screens.errors.first() {
            Some(e) => format!(" ({e})"),
            None => String::new(),
        };
        Some(format!(
            "Wallpaper set on {} of {} displays{detail}.",
            screens.set, screens.screens
        ))
    };
    let spaces = match other_spaces {
        OtherSpaces::Changed => None,
        OtherSpaces::Unsupported { major: Some(major) } => Some(format!(
            "Only the current Space was changed: macOS {major} offers no supported way to change other Spaces (macOS {STORE_MIN_MAJOR} or later is needed)."
        )),
        OtherSpaces::Unsupported { major: None } => Some(
            "Only the current Space was changed: the macOS version could not be determined."
                .to_string(),
        ),
        OtherSpaces::NotChanged { reason } => {
            Some(format!("Only the current Space was changed: {reason}."))
        }
    };
    match (displays, spaces) {
        (None, None) => None,
        (Some(d), None) => Some(d),
        (None, Some(s)) => Some(s),
        (Some(d), Some(s)) => Some(format!("{d} {s}")),
    }
}

/// Wait for macOS to persist the new image, then return the latest store.
fn read_store_after_set(
    os: &mut impl MacWallpaperOs,
    image_path: &str,
) -> Result<Option<Vec<u8>>, String> {
    let mut latest = os.read_store()?;
    for _ in 0..STORE_POLL_ATTEMPTS {
        match &latest {
            Some(bytes) if macos_store::records_image(bytes, image_path) => break,
            _ => {}
        }
        os.sleep(STORE_POLL_INTERVAL);
        latest = os.read_store()?;
    }
    Ok(latest)
}

fn change_other_spaces(os: &mut impl MacWallpaperOs, image_path: &str) -> OtherSpaces {
    let store = match read_store_after_set(os, image_path) {
        Ok(Some(store)) => store,
        Ok(None) => {
            return OtherSpaces::NotChanged {
                reason: "the wallpaper store was not found".into(),
            }
        }
        Err(e) => {
            return OtherSpaces::NotChanged {
                reason: format!("the wallpaper store could not be read ({e})"),
            }
        }
    };
    let rewrite = match macos_store::rewrite_store(&store, image_path) {
        Ok(rewrite) => rewrite,
        Err(e) => {
            log::warn!("wallpaper store left unchanged: {e:?}");
            return OtherSpaces::NotChanged {
                reason: e.to_string(),
            };
        }
    };
    if rewrite.changed == 0 {
        return OtherSpaces::Changed;
    }
    if let Err(e) = os.write_store(&rewrite.bytes) {
        return OtherSpaces::NotChanged {
            reason: format!("the wallpaper store could not be written ({e})"),
        };
    }
    log::info!(
        "wallpaper store: {} of {} entries now show the image ({:?})",
        rewrite.changed,
        rewrite.entries,
        rewrite.source
    );
    match os.restart_wallpaper_agent() {
        Ok(()) => OtherSpaces::Changed,
        Err(e) => OtherSpaces::NotChanged {
            reason: format!(
                "other Spaces were saved but WallpaperAgent could not be restarted ({e}); they update after the next login"
            ),
        },
    }
}

/// Set `image_path` (absolute, canonical) on every display and, where the
/// running macOS allows, every Space.
pub fn set_wallpaper(
    os: &mut impl MacWallpaperOs,
    image_path: &str,
) -> Result<WallpaperOutcome, AppError> {
    let screens = os
        .set_on_every_screen(image_path)
        .map_err(|e| AppError::Other(format!("Failed to set wallpaper: {e}")))?;
    if screens.set == 0 {
        let reason = screens
            .errors
            .first()
            .cloned()
            .unwrap_or_else(|| "no display accepted the image".into());
        return Err(AppError::Other(format!(
            "Failed to set wallpaper: {reason}"
        )));
    }

    let major = os.product_version().ok().as_deref().and_then(parse_major);
    let other_spaces = match major {
        Some(m) if m >= STORE_MIN_MAJOR => change_other_spaces(os, image_path),
        _ => OtherSpaces::Unsupported { major },
    };
    Ok(WallpaperOutcome {
        notice: summarize(&screens, &other_spaces),
    })
}

/// The real OS behind [`MacWallpaperOs`].
#[cfg(target_os = "macos")]
pub struct SystemMacOs;

#[cfg(target_os = "macos")]
impl SystemMacOs {
    fn store_path() -> Result<std::path::PathBuf, String> {
        let home = dirs::home_dir().ok_or("home directory unknown")?;
        Ok(home.join("Library/Application Support/com.apple.wallpaper/Store/Index.plist"))
    }
}

/// JXA: NSWorkspace desktop image for every NSScreen, keeping each screen's
/// current scaling options. The path arrives as argv, never interpolated
/// into the script, so filenames cannot inject code.
#[cfg(target_os = "macos")]
const SET_EVERY_SCREEN_JXA: &str = r#"
ObjC.import('AppKit');
function run(argv) {
  var url = $.NSURL.fileURLWithPath(argv[0]);
  var ws = $.NSWorkspace.sharedWorkspace;
  var screens = $.NSScreen.screens;
  var total = screens.count;
  var set = 0;
  var errors = [];
  for (var i = 0; i < total; i++) {
    try {
      var screen = screens.objectAtIndex(i);
      var options = ws.desktopImageOptionsForScreen(screen);
      if (!options || options.isNil()) { options = $.NSDictionary.dictionary; }
      var error = Ref();
      if (ws.setDesktopImageURLForScreenOptionsError(url, screen, options, error)) {
        set++;
      } else {
        var e = error[0];
        errors.push(e && !e.isNil() ? e.localizedDescription.js : 'display ' + (i + 1) + ' refused the image');
      }
    } catch (err) {
      errors.push(String(err));
    }
  }
  return JSON.stringify({ screens: total, set: set, errors: errors });
}
"#;

#[cfg(target_os = "macos")]
impl MacWallpaperOs for SystemMacOs {
    fn product_version(&mut self) -> Result<String, String> {
        let output = std::process::Command::new("sw_vers")
            .arg("-productVersion")
            .output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    }

    fn set_on_every_screen(&mut self, image_path: &str) -> Result<ScreenReport, String> {
        let output = std::process::Command::new("osascript")
            .args(["-l", "JavaScript", "-e", SET_EVERY_SCREEN_JXA, image_path])
            .output()
            .map_err(|e| format!("osascript failed: {e}"))?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
        parse_screen_report(&String::from_utf8_lossy(&output.stdout))
    }

    fn read_store(&mut self) -> Result<Option<Vec<u8>>, String> {
        match std::fs::read(Self::store_path()?) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    fn write_store(&mut self, bytes: &[u8]) -> Result<(), String> {
        // Temp file in the same directory, then rename: a crash mid-write
        // must never leave WallpaperAgent a truncated store.
        let path = Self::store_path()?;
        let tmp = path.with_file_name(".Index.plist.tauri-explorer.tmp");
        std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &path).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            e.to_string()
        })
    }

    fn restart_wallpaper_agent(&mut self) -> Result<(), String> {
        // launchd relaunches the agent on demand; it then reads the store.
        let output = std::process::Command::new("killall")
            .arg("WallpaperAgent")
            .output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
        Ok(())
    }

    fn sleep(&mut self, duration: Duration) {
        std::thread::sleep(duration);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use plist::{Dictionary, Value};

    const IMG: &str = "/Users/me/Pictures/new wallpaper.png";

    /// Scripted OS: records writes/restarts; `store_reads` is served in order
    /// (the last one repeats).
    struct FakeOs {
        version: Result<String, String>,
        screens: Result<ScreenReport, String>,
        store_reads: Vec<Result<Option<Vec<u8>>, String>>,
        reads: usize,
        write_result: Result<(), String>,
        restart_result: Result<(), String>,
        written: Vec<Vec<u8>>,
        restarts: usize,
        slept: Duration,
    }

    impl FakeOs {
        fn new(version: &str, store_reads: Vec<Result<Option<Vec<u8>>, String>>) -> Self {
            FakeOs {
                version: Ok(version.into()),
                screens: Ok(ScreenReport {
                    screens: 2,
                    set: 2,
                    errors: vec![],
                }),
                store_reads,
                reads: 0,
                write_result: Ok(()),
                restart_result: Ok(()),
                written: vec![],
                restarts: 0,
                slept: Duration::ZERO,
            }
        }
    }

    impl MacWallpaperOs for FakeOs {
        fn product_version(&mut self) -> Result<String, String> {
            self.version.clone()
        }
        fn set_on_every_screen(&mut self, _: &str) -> Result<ScreenReport, String> {
            self.screens.clone()
        }
        fn read_store(&mut self) -> Result<Option<Vec<u8>>, String> {
            let i = self.reads.min(self.store_reads.len() - 1);
            self.reads += 1;
            self.store_reads[i].clone()
        }
        fn write_store(&mut self, bytes: &[u8]) -> Result<(), String> {
            self.written.push(bytes.to_vec());
            self.write_result.clone()
        }
        fn restart_wallpaper_agent(&mut self) -> Result<(), String> {
            self.restarts += 1;
            self.restart_result.clone()
        }
        fn sleep(&mut self, d: Duration) {
            self.slept += d;
        }
    }

    fn entry(path: &str) -> Value {
        let mut file = Dictionary::new();
        file.insert(
            "relative".into(),
            Value::String(macos_store::file_url(path)),
        );
        let mut choice = Dictionary::new();
        choice.insert("Configuration".into(), Value::Data(vec![1, 2, 3]));
        choice.insert("Files".into(), Value::Array(vec![Value::Dictionary(file)]));
        choice.insert(
            "Provider".into(),
            Value::String(macos_store::IMAGE_PROVIDER.into()),
        );
        let mut content = Dictionary::new();
        content.insert(
            "Choices".into(),
            Value::Array(vec![Value::Dictionary(choice)]),
        );
        let mut desktop = Dictionary::new();
        desktop.insert("Content".into(), Value::Dictionary(content));
        let mut e = Dictionary::new();
        e.insert("Desktop".into(), Value::Dictionary(desktop));
        Value::Dictionary(e)
    }

    /// Current Space shows `current`, the other Space still shows old.jpg.
    fn store(current: &str) -> Vec<u8> {
        let mut space2 = Dictionary::new();
        space2.insert("Default".into(), entry("/old.jpg"));
        let mut space1 = Dictionary::new();
        space1.insert("Default".into(), entry(current));
        let mut spaces = Dictionary::new();
        spaces.insert("S1".into(), Value::Dictionary(space1));
        spaces.insert("S2".into(), Value::Dictionary(space2));
        let mut root = Dictionary::new();
        root.insert("AllSpacesAndDisplays".into(), entry("/old.jpg"));
        root.insert("Spaces".into(), Value::Dictionary(spaces));
        let mut out = Vec::new();
        Value::Dictionary(root).to_writer_binary(&mut out).unwrap();
        out
    }

    #[test]
    fn parses_versions() {
        assert_eq!(parse_major("14.6.1\n"), Some(14));
        assert_eq!(parse_major("26"), Some(26));
        assert_eq!(parse_major("10.15.7"), Some(10));
        assert_eq!(parse_major(""), None);
        assert_eq!(parse_major("Sonoma"), None);
    }

    #[test]
    fn parses_screen_reports_and_rejects_nonsense() {
        assert_eq!(
            parse_screen_report("{\"screens\":2,\"set\":1,\"errors\":[\"denied\"]}\n"),
            Ok(ScreenReport {
                screens: 2,
                set: 1,
                errors: vec!["denied".into()]
            })
        );
        assert!(parse_screen_report("").is_err());
        assert!(parse_screen_report("execution error: -1743").is_err());
        assert!(parse_screen_report("{\"screens\":1,\"set\":3,\"errors\":[]}").is_err());
    }

    #[test]
    fn sonoma_changes_every_space_and_reports_nothing() {
        let mut os = FakeOs::new(
            "14.6.1",
            vec![Ok(Some(store("/old.jpg"))), Ok(Some(store(IMG)))],
        );
        let outcome = set_wallpaper(&mut os, IMG).unwrap();

        assert_eq!(outcome.notice, None);
        assert_eq!(os.restarts, 1);
        assert_eq!(os.written.len(), 1);
        assert!(macos_store::records_image(&os.written[0], IMG));
        let after = macos_store::rewrite_store(&os.written[0], IMG).unwrap();
        assert_eq!(
            after.changed, 0,
            "every entry in the written store already shows the image"
        );
        assert!(
            os.slept > Duration::ZERO,
            "waited for macOS to persist its own entry first"
        );
    }

    #[test]
    fn still_changes_every_space_when_macos_never_persists_the_new_entry() {
        let mut os = FakeOs::new("15.0", vec![Ok(Some(store("/old.jpg")))]);
        let outcome = set_wallpaper(&mut os, IMG).unwrap();
        assert_eq!(outcome.notice, None);
        assert_eq!(os.written.len(), 1);
        assert_eq!(
            macos_store::rewrite_store(&os.written[0], IMG)
                .unwrap()
                .changed,
            0
        );
        assert_eq!(
            os.slept,
            STORE_POLL_INTERVAL * STORE_POLL_ATTEMPTS,
            "bounded wait"
        );
    }

    #[test]
    fn ventura_reports_that_other_spaces_were_not_changed_and_never_touches_the_store() {
        let mut os = FakeOs::new("13.6", vec![Ok(Some(store("/old.jpg")))]);
        let notice = set_wallpaper(&mut os, IMG).unwrap().notice.unwrap();
        assert!(notice.contains("Only the current Space"), "{notice}");
        assert!(notice.contains("macOS 13"), "{notice}");
        assert_eq!((os.reads, os.written.len(), os.restarts), (0, 0, 0));
    }

    #[test]
    fn unknown_version_is_treated_as_unsupported() {
        let mut os = FakeOs::new("", vec![Ok(None)]);
        os.version = Err("sw_vers missing".into());
        let notice = set_wallpaper(&mut os, IMG).unwrap().notice.unwrap();
        assert!(notice.contains("could not be determined"), "{notice}");
        assert!(os.written.is_empty());
    }

    #[test]
    fn unrecognised_store_is_left_alone_and_reported() {
        let mut empty = Vec::new();
        Value::Dictionary(Dictionary::new())
            .to_writer_binary(&mut empty)
            .unwrap();
        let mut os = FakeOs::new("14.0", vec![Ok(Some(empty))]);
        let notice = set_wallpaper(&mut os, IMG).unwrap().notice.unwrap();
        assert!(
            notice.contains("format this version does not recognise"),
            "{notice}"
        );
        assert_eq!((os.written.len(), os.restarts), (0, 0));
    }

    #[test]
    fn missing_or_unreadable_store_is_reported() {
        let mut os = FakeOs::new("14.0", vec![Ok(None)]);
        assert!(set_wallpaper(&mut os, IMG)
            .unwrap()
            .notice
            .unwrap()
            .contains("not found"));
        let mut os = FakeOs::new("14.0", vec![Err("permission denied".into())]);
        let notice = set_wallpaper(&mut os, IMG).unwrap().notice.unwrap();
        assert!(notice.contains("permission denied"), "{notice}");
        assert!(os.written.is_empty());
    }

    #[test]
    fn write_and_restart_failures_are_reported_without_failing_the_current_space() {
        let mut os = FakeOs::new("14.0", vec![Ok(Some(store(IMG)))]);
        os.write_result = Err("read-only".into());
        let notice = set_wallpaper(&mut os, IMG).unwrap().notice.unwrap();
        assert!(
            notice.contains("could not be written (read-only)"),
            "{notice}"
        );
        assert_eq!(
            os.restarts, 0,
            "never restart the agent onto an unwritten store"
        );

        let mut os = FakeOs::new("14.0", vec![Ok(Some(store(IMG)))]);
        os.restart_result = Err("No matching processes".into());
        let notice = set_wallpaper(&mut os, IMG).unwrap().notice.unwrap();
        assert!(notice.contains("after the next login"), "{notice}");
    }

    #[test]
    fn partial_displays_are_reported_alongside_spaces() {
        let mut os = FakeOs::new("12.7", vec![Ok(None)]);
        os.screens = Ok(ScreenReport {
            screens: 3,
            set: 2,
            errors: vec!["display busy".into()],
        });
        let notice = set_wallpaper(&mut os, IMG).unwrap().notice.unwrap();
        assert!(
            notice.starts_with("Wallpaper set on 2 of 3 displays (display busy)."),
            "{notice}"
        );
        assert!(notice.contains("macOS 12"), "{notice}");
    }

    #[test]
    fn no_display_changed_is_an_error_and_skips_the_store() {
        let mut os = FakeOs::new("14.0", vec![Ok(Some(store("/old.jpg")))]);
        os.screens = Ok(ScreenReport {
            screens: 2,
            set: 0,
            errors: vec!["not permitted".into()],
        });
        let err = set_wallpaper(&mut os, IMG).unwrap_err().to_string();
        assert!(err.contains("not permitted"), "{err}");
        assert_eq!(os.reads, 0);

        let mut os = FakeOs::new("14.0", vec![Ok(None)]);
        os.screens = Err("osascript: execution error".into());
        assert!(set_wallpaper(&mut os, IMG).is_err());
    }

    #[test]
    fn summary_is_silent_only_for_complete_success() {
        let all = ScreenReport {
            screens: 2,
            set: 2,
            errors: vec![],
        };
        assert_eq!(summarize(&all, &OtherSpaces::Changed), None);
        assert!(summarize(&all, &OtherSpaces::Unsupported { major: Some(13) }).is_some());
        assert!(summarize(&all, &OtherSpaces::NotChanged { reason: "x".into() }).is_some());
    }
}

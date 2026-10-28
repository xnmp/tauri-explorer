//! macOS "Set as Wallpaper" for every display and, on macOS 14+, every
//! Space (#1441).
//!
//! 1. Snapshot the private wallpaper store, then call
//!    `NSWorkspace.setDesktopImageURL(_:for:options:)` once per `NSScreen`
//!    (through JXA, so no new bindings). This changes every display, but
//!    only on the current Space.
//! 2. macOS 14+: wait until WallpaperAgent has persisted that change (an
//!    entry for the image that differs from the snapshot), so its save
//!    cannot later clobber ours. Then return the store to all-Spaces mode
//!    around macOS's own entry (`macos_store`), replace it atomically,
//!    restart WallpaperAgent and re-read the store to confirm the change
//!    survived the reload.
//! 3. Anything not done is reported as a notice for the toast. On timeout,
//!    an unrecognised store, a failed display, or a symlinked store,
//!    nothing is written.
//!
//! macOS 13 and earlier keep per-Space choices in the Dock's
//! `desktoppicture.db`, whose schema is undocumented and shared with other
//! preferences, so it is not edited. See
//! `docs/lessons/1441-macos-wallpaper-all-spaces.md`.

use super::macos_store;
use super::WallpaperOutcome;
use crate::error::AppError;
use std::time::Duration;

/// First macOS release with the `com.apple.wallpaper` store (Sonoma).
pub const STORE_MIN_MAJOR: u32 = 14;

/// How long to wait for WallpaperAgent to persist the NSWorkspace change.
const STORE_POLL_ATTEMPTS: u32 = 12;
const STORE_POLL_INTERVAL: Duration = Duration::from_millis(250);
/// Time for the restarted agent to load (and possibly re-save) the store.
const VERIFY_DELAY: Duration = Duration::from_millis(1500);

/// Result of the per-display NSWorkspace step.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
pub struct ScreenReport {
    /// Displays attached (`NSScreen.screens.count`).
    pub screens: usize,
    /// Displays now showing the image (including `already`).
    pub set: usize,
    /// Displays that already showed the image, so were left alone: setting
    /// the current image again is a no-op that persists nothing.
    #[serde(default)]
    pub already: usize,
    #[serde(default)]
    pub errors: Vec<String>,
}

/// What happened to Spaces other than the current one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OtherSpaces {
    /// The store is in all-Spaces mode showing the image, confirmed after
    /// WallpaperAgent reloaded it.
    Changed,
    /// This macOS version has no store this code can edit.
    Unsupported { major: Option<u32> },
    /// Not changed, for `reason`.
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

/// Major version of a `sw_vers -productVersion` string ("14.6.1" → 14).
pub fn parse_major(version: &str) -> Option<u32> {
    version.trim().split('.').next()?.parse().ok()
}

/// Parse the JXA step's JSON output.
pub fn parse_screen_report(stdout: &str) -> Result<ScreenReport, String> {
    let report: ScreenReport = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("unexpected response from the display step ({e})"))?;
    if report.set > report.screens || report.already > report.set {
        return Err("unexpected response from the display step".into());
    }
    Ok(report)
}

/// The toast notice for a partial result, or None when every display and
/// every Space was changed.
pub fn summarize(screens: &ScreenReport, other_spaces: &OtherSpaces) -> Option<String> {
    let displays = (screens.set != screens.screens).then(|| {
        let detail = screens
            .errors
            .first()
            .map(|e| format!(" ({e})"))
            .unwrap_or_default();
        format!(
            "Wallpaper set on {} of {} displays{detail}.",
            screens.set, screens.screens
        )
    });
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
        (Some(one), None) | (None, Some(one)) => Some(one),
        (Some(d), Some(s)) => Some(format!("{d} {s}")),
    }
}

fn not_changed(reason: impl Into<String>) -> OtherSpaces {
    OtherSpaces::NotChanged {
        reason: reason.into(),
    }
}

fn read_existing(os: &mut impl MacWallpaperOs) -> Result<Vec<u8>, OtherSpaces> {
    match os.read_store() {
        Ok(Some(store)) => Ok(store),
        Ok(None) => Err(not_changed("the wallpaper store was not found")),
        Err(e) => Err(not_changed(format!(
            "the wallpaper store could not be read ({e})"
        ))),
    }
}

/// The `Desktop` entry macOS wrote for the image and the store holding it,
/// or a reason. When every display already showed the image, NSWorkspace
/// persisted nothing, so the store as read is current and its existing
/// entry for the image is macOS's own.
fn await_macos_entry(
    os: &mut impl MacWallpaperOs,
    before: Option<&[u8]>,
    screens: &ScreenReport,
    image_path: &str,
) -> Result<(Vec<u8>, plist::Dictionary), OtherSpaces> {
    if screens.already == screens.set {
        let store = read_existing(os)?;
        return macos_store::existing_image_desktop(&store, image_path)
            .map(|d| (store, d))
            .ok_or_else(|| not_changed(macos_store::StoreError::UnrecognisedLayout.to_string()));
    }
    for _ in 0..STORE_POLL_ATTEMPTS {
        os.sleep(STORE_POLL_INTERVAL);
        let store = read_existing(os)?;
        if let Some(desktop) = macos_store::fresh_image_desktop(before, &store, image_path) {
            return Ok((store, desktop));
        }
    }
    Err(not_changed(
        "macOS did not save the change in time, so other Spaces were left untouched",
    ))
}

fn change_other_spaces(
    os: &mut impl MacWallpaperOs,
    before: Option<&[u8]>,
    screens: &ScreenReport,
    image_path: &str,
) -> OtherSpaces {
    let (store, desktop) = match await_macos_entry(os, before, screens, image_path) {
        Ok(found) => found,
        Err(outcome) => return outcome,
    };
    if macos_store::shows_everywhere(&store, image_path) {
        return OtherSpaces::Changed;
    }
    let rewritten = match macos_store::all_spaces_store(&store, &desktop) {
        Ok(bytes) => bytes,
        Err(e) => {
            log::warn!("wallpaper store left unchanged: {e:?}");
            return not_changed(e.to_string());
        }
    };
    if let Err(e) = os.write_store(&rewritten) {
        return not_changed(format!("the wallpaper store was not modified ({e})"));
    }
    if let Err(e) = os.restart_wallpaper_agent() {
        return not_changed(format!(
            "other Spaces were saved but WallpaperAgent could not be restarted ({e}); they update after the next login"
        ));
    }
    os.sleep(VERIFY_DELAY);
    match os.read_store() {
        Ok(Some(after)) if macos_store::shows_everywhere(&after, image_path) => {
            OtherSpaces::Changed
        }
        Ok(_) => not_changed("macOS kept its per-Space wallpapers after reloading"),
        Err(e) => not_changed(format!(
            "the wallpaper store could not be re-read to confirm the change ({e})"
        )),
    }
}

/// Set `image_path` (absolute, canonical) on every display and, where the
/// running macOS allows, every Space.
pub fn set_wallpaper(
    os: &mut impl MacWallpaperOs,
    image_path: &str,
) -> Result<WallpaperOutcome, AppError> {
    let major = os.product_version().ok().as_deref().and_then(parse_major);
    let uses_store = major.is_some_and(|m| m >= STORE_MIN_MAJOR);
    // Snapshot immediately before the change, so the wait below recognises
    // macOS's save rather than an entry that already showed this image.
    let before = if uses_store {
        Some(os.read_store())
    } else {
        None
    };

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

    let other_spaces = match before {
        None => OtherSpaces::Unsupported { major },
        Some(_) if screens.set < screens.screens => {
            not_changed("other Spaces were left untouched because a display could not be changed")
        }
        Some(Err(e)) => not_changed(format!("the wallpaper store could not be read ({e})")),
        Some(Ok(before)) => change_other_spaces(os, before.as_deref(), &screens, image_path),
    };
    Ok(WallpaperOutcome {
        notice: summarize(&screens, &other_spaces),
    })
}

/// Replace `path` with `bytes` without ever exposing a partial file: a
/// uniquely named temp file in the same directory, given the original's
/// permissions and synced, then renamed over it. A symlinked or missing
/// store is refused. The temp file is removed on any failure.
#[cfg(any(target_os = "macos", test))]
pub fn replace_file_atomically(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let meta = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if meta.file_type().is_symlink() {
        return Err("it is a symbolic link".into());
    }
    if !meta.is_file() {
        return Err("it is not a regular file".into());
    }
    let dir = path.parent().ok_or("it has no parent directory")?;
    let mut tmp = tempfile::Builder::new()
        .prefix(".Index.plist.")
        .suffix(".tmp")
        .tempfile_in(dir)
        .map_err(|e| e.to_string())?;
    tmp.write_all(bytes).map_err(|e| e.to_string())?;
    std::fs::set_permissions(tmp.path(), meta.permissions()).map_err(|e| e.to_string())?;
    tmp.as_file().sync_all().map_err(|e| e.to_string())?;
    tmp.persist(path).map_err(|e| e.error.to_string())?;
    Ok(())
}

/// Serialises the whole macOS flow: two concurrent sets would otherwise
/// interleave their snapshot/wait/rewrite of the one store.
#[cfg(target_os = "macos")]
static FLOW: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Entry point for the real OS.
#[cfg(target_os = "macos")]
pub fn set_wallpaper_system(image_path: &str) -> Result<WallpaperOutcome, AppError> {
    let _guard = FLOW.lock().unwrap_or_else(|e| e.into_inner());
    set_wallpaper(&mut SystemMacOs, image_path)
}

/// The real OS behind [`MacWallpaperOs`].
#[cfg(target_os = "macos")]
struct SystemMacOs;

#[cfg(target_os = "macos")]
fn store_path() -> Result<std::path::PathBuf, String> {
    let home = dirs::home_dir().ok_or("home directory unknown")?;
    Ok(home.join("Library/Application Support/com.apple.wallpaper/Store/Index.plist"))
}

/// JXA: NSWorkspace desktop image for every NSScreen, keeping each screen's
/// current scaling options. A screen already showing the image is left
/// alone (re-setting it is a no-op) and counted in `already`. The path
/// arrives as argv, never interpolated into the script.
#[cfg(target_os = "macos")]
const SET_EVERY_SCREEN_JXA: &str = r#"
ObjC.import('AppKit');
function run(argv) {
  var url = $.NSURL.fileURLWithPath(argv[0]);
  var target = url.URLByStandardizingPath.path.js;
  var ws = $.NSWorkspace.sharedWorkspace;
  var screens = $.NSScreen.screens;
  var total = screens.count;
  var set = 0;
  var already = 0;
  var errors = [];
  for (var i = 0; i < total; i++) {
    try {
      var screen = screens.objectAtIndex(i);
      var current = ws.desktopImageURLForScreen(screen);
      if (current && !current.isNil() && current.URLByStandardizingPath.path.js === target) {
        set++;
        already++;
        continue;
      }
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
  return JSON.stringify({ screens: total, set: set, already: already, errors: errors });
}
"#;

#[cfg(target_os = "macos")]
fn run(program: &str, args: &[&str]) -> Result<String, String> {
    let output = std::process::Command::new(program)
        .args(args)
        .output()
        .map_err(|e| format!("{program}: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "{program}: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(target_os = "macos")]
impl MacWallpaperOs for SystemMacOs {
    fn product_version(&mut self) -> Result<String, String> {
        run("sw_vers", &["-productVersion"]).map(|v| v.trim().to_string())
    }

    fn set_on_every_screen(&mut self, image_path: &str) -> Result<ScreenReport, String> {
        let stdout = run(
            "osascript",
            &["-l", "JavaScript", "-e", SET_EVERY_SCREEN_JXA, image_path],
        )?;
        parse_screen_report(&stdout)
    }

    fn read_store(&mut self) -> Result<Option<Vec<u8>>, String> {
        match std::fs::read(store_path()?) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    fn write_store(&mut self, bytes: &[u8]) -> Result<(), String> {
        replace_file_atomically(&store_path()?, bytes)
    }

    fn restart_wallpaper_agent(&mut self) -> Result<(), String> {
        // SAFETY: getuid has no preconditions and cannot fail.
        let uid = unsafe { libc::getuid() };
        let target = format!("gui/{uid}/com.apple.wallpaper.agent");
        run("launchctl", &["kickstart", "-k", &target])
            .or_else(|e| {
                log::warn!("launchctl kickstart failed ({e}); falling back to killall");
                run("killall", &["WallpaperAgent"])
            })
            .map(|_| ())
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

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum Event {
        Read,
        Set,
        Write,
        Restart,
    }

    /// Scripted OS. Reads before any write are served from `reads` (the
    /// last repeats); after a successful write the store holds the written
    /// bytes unless `after_restart` says what the reloaded agent left.
    struct FakeOs {
        version: Result<String, String>,
        screens: Result<ScreenReport, String>,
        reads: Vec<Result<Option<Vec<u8>>, String>>,
        read_count: usize,
        write_result: Result<(), String>,
        restart_result: Result<(), String>,
        after_restart: Option<Vec<u8>>,
        written: Vec<Vec<u8>>,
        events: Vec<Event>,
        slept: Duration,
    }

    impl FakeOs {
        fn new(version: &str, reads: Vec<Option<Vec<u8>>>) -> Self {
            FakeOs {
                version: Ok(version.into()),
                screens: Ok(ScreenReport {
                    screens: 2,
                    set: 2,
                    already: 0,
                    errors: vec![],
                }),
                reads: reads.into_iter().map(Ok).collect(),
                read_count: 0,
                write_result: Ok(()),
                restart_result: Ok(()),
                after_restart: None,
                written: vec![],
                events: vec![],
                slept: Duration::ZERO,
            }
        }
        fn count(&self, e: Event) -> usize {
            self.events.iter().filter(|x| **x == e).count()
        }
    }

    impl MacWallpaperOs for FakeOs {
        fn product_version(&mut self) -> Result<String, String> {
            self.version.clone()
        }
        fn set_on_every_screen(&mut self, _: &str) -> Result<ScreenReport, String> {
            self.events.push(Event::Set);
            self.screens.clone()
        }
        fn read_store(&mut self) -> Result<Option<Vec<u8>>, String> {
            self.events.push(Event::Read);
            if self.write_result.is_ok() {
                if let Some(last) = self.written.last() {
                    let restarted = self.count(Event::Restart) > 0;
                    return Ok(Some(match (&self.after_restart, restarted) {
                        (Some(state), true) => state.clone(),
                        _ => last.clone(),
                    }));
                }
            }
            let i = self.read_count.min(self.reads.len() - 1);
            self.read_count += 1;
            self.reads[i].clone()
        }
        fn write_store(&mut self, bytes: &[u8]) -> Result<(), String> {
            self.events.push(Event::Write);
            self.written.push(bytes.to_vec());
            self.write_result.clone()
        }
        fn restart_wallpaper_agent(&mut self) -> Result<(), String> {
            self.events.push(Event::Restart);
            self.restart_result.clone()
        }
        fn sleep(&mut self, d: Duration) {
            self.slept += d;
        }
    }

    fn desktop(path: &str, last_set: &str) -> Value {
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
        let mut d = Dictionary::new();
        d.insert("Content".into(), Value::Dictionary(content));
        d.insert("LastSet".into(), Value::String(last_set.into()));
        Value::Dictionary(d)
    }

    fn entry(path: &str, last_set: &str) -> Value {
        let mut e = Dictionary::new();
        e.insert("Desktop".into(), desktop(path, last_set));
        Value::Dictionary(e)
    }

    /// Per-Space store: S1 (current) shows `current`; S2 shows `other`.
    fn store(current: (&str, &str), other: &str) -> Vec<u8> {
        let mut s1 = Dictionary::new();
        s1.insert("Default".into(), entry(current.0, current.1));
        let mut s2 = Dictionary::new();
        s2.insert("Default".into(), entry(other, "t0"));
        let mut spaces = Dictionary::new();
        spaces.insert("S1".into(), Value::Dictionary(s1));
        spaces.insert("S2".into(), Value::Dictionary(s2));
        let mut root = Dictionary::new();
        root.insert("AllSpacesAndDisplays".into(), entry("/old.jpg", "t0"));
        root.insert("Spaces".into(), Value::Dictionary(spaces));
        let mut out = Vec::new();
        Value::Dictionary(root).to_writer_binary(&mut out).unwrap();
        out
    }

    fn notice(os: &mut FakeOs) -> String {
        set_wallpaper(os, IMG).unwrap().notice.unwrap_or_default()
    }

    #[test]
    fn parses_versions() {
        assert_eq!(parse_major("14.6.1\n"), Some(14));
        assert_eq!(parse_major("26"), Some(26));
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
                already: 0,
                errors: vec!["denied".into()]
            })
        );
        assert!(parse_screen_report("").is_err());
        assert!(parse_screen_report("execution error: -1743").is_err());
        assert!(parse_screen_report("{\"screens\":1,\"set\":3}").is_err());
        assert!(parse_screen_report("{\"screens\":2,\"set\":1,\"already\":2}").is_err());
    }

    #[test]
    fn sonoma_waits_for_the_macos_save_then_returns_to_all_spaces_mode() {
        let before = store(("/old.jpg", "t0"), "/old.jpg");
        let saved = store((IMG, "t1"), "/old.jpg");
        let mut os = FakeOs::new(
            "14.6.1",
            vec![Some(before.clone()), Some(before), Some(saved)],
        );

        assert_eq!(notice(&mut os), "");
        assert_eq!(
            os.events[..2],
            [Event::Read, Event::Set],
            "snapshot precedes the change"
        );
        assert_eq!((os.count(Event::Write), os.count(Event::Restart)), (1, 1));
        assert!(macos_store::shows_everywhere(&os.written[0], IMG));
        assert!(os.slept >= STORE_POLL_INTERVAL * 2 + VERIFY_DELAY);
    }

    #[test]
    fn the_image_already_shown_on_another_space_does_not_end_the_wait_early() {
        // S2 already showed IMG; macOS never saves the current Space's change.
        let before = store(("/old.jpg", "t0"), IMG);
        let mut os = FakeOs::new("14.0", vec![Some(before)]);
        let notice = notice(&mut os);

        assert!(
            notice.contains("did not save the change in time"),
            "{notice}"
        );
        assert_eq!(os.count(Event::Write), 0, "nothing written on timeout");
        assert_eq!(os.count(Event::Restart), 0);
        assert_eq!(
            os.slept,
            STORE_POLL_INTERVAL * STORE_POLL_ATTEMPTS,
            "bounded wait"
        );
    }

    #[test]
    fn repeat_set_of_the_image_already_on_every_display_uses_the_existing_entry() {
        let current = store((IMG, "t0"), "/old.jpg");
        let mut os = FakeOs::new("15.1", vec![Some(current)]);
        os.screens = Ok(ScreenReport {
            screens: 2,
            set: 2,
            already: 2,
            errors: vec![],
        });
        assert_eq!(notice(&mut os), "");
        assert!(macos_store::shows_everywhere(&os.written[0], IMG));
        assert_eq!(
            os.slept, VERIFY_DELAY,
            "no wait for a save that will never come"
        );
    }

    #[test]
    fn a_reload_that_restores_per_space_wallpapers_is_reported_truthfully() {
        let before = store(("/old.jpg", "t0"), "/old.jpg");
        let saved = store((IMG, "t1"), "/old.jpg");
        let mut os = FakeOs::new("14.0", vec![Some(before), Some(saved.clone())]);
        os.after_restart = Some(saved);
        let notice = notice(&mut os);
        assert!(notice.contains("kept its per-Space wallpapers"), "{notice}");
        assert_eq!(os.count(Event::Write), 1);
    }

    #[test]
    fn a_failed_display_means_the_store_is_not_rewritten() {
        let before = store(("/old.jpg", "t0"), "/old.jpg");
        let mut os = FakeOs::new("14.0", vec![Some(before)]);
        os.screens = Ok(ScreenReport {
            screens: 3,
            set: 2,
            already: 0,
            errors: vec!["display busy".into()],
        });
        let notice = notice(&mut os);
        assert!(
            notice.starts_with("Wallpaper set on 2 of 3 displays (display busy)."),
            "{notice}"
        );
        assert!(
            notice.contains("a display could not be changed"),
            "{notice}"
        );
        assert_eq!(os.count(Event::Write), 0);
    }

    #[test]
    fn ventura_reports_only_the_current_space_and_never_reads_the_store() {
        let mut os = FakeOs::new("13.6", vec![None]);
        let notice = notice(&mut os);
        assert!(notice.contains("macOS 13"), "{notice}");
        assert_eq!(os.events, [Event::Set]);
    }

    #[test]
    fn unknown_version_is_treated_as_unsupported() {
        let mut os = FakeOs::new("", vec![None]);
        os.version = Err("sw_vers missing".into());
        assert!(notice(&mut os).contains("could not be determined"));
        assert_eq!(os.events, [Event::Set]);
    }

    #[test]
    fn unrecognised_missing_or_unreadable_stores_are_reported_and_never_written() {
        // macOS saved a fresh entry, but `Displays` is not a dictionary.
        let mut spaces = Dictionary::new();
        spaces.insert(
            "S".into(),
            Value::Dictionary(Dictionary::from_iter([(
                "Default".to_string(),
                entry(IMG, "t1"),
            )])),
        );
        let mut root = Dictionary::new();
        root.insert("AllSpacesAndDisplays".into(), entry("/old.jpg", "t0"));
        root.insert("Spaces".into(), Value::Dictionary(spaces));
        root.insert("Displays".into(), Value::Array(vec![]));
        let mut odd = Vec::new();
        Value::Dictionary(root).to_writer_binary(&mut odd).unwrap();
        let mut os = FakeOs::new("14.0", vec![None, Some(odd)]);
        let n = notice(&mut os);
        assert!(n.contains("layout this version does not recognise"), "{n}");
        assert_eq!(os.count(Event::Write), 0);

        let mut os = FakeOs::new("14.0", vec![None]);
        assert!(notice(&mut os).contains("not found"));
        let mut os = FakeOs::new("14.0", vec![None]);
        os.reads = vec![Err("permission denied".into())];
        assert!(notice(&mut os).contains("permission denied"));
        assert_eq!(os.count(Event::Write), 0);
    }

    #[test]
    fn write_and_restart_failures_are_reported() {
        let before = store(("/old.jpg", "t0"), "/old.jpg");
        let saved = store((IMG, "t1"), "/old.jpg");
        let mut os = FakeOs::new("14.0", vec![Some(before.clone()), Some(saved.clone())]);
        os.write_result = Err("it is a symbolic link".into());
        let n = notice(&mut os);
        assert!(
            n.contains("was not modified (it is a symbolic link)"),
            "{n}"
        );
        assert_eq!(os.count(Event::Restart), 0);

        let mut os = FakeOs::new("14.0", vec![Some(before), Some(saved)]);
        os.restart_result = Err("No matching processes".into());
        assert!(notice(&mut os).contains("after the next login"));
    }

    #[test]
    fn no_display_changed_is_an_error() {
        let mut os = FakeOs::new("14.0", vec![None]);
        os.screens = Ok(ScreenReport {
            screens: 2,
            set: 0,
            already: 0,
            errors: vec!["not permitted".into()],
        });
        let err = set_wallpaper(&mut os, IMG).unwrap_err().to_string();
        assert!(err.contains("not permitted"), "{err}");
        assert_eq!(os.count(Event::Write), 0);

        os.screens = Err("osascript: execution error".into());
        assert!(set_wallpaper(&mut os, IMG).is_err());
    }

    #[test]
    fn summary_is_silent_only_for_complete_success() {
        let all = ScreenReport {
            screens: 2,
            set: 2,
            already: 0,
            errors: vec![],
        };
        assert_eq!(summarize(&all, &OtherSpaces::Changed), None);
        assert!(summarize(&all, &OtherSpaces::Unsupported { major: Some(13) }).is_some());
        assert!(summarize(&all, &not_changed("x")).is_some());
    }

    #[test]
    fn atomic_replace_writes_the_bytes_and_leaves_no_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("Index.plist");
        std::fs::write(&path, b"old").unwrap();
        replace_file_atomically(&path, b"new").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"new");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn atomic_replace_refuses_a_missing_store() {
        let dir = tempfile::tempdir().unwrap();
        assert!(replace_file_atomically(&dir.path().join("Index.plist"), b"x").is_err());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn atomic_replace_preserves_the_original_mode() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("Index.plist");
        std::fs::write(&path, b"old").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o640)).unwrap();
        replace_file_atomically(&path, b"new").unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o640);
    }

    #[cfg(unix)]
    #[test]
    fn atomic_replace_refuses_a_symlinked_store_and_leaves_its_target_alone() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("real.plist");
        let link = dir.path().join("Index.plist");
        std::fs::write(&target, b"old").unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let err = replace_file_atomically(&link, b"new").unwrap_err();
        assert!(err.contains("symbolic link"), "{err}");
        assert_eq!(std::fs::read(&target).unwrap(), b"old");
        assert!(std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 2);
    }
}

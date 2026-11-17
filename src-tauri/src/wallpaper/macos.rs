//! macOS "Set as Wallpaper" for every display and, on macOS 14+, every
//! Space (#1441, #1731).
//!
//! 1. Snapshot the private wallpaper store, then call
//!    `NSWorkspace.setDesktopImageURL(_:for:options:)` once per `NSScreen`
//!    (objc2, queued on the main thread: 10 s to start, 20 s more to
//!    finish once started). This changes
//!    every display, but only on the current Space. Each display's result
//!    is typed ([`ScreenResult`]), never parsed from script output.
//! 2. macOS 14+: wait until WallpaperAgent has persisted that change (an
//!    entry for the image that differs from the snapshot), so its save
//!    cannot later clobber ours. Then return the store to all-Spaces mode
//!    around macOS's own entry (`macos_store`), replace it atomically,
//!    reload WallpaperAgent and re-read the store to confirm the change
//!    survived the reload (macOS 26 may re-expand it per display and Space,
//!    which also counts).
//! 3. Anything not done is a [`Partial`]: a short `user` notice for the
//!    toast and a `detail` for the log. On timeout, an unrecognised store, a
//!    failed display, or a symlinked store, nothing is written.
//!
//! macOS 13 and earlier keep per-Space choices in the Dock's
//! `desktoppicture.db`, whose schema is undocumented and shared with other
//! preferences, so it is not edited. See
//! `docs/lessons/1441-macos-wallpaper-all-spaces.md` and
//! `docs/lessons/1731-macos-wallpaper-all-spaces.md`.

use super::macos_store::{self, Coverage};
use crate::error::AppError;
use std::time::Duration;

/// First macOS release with the `com.apple.wallpaper` store (Sonoma).
pub const STORE_MIN_MAJOR: u32 = 14;

/// How long to wait for WallpaperAgent to persist the NSWorkspace change.
const STORE_POLL_ATTEMPTS: u32 = 12;
const STORE_POLL_INTERVAL: Duration = Duration::from_millis(250);
/// Time for the restarted agent to load (and possibly re-save) the store.
const VERIFY_DELAY: Duration = Duration::from_millis(1500);

/// Notice when at least one display kept its old wallpaper.
pub const SOME_DISPLAYS: &str = "Could only change wallpaper on some displays";
/// Notice when every display changed but other Spaces did not.
pub const CURRENT_SPACE: &str = "Could only change wallpaper on the current Space";

/// What the per-display step did to one display.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScreenResult {
    /// NSWorkspace accepted the image.
    Changed,
    /// The display already showed the image, so it was left alone: setting
    /// the current image again is a no-op that persists nothing.
    AlreadyShown,
    /// NSWorkspace refused the image, for this reason.
    Failed(String),
}

/// Result of the per-display NSWorkspace step, one entry per `NSScreen`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ScreenReport {
    pub screens: Vec<ScreenResult>,
}

impl ScreenReport {
    /// Displays now showing the image (changed or already showing it).
    pub fn showing(&self) -> usize {
        self.screens
            .iter()
            .filter(|s| !matches!(s, ScreenResult::Failed(_)))
            .count()
    }

    /// Whether every display that shows the image already did, so
    /// NSWorkspace persisted nothing.
    fn none_changed(&self) -> bool {
        !self.screens.contains(&ScreenResult::Changed)
    }

    fn errors(&self) -> impl Iterator<Item = &str> {
        self.screens.iter().filter_map(|s| match s {
            ScreenResult::Failed(e) => Some(e.as_str()),
            _ => None,
        })
    }

    fn describe(&self) -> String {
        let errors: Vec<&str> = self.errors().collect();
        let detail = if errors.is_empty() {
            String::new()
        } else {
            format!(" ({})", errors.join("; "))
        };
        format!(
            "wallpaper set on {} of {} displays{detail}",
            self.showing(),
            self.screens.len()
        )
    }
}

/// What happened to Spaces other than the current one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OtherSpaces {
    /// Every Space shows the image, confirmed after WallpaperAgent
    /// reloaded the store.
    Changed,
    /// This macOS version has no store this code can edit.
    Unsupported { major: Option<u32> },
    /// Not changed, for `reason`.
    NotChanged { reason: String },
}

/// A wallpaper change that was only partly applied: `user` is the toast
/// notice, `detail` says why, for the log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Partial {
    pub user: &'static str,
    pub detail: String,
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

/// The partial result to report, or None when every display and every
/// Space was changed. A failed display outranks the Spaces notice: it is
/// the visible problem, and it is also why the store was left alone.
pub fn partial(screens: &ScreenReport, other_spaces: &OtherSpaces) -> Option<Partial> {
    let spaces = match other_spaces {
        OtherSpaces::Changed => None,
        OtherSpaces::Unsupported { major: Some(major) } => Some(format!(
            "macOS {major} offers no supported way to change other Spaces (macOS {STORE_MIN_MAJOR} or later is needed)"
        )),
        OtherSpaces::Unsupported { major: None } => {
            Some("the macOS version could not be determined".to_string())
        }
        OtherSpaces::NotChanged { reason } => Some(reason.clone()),
    };
    if screens.showing() < screens.screens.len() {
        let detail = match spaces {
            Some(s) => format!("{}; other Spaces unchanged: {s}", screens.describe()),
            None => screens.describe(),
        };
        return Some(Partial {
            user: SOME_DISPLAYS,
            detail,
        });
    }
    spaces.map(|s| Partial {
        user: CURRENT_SPACE,
        detail: format!("other Spaces unchanged: {s}"),
    })
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

/// The entry macOS wrote for the image and the store holding it, or a
/// reason. When every display already showed the image, NSWorkspace
/// persisted nothing, so the store as read is current and its existing
/// entry for the image is macOS's own.
fn await_macos_entry(
    os: &mut impl MacWallpaperOs,
    before: Option<&[u8]>,
    screens: &ScreenReport,
    image_path: &str,
) -> Result<(Vec<u8>, plist::Dictionary), OtherSpaces> {
    if screens.none_changed() {
        let store = read_existing(os)?;
        return macos_store::existing_image_entry(&store, image_path)
            .map(|e| (store, e))
            .ok_or_else(|| not_changed(macos_store::StoreError::UnrecognisedLayout.to_string()));
    }
    // A store that is missing or unreadable at one poll may be mid-save:
    // keep polling, and report the last such reason only if nothing usable
    // ever appeared.
    let mut unusable = None;
    for _ in 0..STORE_POLL_ATTEMPTS {
        os.sleep(STORE_POLL_INTERVAL);
        let store = match read_existing(os) {
            Ok(store) => store,
            Err(reason) => {
                unusable = Some(reason);
                continue;
            }
        };
        unusable = None;
        if let Some(entry) = macos_store::fresh_image_entry(before, &store, image_path) {
            return Ok((store, entry));
        }
    }
    Err(unusable.unwrap_or_else(|| {
        not_changed("macOS did not save the change in time, so other Spaces were left untouched")
    }))
}

fn change_other_spaces(
    os: &mut impl MacWallpaperOs,
    before: Option<&[u8]>,
    screens: &ScreenReport,
    image_path: &str,
) -> OtherSpaces {
    let (store, entry) = match await_macos_entry(os, before, screens, image_path) {
        Ok(found) => found,
        Err(outcome) => return outcome,
    };
    if macos_store::coverage(&store, image_path) == Coverage::AllSpaces {
        return OtherSpaces::Changed;
    }
    let rewritten = match macos_store::all_spaces_store(&store, &entry) {
        Ok(bytes) => bytes,
        Err(e) => {
            log::warn!(
                "wallpaper store left unchanged: {e}; store: {}",
                macos_store::describe(&store)
            );
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
    let after = os.read_store();
    if let Ok(Some(kept)) = &after {
        if macos_store::kept_everywhere(&store, kept, image_path) {
            return OtherSpaces::Changed;
        }
    }
    let kept = match &after {
        Ok(Some(kept)) => macos_store::describe(kept),
        Ok(None) => "no store".to_string(),
        Err(e) => format!("unreadable ({e})"),
    };
    // Something else may own the store too (a theme switcher rewriting it
    // and restarting the agent at the same moment is one unconfirmed
    // suspect): keep enough to tell who won.
    log::warn!(
        "wallpaper: WallpaperAgent did not keep the all-Spaces change. Before rewrite: {}. Written: {}. Agent kept: {kept}.",
        macos_store::describe(&store),
        macos_store::describe(&rewritten),
    );
    match after {
        Ok(_) => not_changed("macOS kept its per-Space wallpapers after reloading"),
        Err(e) => not_changed(format!(
            "the wallpaper store could not be re-read to confirm the change ({e})"
        )),
    }
}

/// Set `image_path` (absolute, canonical) on every display and, where the
/// running macOS allows, every Space. `Ok(None)` means everything changed.
pub fn set_wallpaper(
    os: &mut impl MacWallpaperOs,
    image_path: &str,
) -> Result<Option<Partial>, AppError> {
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
    if screens.showing() == 0 {
        let reason = screens
            .errors()
            .next()
            .map(str::to_string)
            .unwrap_or_else(|| "no display accepted the image".into());
        return Err(AppError::Other(format!(
            "Failed to set wallpaper: {reason}"
        )));
    }

    let other_spaces = match before {
        None => OtherSpaces::Unsupported { major },
        Some(_) if screens.showing() < screens.screens.len() => {
            not_changed("other Spaces were left untouched because a display could not be changed")
        }
        Some(Err(e)) => not_changed(format!("the wallpaper store could not be read ({e})")),
        Some(Ok(before)) => change_other_spaces(os, before.as_deref(), &screens, image_path),
    };
    Ok(partial(&screens, &other_spaces))
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
pub fn set_wallpaper_system(image_path: &str) -> Result<Option<Partial>, AppError> {
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

/// The per-display step through AppKit. NSScreen and the desktop-image
/// calls belong on the main thread, so the work is queued on the main
/// dispatch queue and awaited from this (blocking-pool) thread through
/// `bounded::hand_off`: it must start within 10 s (or is abandoned, having
/// changed nothing), and once started its result is awaited up to 20 s
/// more. Called on the main thread itself, it runs inline rather than
/// waiting on its own queue. AppKit may block the main thread inside
/// `setDesktopImageURL`; nothing here can bound that.
#[cfg(target_os = "macos")]
mod appkit {
    use super::{macos_store, ScreenReport, ScreenResult};
    use crate::wallpaper::bounded::{hand_off, HandOffError};
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSScreen, NSWorkspace};
    use objc2_foundation::{NSString, NSURL};
    use std::time::Duration;

    /// The main thread must start the work within this, or it is abandoned
    /// (and does nothing if reached later): nothing changed.
    const START_WITHIN: Duration = Duration::from_secs(10);
    /// Once started, the work is taking effect, so its result is awaited
    /// this much longer rather than reported as a failure.
    const THEN_GRACE: Duration = Duration::from_secs(20);

    fn standardized_path(url: &NSURL) -> Option<String> {
        Some(url.URLByStandardizingPath()?.path()?.to_string())
    }

    fn set_every_screen(mtm: MainThreadMarker, image_path: &str) -> ScreenReport {
        let url = NSURL::fileURLWithPath(&NSString::from_str(image_path));
        let target = standardized_path(&url);
        let workspace = NSWorkspace::sharedWorkspace();
        let screens = NSScreen::screens(mtm)
            .to_vec()
            .iter()
            .enumerate()
            .map(|(i, screen)| {
                let current = workspace
                    .desktopImageURLForScreen(screen)
                    .and_then(|u| standardized_path(&u));
                if let (Some(current), Some(target)) = (&current, &target) {
                    if macos_store::normalize_path(current) == macos_store::normalize_path(target) {
                        return ScreenResult::AlreadyShown;
                    }
                }
                // Keep the display's own scaling and fill colour.
                let options = workspace
                    .desktopImageOptionsForScreen(screen)
                    .unwrap_or_default();
                // SAFETY: `options` is the dictionary AppKit returned for
                // this screen (or an empty one), so its keys are
                // NSWorkspaceDesktopImageOptionKey and its values objects.
                match unsafe {
                    workspace.setDesktopImageURL_forScreen_options_error(&url, screen, &options)
                } {
                    Ok(()) => ScreenResult::Changed,
                    Err(e) => ScreenResult::Failed(format!(
                        "display {}: {}",
                        i + 1,
                        e.localizedDescription()
                    )),
                }
            })
            .collect();
        ScreenReport { screens }
    }

    pub fn set_on_every_screen(image_path: &str) -> Result<ScreenReport, String> {
        if let Some(mtm) = MainThreadMarker::new() {
            return Ok(set_every_screen(mtm, image_path));
        }
        let path = image_path.to_owned();
        let report = hand_off(
            |job| dispatch2::DispatchQueue::main().exec_async(job),
            move || match MainThreadMarker::new() {
                Some(mtm) => Ok(set_every_screen(mtm, &path)),
                None => Err("the main queue ran off the main thread".to_string()),
            },
            START_WITHIN,
            THEN_GRACE,
        );
        match report {
            Ok(report) => report,
            Err(HandOffError::NotStarted) => {
                Err("the main thread was busy for 10 s, so no display was changed".into())
            }
            Err(HandOffError::StillRunning) => {
                Err("the displays did not respond within 30 s; some may still change".into())
            }
            Err(HandOffError::Lost) => Err("the display step ended without a result".into()),
        }
    }
}

/// Short system commands: none should take more than a few seconds, and
/// the flow holds its mutex while they run, so each is killed at its bound.
#[cfg(target_os = "macos")]
const COMMAND_TIMEOUT: Duration = Duration::from_secs(10);

#[cfg(target_os = "macos")]
fn run(program: &str, args: &[&str]) -> Result<String, String> {
    super::bounded::run_command(program, args, COMMAND_TIMEOUT)
}

#[cfg(target_os = "macos")]
impl MacWallpaperOs for SystemMacOs {
    fn product_version(&mut self) -> Result<String, String> {
        run("sw_vers", &["-productVersion"]).map(|v| v.trim().to_string())
    }

    fn set_on_every_screen(&mut self, image_path: &str) -> Result<ScreenReport, String> {
        appkit::set_on_every_screen(image_path)
    }

    fn read_store(&mut self) -> Result<Option<Vec<u8>>, String> {
        use std::io::Read;
        let file = match std::fs::File::open(store_path()?) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.to_string()),
        };
        // Never read more than the parser would accept.
        let limit = macos_store::MAX_STORE_BYTES as u64;
        let mut bytes = Vec::new();
        file.take(limit + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() as u64 > limit {
            return Err(format!("it is larger than {} MiB", limit >> 20));
        }
        Ok(Some(bytes))
    }

    fn write_store(&mut self, bytes: &[u8]) -> Result<(), String> {
        replace_file_atomically(&store_path()?, bytes)
    }

    fn restart_wallpaper_agent(&mut self) -> Result<(), String> {
        // SAFETY: getuid has no preconditions and cannot fail.
        let uid = unsafe { libc::getuid() };
        let target = format!("gui/{uid}/com.apple.wallpaper.agent");
        // With SIP enabled (the default) launchd refuses to kickstart this
        // system agent; killing it makes launchd start it again instead.
        run("launchctl", &["kickstart", "-k", &target])
            .or_else(|e| {
                log::info!("launchctl kickstart refused ({e}); using killall WallpaperAgent");
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

    fn report(results: &[ScreenResult]) -> ScreenReport {
        ScreenReport {
            screens: results.to_vec(),
        }
    }

    fn failed(e: &str) -> ScreenResult {
        ScreenResult::Failed(e.into())
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
                screens: Ok(report(&[ScreenResult::Changed, ScreenResult::Changed])),
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

    fn file_url(path: &str) -> Value {
        Value::String(format!("file://{}", path.replace(' ', "%20")))
    }

    /// A still-image desktop; `tahoe` puts the URL in `Configuration`
    /// (macOS 26) instead of `Files` (macOS 14/15).
    fn desktop(path: &str, last_set: &str, tahoe: bool) -> Value {
        let mut choice = Dictionary::new();
        if tahoe {
            let mut url = Dictionary::new();
            url.insert("relative".into(), file_url(path));
            let mut config = Dictionary::new();
            config.insert("url".into(), Value::Dictionary(url));
            let mut bytes = Vec::new();
            Value::Dictionary(config)
                .to_writer_binary(&mut bytes)
                .unwrap();
            choice.insert("Configuration".into(), Value::Data(bytes));
            choice.insert("Files".into(), Value::Array(vec![]));
        } else {
            let mut file = Dictionary::new();
            file.insert("relative".into(), file_url(path));
            choice.insert("Configuration".into(), Value::Data(vec![1, 2, 3]));
            choice.insert("Files".into(), Value::Array(vec![Value::Dictionary(file)]));
        }
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

    fn entry(path: &str, last_set: &str, tahoe: bool) -> Value {
        let mut e = Dictionary::new();
        e.insert("Desktop".into(), desktop(path, last_set, tahoe));
        Value::Dictionary(e)
    }

    fn encode(root: Dictionary) -> Vec<u8> {
        let mut out = Vec::new();
        Value::Dictionary(root).to_writer_binary(&mut out).unwrap();
        out
    }

    /// Per-Space store: S1 (current) shows `current`; S2 shows `other`.
    fn store_with(current: (&str, &str), other: &str, tahoe: bool) -> Vec<u8> {
        let mut s1 = Dictionary::new();
        s1.insert("Default".into(), entry(current.0, current.1, tahoe));
        let mut s2 = Dictionary::new();
        s2.insert("Default".into(), entry(other, "t0", tahoe));
        let mut spaces = Dictionary::new();
        spaces.insert("S1".into(), Value::Dictionary(s1));
        spaces.insert("S2".into(), Value::Dictionary(s2));
        let mut root = Dictionary::new();
        root.insert(
            "AllSpacesAndDisplays".into(),
            entry("/old.jpg", "t0", tahoe),
        );
        root.insert("Spaces".into(), Value::Dictionary(spaces));
        encode(root)
    }

    fn store(current: (&str, &str), other: &str) -> Vec<u8> {
        store_with(current, other, false)
    }

    /// macOS 26 after reloading all-Spaces mode: no all-Spaces desktop, one
    /// entry per display and Space, each showing `shows`.
    fn tahoe_reloaded(shows: [&str; 2]) -> Vec<u8> {
        let mut spaces = Dictionary::new();
        for (i, path) in shows.iter().enumerate() {
            let mut displays = Dictionary::new();
            displays.insert("A".into(), entry(path, "t3", true));
            let mut space = Dictionary::new();
            space.insert("Displays".into(), Value::Dictionary(displays));
            // Same Space ids as `store_with`.
            spaces.insert(format!("S{}", i + 1), Value::Dictionary(space));
        }
        let mut root = Dictionary::new();
        root.insert(
            "AllSpacesAndDisplays".into(),
            Value::Dictionary(Dictionary::new()),
        );
        root.insert("Spaces".into(), Value::Dictionary(spaces));
        encode(root)
    }

    fn outcome(os: &mut FakeOs) -> Option<Partial> {
        set_wallpaper(os, IMG).unwrap()
    }

    fn detail(os: &mut FakeOs) -> String {
        outcome(os).map(|p| p.detail).unwrap_or_default()
    }

    #[test]
    fn parses_versions() {
        assert_eq!(parse_major("14.6.1\n"), Some(14));
        assert_eq!(parse_major("26"), Some(26));
        assert_eq!(parse_major(""), None);
        assert_eq!(parse_major("Sonoma"), None);
    }

    #[test]
    fn the_notice_names_what_was_left_unchanged() {
        let all = report(&[ScreenResult::Changed, ScreenResult::AlreadyShown]);
        let one_failed = report(&[ScreenResult::Changed, failed("display 2: busy")]);
        let spaces = not_changed("macOS kept its per-Space wallpapers after reloading");

        assert_eq!(partial(&all, &OtherSpaces::Changed), None);

        let p = partial(&all, &spaces).unwrap();
        assert_eq!(p.user, "Could only change wallpaper on the current Space");
        assert!(p.detail.contains("per-Space wallpapers"), "{}", p.detail);
        for unsupported in [Some(13), None] {
            let p = partial(&all, &OtherSpaces::Unsupported { major: unsupported }).unwrap();
            assert_eq!(p.user, CURRENT_SPACE);
        }

        // A display that kept its old picture is named, whatever the Spaces did.
        for other in [OtherSpaces::Changed, spaces] {
            let p = partial(&one_failed, &other).unwrap();
            assert_eq!(p.user, "Could only change wallpaper on some displays");
            assert!(
                p.detail
                    .starts_with("wallpaper set on 1 of 2 displays (display 2: busy)"),
                "{}",
                p.detail
            );
        }
    }

    #[test]
    fn sonoma_waits_for_the_macos_save_then_returns_to_all_spaces_mode() {
        let before = store(("/old.jpg", "t0"), "/old.jpg");
        let saved = store((IMG, "t1"), "/old.jpg");
        let mut os = FakeOs::new(
            "14.6.1",
            vec![Some(before.clone()), Some(before), Some(saved)],
        );

        assert_eq!(outcome(&mut os), None);
        assert_eq!(
            os.events[..2],
            [Event::Read, Event::Set],
            "snapshot precedes the change"
        );
        assert_eq!((os.count(Event::Write), os.count(Event::Restart)), (1, 1));
        assert_eq!(
            macos_store::coverage(&os.written[0], IMG),
            Coverage::AllSpaces
        );
        assert!(os.slept >= STORE_POLL_INTERVAL * 2 + VERIFY_DELAY);
    }

    #[test]
    fn tahoe_reads_the_image_from_the_configuration_and_accepts_the_reloaded_form() {
        let before = store_with(("/old.jpg", "t0"), "/old.jpg", true);
        let saved = store_with((IMG, "t1"), "/old.jpg", true);
        let mut os = FakeOs::new("26.1", vec![Some(before), Some(saved)]);
        // After the reload the agent re-expands the store per display and
        // Space, with no all-Spaces desktop, every entry showing the image.
        os.after_restart = Some(tahoe_reloaded([IMG, IMG]));

        assert_eq!(outcome(&mut os), None);
        assert_eq!((os.count(Event::Write), os.count(Event::Restart)), (1, 1));
        assert_eq!(
            macos_store::coverage(&os.written[0], IMG),
            Coverage::AllSpaces
        );
    }

    #[test]
    fn tahoe_reloaded_form_with_an_old_entry_is_not_success() {
        let before = store_with(("/old.jpg", "t0"), "/old.jpg", true);
        let saved = store_with((IMG, "t1"), "/old.jpg", true);
        let mut os = FakeOs::new("26.0", vec![Some(before), Some(saved)]);
        os.after_restart = Some(tahoe_reloaded([IMG, "/old.jpg"]));
        let p = outcome(&mut os).unwrap();
        assert_eq!(p.user, CURRENT_SPACE);
        assert!(
            p.detail.contains("kept its per-Space wallpapers"),
            "{}",
            p.detail
        );
    }

    #[test]
    fn the_image_already_shown_on_another_space_does_not_end_the_wait_early() {
        // S2 already showed IMG; macOS never saves the current Space's change.
        let before = store(("/old.jpg", "t0"), IMG);
        let mut os = FakeOs::new("14.0", vec![Some(before)]);
        let p = outcome(&mut os).unwrap();

        assert_eq!(p.user, CURRENT_SPACE);
        assert!(
            p.detail.contains("did not save the change in time"),
            "{}",
            p.detail
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
        os.screens = Ok(report(&[
            ScreenResult::AlreadyShown,
            ScreenResult::AlreadyShown,
        ]));
        assert_eq!(outcome(&mut os), None);
        assert_eq!(
            macos_store::coverage(&os.written[0], IMG),
            Coverage::AllSpaces
        );
        assert_eq!(
            os.slept, VERIFY_DELAY,
            "no wait for a save that will never come"
        );
    }

    #[test]
    fn a_store_already_in_all_spaces_mode_is_not_rewritten() {
        let mut root = Dictionary::new();
        root.insert("AllSpacesAndDisplays".into(), entry(IMG, "t0", false));
        let done = encode(root);
        let mut os = FakeOs::new("14.2", vec![Some(done)]);
        os.screens = Ok(report(&[ScreenResult::AlreadyShown]));
        assert_eq!(outcome(&mut os), None);
        assert_eq!(os.count(Event::Write), 0);
        assert_eq!(os.count(Event::Restart), 0);
    }

    #[test]
    fn a_reload_that_restores_per_space_wallpapers_is_reported_truthfully() {
        let before = store(("/old.jpg", "t0"), "/old.jpg");
        let saved = store((IMG, "t1"), "/old.jpg");
        let mut os = FakeOs::new("14.0", vec![Some(before), Some(saved.clone())]);
        os.after_restart = Some(saved);
        let p = outcome(&mut os).unwrap();
        assert_eq!(p.user, CURRENT_SPACE);
        assert!(
            p.detail.contains("kept its per-Space wallpapers"),
            "{}",
            p.detail
        );
        assert_eq!(os.count(Event::Write), 1);
    }

    #[test]
    fn a_store_missing_or_unreadable_at_the_first_polls_is_polled_again() {
        let before = store(("/old.jpg", "t0"), "/old.jpg");
        let saved = store((IMG, "t1"), "/old.jpg");
        let mut os = FakeOs::new("14.0", vec![]);
        os.reads = vec![
            Ok(Some(before)),
            Ok(None),
            Err("busy".into()),
            Ok(Some(saved)),
        ];
        assert_eq!(outcome(&mut os), None);
        assert_eq!(os.count(Event::Write), 1);

        // Never usable: the last reason is reported after the full wait.
        let mut os = FakeOs::new("14.0", vec![None]);
        let p = outcome(&mut os).unwrap();
        assert!(p.detail.contains("not found"), "{}", p.detail);
        assert_eq!(os.slept, STORE_POLL_INTERVAL * STORE_POLL_ATTEMPTS);
    }

    #[test]
    fn a_reload_that_loses_a_space_is_not_reported_as_complete() {
        let before = store_with(("/old.jpg", "t0"), "/old.jpg", true);
        let saved = store_with((IMG, "t1"), "/old.jpg", true);
        let mut os = FakeOs::new("26.1", vec![Some(before), Some(saved)]);
        // The agent kept only the current Space (S1); S2 is gone.
        let mut root = Dictionary::new();
        let mut displays = Dictionary::new();
        displays.insert("A".into(), entry(IMG, "t3", true));
        let mut s1 = Dictionary::new();
        s1.insert("Displays".into(), Value::Dictionary(displays));
        let mut spaces = Dictionary::new();
        spaces.insert("S1".into(), Value::Dictionary(s1));
        root.insert("Spaces".into(), Value::Dictionary(spaces));
        os.after_restart = Some(encode(root));
        assert_eq!(outcome(&mut os).unwrap().user, CURRENT_SPACE);
    }

    #[test]
    fn a_failed_display_means_the_store_is_not_rewritten() {
        let before = store(("/old.jpg", "t0"), "/old.jpg");
        let mut os = FakeOs::new("14.0", vec![Some(before)]);
        os.screens = Ok(report(&[
            ScreenResult::Changed,
            ScreenResult::AlreadyShown,
            failed("display 3: busy"),
        ]));
        let p = outcome(&mut os).unwrap();
        assert_eq!(p.user, SOME_DISPLAYS);
        assert!(
            p.detail
                .starts_with("wallpaper set on 2 of 3 displays (display 3: busy)"),
            "{}",
            p.detail
        );
        assert!(
            p.detail.contains("a display could not be changed"),
            "{}",
            p.detail
        );
        assert_eq!(os.count(Event::Write), 0);
    }

    #[test]
    fn ventura_reports_only_the_current_space_and_never_reads_the_store() {
        let mut os = FakeOs::new("13.6", vec![None]);
        let p = outcome(&mut os).unwrap();
        assert_eq!(p.user, CURRENT_SPACE);
        assert!(p.detail.contains("macOS 13"), "{}", p.detail);
        assert_eq!(os.events, [Event::Set]);
    }

    #[test]
    fn unknown_version_is_treated_as_unsupported() {
        let mut os = FakeOs::new("", vec![None]);
        os.version = Err("sw_vers missing".into());
        assert!(detail(&mut os).contains("could not be determined"));
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
                entry(IMG, "t1", false),
            )])),
        );
        let mut root = Dictionary::new();
        root.insert(
            "AllSpacesAndDisplays".into(),
            entry("/old.jpg", "t0", false),
        );
        root.insert("Spaces".into(), Value::Dictionary(spaces));
        root.insert("Displays".into(), Value::Array(vec![]));
        let odd = encode(root);
        let mut os = FakeOs::new("14.0", vec![None, Some(odd)]);
        let d = detail(&mut os);
        assert!(d.contains("layout this version does not recognise"), "{d}");
        assert_eq!(os.count(Event::Write), 0);

        let mut os = FakeOs::new("14.0", vec![None]);
        assert!(detail(&mut os).contains("not found"));
        let mut os = FakeOs::new("14.0", vec![None]);
        os.reads = vec![Err("permission denied".into())];
        let p = outcome(&mut os).unwrap();
        assert_eq!(p.user, CURRENT_SPACE);
        assert!(p.detail.contains("permission denied"));
        assert_eq!(os.count(Event::Write), 0);

        // Malformed store bytes: never written.
        let mut os = FakeOs::new("26.0", vec![Some(b"bplist00\x01".to_vec())]);
        assert_eq!(outcome(&mut os).unwrap().user, CURRENT_SPACE);
        assert_eq!(os.count(Event::Write), 0);
    }

    #[test]
    fn write_and_restart_failures_are_reported() {
        let before = store(("/old.jpg", "t0"), "/old.jpg");
        let saved = store((IMG, "t1"), "/old.jpg");
        let mut os = FakeOs::new("14.0", vec![Some(before.clone()), Some(saved.clone())]);
        os.write_result = Err("it is a symbolic link".into());
        let d = detail(&mut os);
        assert!(
            d.contains("was not modified (it is a symbolic link)"),
            "{d}"
        );
        assert_eq!(os.count(Event::Restart), 0);

        let mut os = FakeOs::new("14.0", vec![Some(before), Some(saved)]);
        os.restart_result = Err("No matching processes".into());
        assert!(detail(&mut os).contains("after the next login"));
    }

    #[test]
    fn no_display_changed_is_an_error() {
        let mut os = FakeOs::new("14.0", vec![None]);
        os.screens = Ok(report(&[failed("not permitted"), failed("not permitted")]));
        let err = set_wallpaper(&mut os, IMG).unwrap_err().to_string();
        assert!(err.contains("not permitted"), "{err}");
        assert_eq!(os.count(Event::Write), 0);

        // No display at all, and a step that never reported.
        os.screens = Ok(report(&[]));
        assert!(set_wallpaper(&mut os, IMG)
            .unwrap_err()
            .to_string()
            .contains("no display accepted"));
        os.screens = Err("the main thread was busy for 10 s".into());
        assert!(set_wallpaper(&mut os, IMG).is_err());
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

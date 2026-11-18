//! Pure logic for the private macOS 14+ wallpaper store (#1441, #1731).
//!
//! `~/Library/Application Support/com.apple.wallpaper/Store/Index.plist`
//! records the wallpaper for "all Spaces and displays"
//! (`AllSpacesAndDisplays`), per display (`Displays`) and per Space
//! (`Spaces`). Public API (`NSWorkspace.setDesktopImageURL`) only changes the
//! current Space, and doing so splits the store into per-Space entries
//! ("Show on all Spaces" off).
//!
//! Following the tested reference (pnitijarasrat/dotfile#102), the store is
//! returned to all-Spaces mode: `AllSpacesAndDisplays.Desktop.Content` takes
//! the entry macOS itself just wrote for the new image, and every per-Space
//! and per-display `Desktop` override is removed. Their `Idle` (screen
//! saver) settings stay; an override left with no `Idle` is removed whole.
//! Nothing else (`SystemDefault`, the all-Spaces `Idle`, `Type`, dates,
//! unknown keys) is touched, no `Configuration` blob is ever fabricated,
//! and a store whose shape is not recognised is never written.
//!
//! Parsing is bounded before it starts (`plist_bounds`): size, expanded
//! value count and depth, so a corrupt or hostile store or `Configuration`
//! cannot cost exponential time or overflow the stack.
//!
//! Two layouts are understood:
//! - macOS 14/15: an image choice names its file in `Files[0].relative`.
//! - macOS 26 (Tahoe): `Files` is empty and the URL lives inside the
//!   choice's `Configuration`, a nested property list. After a reload the
//!   agent may also re-expand all-Spaces mode into one entry per display and
//!   Space with no `AllSpacesAndDisplays.Desktop` ([`Coverage`]).
//!
//! Everything here is pure, so it is tested on every host. See
//! `docs/lessons/1441-macos-wallpaper-all-spaces.md` and
//! `docs/lessons/1731-macos-wallpaper-all-spaces.md`.

use super::plist_bounds::{self, Limits};
use plist::{Dictionary, Value};
use std::collections::BTreeSet;

/// `Provider` of a still-image choice.
pub const IMAGE_PROVIDER: &str = "com.apple.wallpaper.choice.image";

const ALL: &str = "AllSpacesAndDisplays";
/// Sections that hold per-display / per-Space overrides of `ALL`.
const OVERRIDE_SECTIONS: &[&str] = &["Displays", "Spaces"];

/// `Spaces` nests `<space>` → `Displays` → `<display>`; a little headroom
/// beyond that, but never an unbounded walk of an unknown structure.
const MAX_DEPTH: usize = 5;

/// Largest store this code reads or parses. Real stores are tens of KiB.
pub const MAX_STORE_BYTES: usize = 16 * 1024 * 1024;

/// Parse bounds for the store itself.
const STORE_LIMITS: Limits = Limits {
    max_bytes: MAX_STORE_BYTES,
    max_nodes: 1_000_000,
    max_depth: 64,
};

/// More desktop entries than any real display × Space count: beyond this
/// the store is not one this code recognises.
const MAX_DESKTOPS: usize = 2048;

/// Bounds for reading a choice's nested `Configuration` plist. macOS writes
/// a few hundred bytes; anything far larger, deeper or wider is not a
/// configuration this code understands and is ignored (fail-safe: the
/// choice is then not recognised as showing any image). Checked before
/// parsing, so their cost is bounded per choice.
const MAX_CONFIGURATION_BYTES: usize = 256 * 1024;
const MAX_CONFIGURATION_DEPTH: usize = 8;
const MAX_CONFIGURATION_NODES: usize = 512;
const CONFIGURATION_LIMITS: Limits = Limits {
    max_bytes: MAX_CONFIGURATION_BYTES,
    max_nodes: MAX_CONFIGURATION_NODES,
    max_depth: MAX_CONFIGURATION_DEPTH * 2,
};

/// At most this many entries are listed by [`describe`].
const DESCRIBE_LIMIT: usize = 24;

/// Why the store was left unchanged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoreError {
    /// Not a property list at all (empty, truncated, corrupt).
    Malformed(String),
    /// A property list, but not a layout this code knows how to edit.
    UnrecognisedLayout,
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::Malformed(e) => write!(f, "the wallpaper store could not be read ({e})"),
            StoreError::UnrecognisedLayout => write!(
                f,
                "the wallpaper store has a layout this version does not recognise"
            ),
        }
    }
}

/// `URL(fileURLWithPath:).absoluteString` for an absolute POSIX path: the
/// form the store keeps in `Files[].relative`. Bytes outside Foundation's
/// `urlPathAllowed` set (minus `;`, which Foundation also escapes in paths)
/// are percent-encoded as UTF-8. Production copies URLs macOS wrote; this
/// builds them for test fixtures.
#[cfg(test)]
pub fn file_url(path: &str) -> String {
    let mut out = String::from("file://");
    for &b in path.as_bytes() {
        let allowed = b.is_ascii_alphanumeric() || b"!$&'()*+,-./:=@_~".contains(&b);
        if allowed {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// `/private/var`, `/private/tmp` and `/private/etc` are the real locations
/// behind the `/var`, `/tmp`, `/etc` firmlinks. `canonicalize` yields the
/// former while Foundation may record the latter; compare without the prefix.
pub fn normalize_path(path: &str) -> &str {
    for dir in ["/var", "/tmp", "/etc"] {
        if let Some(rest) = path.strip_prefix("/private") {
            if rest == dir || rest.strip_prefix(dir).is_some_and(|r| r.starts_with('/')) {
                return rest;
            }
        }
    }
    path
}

/// The POSIX path of a `file://` URL, or None for anything else.
fn url_path(url: &str) -> Option<String> {
    let rest = url.strip_prefix("file://")?;
    let rest = rest.strip_prefix("localhost").unwrap_or(rest);
    if !rest.starts_with('/') {
        return None;
    }
    let bytes = rest.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = bytes.get(i + 1..i + 3)?;
            if !hex.iter().all(u8::is_ascii_hexdigit) {
                return None;
            }
            out.push(u8::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Parse a binary or XML plist after checking what it may cost.
fn parse_within(bytes: &[u8], limits: &Limits) -> Result<Value, StoreError> {
    plist_bounds::check(bytes, limits).map_err(StoreError::Malformed)?;
    let parsed = if bytes.starts_with(b"bplist00") {
        Value::from_reader(std::io::Cursor::new(bytes))
    } else {
        Value::from_reader_xml(bytes)
    };
    parsed.map_err(|e| StoreError::Malformed(e.to_string()))
}

fn parse(store: &[u8]) -> Result<Value, StoreError> {
    parse_within(store, &STORE_LIMITS)
}

/// Collects the distinct `file://` paths inside a nested `Configuration`
/// plist, within the bounds above. Nested plist data is followed too.
struct ConfigurationWalk {
    nodes_left: usize,
    exhausted: bool,
    paths: BTreeSet<String>,
}

impl ConfigurationWalk {
    fn plist(&mut self, bytes: &[u8], depth: usize) {
        if bytes.len() > MAX_CONFIGURATION_BYTES || depth > MAX_CONFIGURATION_DEPTH {
            self.exhausted = true;
            return;
        }
        // Over the bounds: unfamiliar, never a match.
        if plist_bounds::check(bytes, &CONFIGURATION_LIMITS).is_err() {
            self.exhausted = true;
            return;
        }
        if let Ok(value) = parse_within(bytes, &CONFIGURATION_LIMITS) {
            self.value(&value, depth);
        }
    }

    fn value(&mut self, value: &Value, depth: usize) {
        if self.exhausted || self.nodes_left == 0 || depth > MAX_CONFIGURATION_DEPTH {
            self.exhausted = true;
            return;
        }
        self.nodes_left -= 1;
        match value {
            Value::String(s) => {
                if let Some(path) = url_path(s) {
                    self.paths.insert(normalize_path(&path).to_string());
                }
            }
            Value::Dictionary(d) => d.values().for_each(|v| self.value(v, depth + 1)),
            Value::Array(a) => a.iter().for_each(|v| self.value(v, depth + 1)),
            Value::Data(d) if d.starts_with(b"bplist") || d.starts_with(b"<?xml") => {
                self.plist(d, depth + 1)
            }
            _ => {}
        }
    }
}

/// The image a macOS 26 `Configuration` blob names: its single distinct
/// `file://` URL. None when it names none, several, or exceeds the bounds,
/// so an unfamiliar configuration is never mistaken for the image.
fn configuration_image_path(configuration: &[u8]) -> Option<String> {
    let mut walk = ConfigurationWalk {
        nodes_left: MAX_CONFIGURATION_NODES,
        exhausted: false,
        paths: BTreeSet::new(),
    };
    walk.plist(configuration, 0);
    if walk.exhausted || walk.paths.len() != 1 {
        return None;
    }
    walk.paths.into_iter().next()
}

/// The image path of a still-image choice: `Files[0].relative` (macOS
/// 14/15) or, when `Files` is empty or absent, the URL in its
/// `Configuration` (macOS 26).
fn choice_image_path(choice: &Dictionary) -> Option<String> {
    if choice.get("Provider")?.as_string()? != IMAGE_PROVIDER {
        return None;
    }
    let files = match choice.get("Files") {
        None => &[][..],
        Some(files) => files.as_array()?.as_slice(),
    };
    match files {
        [file] => url_path(file.as_dictionary()?.get("relative")?.as_string()?),
        [] => configuration_image_path(choice.get("Configuration")?.as_data()?),
        _ => None,
    }
}

/// `entry.Desktop` when it is a desktop entry with a `Content.Choices` array.
fn desktop(entry: &Dictionary) -> Option<&Dictionary> {
    let desktop = entry.get("Desktop")?.as_dictionary()?;
    desktop
        .get("Content")?
        .as_dictionary()?
        .get("Choices")?
        .as_array()?;
    Some(desktop)
}

/// What a desktop shows when it is exactly one still image.
fn desktop_image_path(desktop: &Dictionary) -> Option<String> {
    let content = desktop.get("Content")?.as_dictionary()?;
    let [choice] = content.get("Choices")?.as_array()?.as_slice() else {
        return None;
    };
    choice_image_path(choice.as_dictionary()?)
}

/// Whether a desktop shows exactly one still image, at `image_path`.
/// `Configuration` is not required on 14/15; whatever macOS wrote is copied
/// verbatim, never synthesised.
fn shows_image(desktop: &Dictionary, image_path: &str) -> bool {
    desktop_image_path(desktop).is_some_and(|p| normalize_path(&p) == normalize_path(image_path))
}

/// A desktop entry found in the store: where it is, the entry holding it
/// (`Desktop`, `Idle`, `Type`, …) and its `Desktop`.
struct Found<'a> {
    at: String,
    entry: &'a Dictionary,
    desktop: &'a Dictionary,
}

/// Every desktop entry with its location (`"Spaces/<id>/Default"` …), or
/// None for more than [`MAX_DESKTOPS`] (not a store this code recognises).
fn desktops(root: &Dictionary) -> Option<Vec<Found<'_>>> {
    fn walk<'a>(v: &'a Value, at: String, depth: usize, out: &mut Vec<Found<'a>>) {
        if out.len() > MAX_DESKTOPS {
            return;
        }
        let Some(dict) = v.as_dictionary() else {
            return;
        };
        if let Some(desktop) = desktop(dict) {
            out.push(Found {
                at,
                entry: dict,
                desktop,
            });
            return;
        }
        if depth < MAX_DEPTH {
            for (k, child) in dict.iter() {
                walk(child, format!("{at}/{k}"), depth + 1, out);
            }
        }
    }
    let mut out = Vec::new();
    for section in std::iter::once(&ALL).chain(OVERRIDE_SECTIONS) {
        if let Some(v) = root.get(section) {
            walk(v, (*section).to_string(), 0, &mut out);
        }
    }
    (out.len() <= MAX_DESKTOPS).then_some(out)
}

/// Whether `v` holds a desktop entry within the walk depth.
fn has_desktop(v: &Value, depth: usize) -> bool {
    let Some(dict) = v.as_dictionary() else {
        return false;
    };
    desktop(dict).is_some()
        || (depth < MAX_DEPTH && dict.values().any(|c| has_desktop(c, depth + 1)))
}

/// A Space or display the store records an override for.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
enum Recorded {
    Space(String),
    Display(String),
}

/// The Spaces and displays `root` records, optionally only those that hold
/// a desktop entry.
fn recorded(root: &Dictionary, with_desktop_only: bool) -> BTreeSet<Recorded> {
    let keep = |v: &Value| !with_desktop_only || has_desktop(v, 0);
    let section = |name: &str| root.get(name).and_then(Value::as_dictionary);
    let mut out = BTreeSet::new();
    let displays = |d: &Dictionary, out: &mut BTreeSet<Recorded>| {
        for (id, _) in d.iter().filter(|(_, v)| keep(v)) {
            out.insert(Recorded::Display(id.clone()));
        }
    };
    if let Some(d) = section("Displays") {
        displays(d, &mut out);
    }
    for (id, space) in section("Spaces").into_iter().flat_map(Dictionary::iter) {
        if keep(space) {
            out.insert(Recorded::Space(id.clone()));
        }
        if let Some(d) = space
            .as_dictionary()
            .and_then(|s| s.get("Displays"))
            .and_then(Value::as_dictionary)
        {
            displays(d, &mut out);
        }
    }
    out
}

/// The entry (holding a `Desktop`) macOS wrote for `image_path` between
/// `before` and `after`: an entry showing the image that is new, or whose
/// `Desktop` differs from the one at the same location before (e.g. a new
/// `LastSet`). An entry that already showed the image before does not
/// count, so an unrelated Space showing the same picture cannot
/// short-circuit the wait for macOS's save.
pub fn fresh_image_entry(
    before: Option<&[u8]>,
    after: &[u8],
    image_path: &str,
) -> Option<Dictionary> {
    let after = parse(after).ok()?.into_dictionary()?;
    let before = before
        .and_then(|b| parse(b).ok())
        .and_then(Value::into_dictionary)
        .unwrap_or_default();
    let previous = desktops(&before).unwrap_or_default();
    desktops(&after)?
        .into_iter()
        .filter(|f| shows_image(f.desktop, image_path))
        .find(|f| {
            !previous
                .iter()
                .any(|p| p.at == f.at && p.desktop == f.desktop)
        })
        .map(|f| f.entry.clone())
}

/// Any entry already showing `image_path`, for when NSWorkspace made no
/// change because every display already showed the image.
pub fn existing_image_entry(store: &[u8], image_path: &str) -> Option<Dictionary> {
    let root = parse(store).ok()?.into_dictionary()?;
    desktops(&root)?
        .into_iter()
        .find(|f| shows_image(f.desktop, image_path))
        .map(|f| f.entry.clone())
}

/// The store in all-Spaces mode showing `image_entry` (an entry macOS
/// wrote, holding a `Desktop`): `AllSpacesAndDisplays.Desktop.Content`
/// replaced (the whole `Desktop` if the entry had none, the whole entry if
/// the store had no `AllSpacesAndDisplays`), every `Desktop` override under
/// `Spaces` and `Displays` removed (their `Idle` kept), everything else
/// preserved. Same encoding as the input.
pub fn all_spaces_store(store: &[u8], image_entry: &Dictionary) -> Result<Vec<u8>, StoreError> {
    let is_binary = store.starts_with(b"bplist");
    let mut root = parse(store)?;
    let dict = root
        .as_dictionary_mut()
        .ok_or(StoreError::UnrecognisedLayout)?;
    for section in OVERRIDE_SECTIONS {
        if dict
            .get(section)
            .is_some_and(|v| v.as_dictionary().is_none())
        {
            return Err(StoreError::UnrecognisedLayout);
        }
    }
    let image_desktop = desktop(image_entry).ok_or(StoreError::UnrecognisedLayout)?;
    let content = image_desktop
        .get("Content")
        .cloned()
        .ok_or(StoreError::UnrecognisedLayout)?;
    let has_overrides = OVERRIDE_SECTIONS.iter().any(|s| dict.contains_key(s));
    match dict.get_mut(ALL) {
        // A store with neither an all-Spaces entry nor any override is not
        // one this code knows.
        None if !has_overrides => return Err(StoreError::UnrecognisedLayout),
        // macOS 26 can leave no all-Spaces entry at all once it has expanded
        // the store per Space: macOS's own entry for the image becomes it.
        None => {
            dict.insert(ALL.into(), Value::Dictionary(image_entry.clone()));
        }
        Some(Value::Dictionary(all)) => match all.get_mut("Desktop") {
            Some(Value::Dictionary(d)) => {
                d.insert("Content".into(), content);
            }
            Some(_) => return Err(StoreError::UnrecognisedLayout),
            None => {
                all.insert("Desktop".into(), Value::Dictionary(image_desktop.clone()));
            }
        },
        Some(_) => return Err(StoreError::UnrecognisedLayout),
    }
    for section in OVERRIDE_SECTIONS {
        if let Some(Value::Dictionary(overrides)) = dict.get_mut(section) {
            remove_desktop_overrides(overrides, 0);
        }
    }

    let mut bytes = Vec::new();
    let written = if is_binary {
        root.to_writer_binary(&mut bytes)
    } else {
        root.to_writer_xml(&mut bytes)
    };
    written.map_err(|e| StoreError::Malformed(e.to_string()))?;
    Ok(bytes)
}

/// Remove every `Desktop` override below `dict`, keeping each entry's other
/// settings when it has an `Idle` (screen saver) choice, and dropping
/// entries and containers left with nothing to say.
fn remove_desktop_overrides(dict: &mut Dictionary, depth: usize) {
    let keys: Vec<String> = dict.keys().cloned().collect();
    for key in keys {
        let Some(Value::Dictionary(child)) = dict.get_mut(&key) else {
            continue;
        };
        let keep = if child.contains_key("Desktop") {
            child.remove("Desktop");
            child.contains_key("Idle")
        } else if depth < MAX_DEPTH {
            remove_desktop_overrides(child, depth + 1);
            !child.is_empty()
        } else {
            true
        };
        if !keep {
            dict.remove(&key);
        }
    }
}

/// How much of the store shows an image.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Coverage {
    /// All-Spaces mode: `AllSpacesAndDisplays.Desktop` and every override
    /// show the image.
    AllSpaces,
    /// macOS 26's reloaded form: no `AllSpacesAndDisplays.Desktop`, but one
    /// or more per-display / per-Space entries, every one showing the image,
    /// and every recorded Space and display holding one.
    EveryRecordedSpace,
    /// Some recorded desktop shows something else, or none is recorded.
    Incomplete,
    /// Not a readable property-list dictionary.
    Unreadable,
}

/// How much of `store` shows `image_path`.
pub fn coverage(store: &[u8], image_path: &str) -> Coverage {
    let Some(root) = parse(store).ok().and_then(Value::into_dictionary) else {
        return Coverage::Unreadable;
    };
    let Some(found) = desktops(&root) else {
        return Coverage::Incomplete;
    };
    if found.is_empty() || !found.iter().all(|f| shows_image(f.desktop, image_path)) {
        return Coverage::Incomplete;
    }
    if found.iter().any(|f| f.at == ALL) {
        Coverage::AllSpaces
    } else if root
        .get(ALL)
        .and_then(Value::as_dictionary)
        .is_some_and(|all| all.contains_key("Desktop"))
    {
        // An all-Spaces desktop this code cannot read: not proof.
        Coverage::Incomplete
    } else if recorded(&root, true) != recorded(&root, false) {
        // A Space or display with no desktop falls back to an all-Spaces
        // entry that does not exist: not proof it shows the image.
        Coverage::Incomplete
    } else {
        Coverage::EveryRecordedSpace
    }
}

/// Whether the store WallpaperAgent kept after its reload shows the image
/// everywhere, given the store as it was before the rewrite: all-Spaces
/// mode, or the reloaded per-Space form with every Space and display that
/// `before_rewrite` recorded still present and showing the image.
pub fn kept_everywhere(before_rewrite: &[u8], kept: &[u8], image_path: &str) -> bool {
    match coverage(kept, image_path) {
        Coverage::AllSpaces => true,
        Coverage::EveryRecordedSpace => {
            let dict = |b: &[u8]| parse(b).ok().and_then(Value::into_dictionary);
            match (dict(before_rewrite), dict(kept)) {
                (Some(before), Some(kept)) => {
                    recorded(&before, false).is_subset(&recorded(&kept, true))
                }
                _ => false,
            }
        }
        Coverage::Incomplete | Coverage::Unreadable => false,
    }
}

/// A one-line summary of the store for diagnostics: each recorded desktop
/// and what it shows. Bounded, so a huge store cannot flood the log.
pub fn describe(store: &[u8]) -> String {
    let root = match parse(store).map(Value::into_dictionary) {
        Ok(Some(root)) => root,
        Ok(None) => return "not a dictionary".into(),
        Err(e) => return e.to_string(),
    };
    let Some(found) = desktops(&root) else {
        return format!("more than {MAX_DESKTOPS} desktop entries");
    };
    let mut parts: Vec<String> = found
        .iter()
        .take(DESCRIBE_LIMIT)
        .map(|f| {
            let shows = desktop_image_path(f.desktop).unwrap_or_else(|| {
                let provider = f
                    .desktop
                    .get("Content")
                    .and_then(Value::as_dictionary)
                    .and_then(|c| c.get("Choices"))
                    .and_then(Value::as_array)
                    .and_then(|c| c.first())
                    .and_then(Value::as_dictionary)
                    .and_then(|c| c.get("Provider"))
                    .and_then(Value::as_string)
                    .unwrap_or("unknown");
                format!("<{provider}>")
            });
            format!("{}={shows}", f.at)
        })
        .collect();
    if found.len() > DESCRIBE_LIMIT {
        parts.push(format!("… {} more", found.len() - DESCRIBE_LIMIT));
    }
    if parts.is_empty() {
        return "no desktop entries".into();
    }
    parts.join("; ")
}

#[cfg(test)]
mod tests {
    use super::*;

    const OLD: &str = "/Users/me/Pictures/old.jpg";
    const NEW: &str = "/Users/me/My Pictures/it's \"new\";1.png";

    /// How a fixture choice names its file.
    #[derive(Clone, Copy)]
    enum Layout<'a> {
        /// macOS 14/15: `Files[0].relative`, with an optional opaque
        /// `Configuration` blob.
        Sonoma(Option<&'a [u8]>),
        /// macOS 26: empty `Files`; the URL is inside `Configuration`.
        Tahoe,
    }

    /// A macOS 26 `Configuration`: a nested binary plist naming the file.
    fn tahoe_configuration(path: &str) -> Vec<u8> {
        encode(
            &dict(vec![
                ("type", Value::String("imageFile".into())),
                (
                    "url",
                    dict(vec![("relative", Value::String(file_url(path)))]),
                ),
                ("placement", Value::String("fill".into())),
                ("backgroundColor", Value::Data(vec![0, 0, 0])),
            ]),
            true,
        )
    }

    fn choice(path: &str, layout: Layout) -> Value {
        let mut choice = Dictionary::new();
        match layout {
            Layout::Sonoma(config) => {
                let mut file = Dictionary::new();
                file.insert("relative".into(), Value::String(file_url(path)));
                if let Some(c) = config {
                    choice.insert("Configuration".into(), Value::Data(c.to_vec()));
                }
                choice.insert("Files".into(), Value::Array(vec![Value::Dictionary(file)]));
            }
            Layout::Tahoe => {
                choice.insert(
                    "Configuration".into(),
                    Value::Data(tahoe_configuration(path)),
                );
                choice.insert("Files".into(), Value::Array(vec![]));
            }
        }
        choice.insert("Provider".into(), Value::String(IMAGE_PROVIDER.into()));
        Value::Dictionary(choice)
    }

    fn desktop_with(choice: Value, last_set: &str) -> Value {
        let mut content = Dictionary::new();
        content.insert("Choices".into(), Value::Array(vec![choice]));
        content.insert("Shuffle".into(), Value::String("$null".into()));
        let mut desktop = Dictionary::new();
        desktop.insert("Content".into(), Value::Dictionary(content));
        desktop.insert("LastSet".into(), Value::String(last_set.into()));
        Value::Dictionary(desktop)
    }

    fn image_desktop(path: &str, last_set: &str, config: Option<&[u8]>) -> Value {
        desktop_with(choice(path, Layout::Sonoma(config)), last_set)
    }

    fn tahoe_desktop(path: &str, last_set: &str) -> Value {
        desktop_with(choice(path, Layout::Tahoe), last_set)
    }

    fn entry(desktop: Value) -> Value {
        let mut idle = Dictionary::new();
        idle.insert("Content".into(), Value::String("screen saver".into()));
        dict(vec![
            ("Desktop", desktop),
            ("Idle", Value::Dictionary(idle)),
            ("Type", Value::String("individual".into())),
        ])
    }

    fn entry_dict(desktop: Value) -> Dictionary {
        entry(desktop).into_dictionary().unwrap()
    }

    fn dict(pairs: Vec<(&str, Value)>) -> Value {
        Value::Dictionary(pairs.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
    }

    /// 2 displays, 2 Spaces, per-Space mode. `current` is what the current
    /// Space (S1) shows; Space S2's display B already shows NEW.
    fn store(current: Value) -> Value {
        dict(vec![
            (
                "AllSpacesAndDisplays",
                entry(image_desktop(OLD, "t0", Some(b"c-old"))),
            ),
            (
                "Displays",
                dict(vec![("A", entry(image_desktop(OLD, "t0", Some(b"c-old"))))]),
            ),
            (
                "Spaces",
                dict(vec![
                    (
                        "S1",
                        dict(vec![
                            ("Default", entry(current.clone())),
                            ("Displays", dict(vec![("A", entry(current))])),
                        ]),
                    ),
                    (
                        "S2",
                        dict(vec![(
                            "Displays",
                            dict(vec![("B", entry(image_desktop(NEW, "t0", Some(b"c-new"))))]),
                        )]),
                    ),
                ]),
            ),
            (
                "SystemDefault",
                entry(image_desktop("/System/default.heic", "t0", Some(b"c-sys"))),
            ),
            ("FutureKey", Value::Integer(7.into())),
        ])
    }

    /// macOS 26 after an agent reload: no `AllSpacesAndDisplays.Desktop`,
    /// one entry per display (A, B) and Space (S1, S2), each showing the
    /// image named by its own `Configuration`.
    fn tahoe_reloaded(shows: [&str; 4]) -> Value {
        let [s1a, s1b, s2a, s2b] = shows;
        let space = |a: &str, b: &str| {
            dict(vec![(
                "Displays",
                dict(vec![
                    ("A", entry(tahoe_desktop(a, "t2"))),
                    ("B", entry(tahoe_desktop(b, "t2"))),
                ]),
            )])
        };
        dict(vec![
            (
                "AllSpacesAndDisplays",
                dict(vec![("Type", Value::String("idle".into()))]),
            ),
            ("Displays", Value::Dictionary(Dictionary::new())),
            (
                "Spaces",
                dict(vec![("S1", space(s1a, s1b)), ("S2", space(s2a, s2b))]),
            ),
            (
                "SystemDefault",
                entry(tahoe_desktop("/System/default.heic", "t0")),
            ),
        ])
    }

    fn encode(v: &Value, binary: bool) -> Vec<u8> {
        let mut out = Vec::new();
        if binary {
            v.to_writer_binary(&mut out).unwrap();
        } else {
            v.to_writer_xml(&mut out).unwrap();
        }
        out
    }

    fn decode(bytes: &[u8]) -> Dictionary {
        Value::from_reader(std::io::Cursor::new(bytes))
            .unwrap()
            .into_dictionary()
            .unwrap()
    }

    fn get<'a>(v: &'a Value, path: &[&str]) -> &'a Value {
        path.iter().fold(v, |v, k| {
            v.as_dictionary()
                .unwrap()
                .get(k)
                .unwrap_or_else(|| panic!("{k}"))
        })
    }

    /// Whether a single desktop is recognised as showing `path`.
    fn recognised(desktop: Value, path: &str) -> bool {
        shows_image(&desktop.into_dictionary().unwrap(), path)
    }

    fn with_configuration(config: Vec<u8>, files: Option<Value>) -> Value {
        let mut c = Dictionary::new();
        c.insert("Provider".into(), Value::String(IMAGE_PROVIDER.into()));
        c.insert("Configuration".into(), Value::Data(config));
        if let Some(f) = files {
            c.insert("Files".into(), f);
        }
        desktop_with(Value::Dictionary(c), "t")
    }

    #[test]
    fn file_url_matches_foundation_encoding() {
        assert_eq!(file_url("/a b/c.png"), "file:///a%20b/c.png");
        assert_eq!(
            file_url("/it's \"q\";/x.png"),
            "file:///it's%20%22q%22%3B/x.png"
        );
        assert_eq!(file_url("/é#?%.png"), "file:///%C3%A9%23%3F%25.png");
        assert_eq!(url_path(&file_url(NEW)).as_deref(), Some(NEW));
    }

    #[test]
    fn url_path_rejects_non_file_urls_and_bad_escapes() {
        assert_eq!(url_path("https://example.com/a.png"), None);
        assert_eq!(url_path("file:///a%2"), None);
        assert_eq!(url_path("file:///a%+1"), None);
        assert_eq!(url_path("file://localhost/a%20b").as_deref(), Some("/a b"));
    }

    #[test]
    fn private_firmlink_prefixes_are_normalised() {
        assert_eq!(
            normalize_path("/private/var/folders/x.png"),
            "/var/folders/x.png"
        );
        assert_eq!(normalize_path("/private/tmp/x.png"), "/tmp/x.png");
        assert_eq!(normalize_path("/private/etc"), "/etc");
        assert_eq!(
            normalize_path("/private/variable/x.png"),
            "/private/variable/x.png"
        );
        assert_eq!(
            normalize_path("/Users/private/tmp/x"),
            "/Users/private/tmp/x"
        );

        // canonicalize gave /private/tmp; macOS recorded /tmp.
        let before = encode(&store(image_desktop(OLD, "t0", Some(b"c"))), true);
        let after = encode(&store(image_desktop("/tmp/w.png", "t1", Some(b"c"))), true);
        assert!(fresh_image_entry(Some(&before), &after, "/private/tmp/w.png").is_some());
    }

    #[test]
    fn tahoe_choices_name_their_image_in_the_nested_configuration() {
        assert!(recognised(tahoe_desktop(NEW, "t"), NEW));
        assert!(!recognised(tahoe_desktop(OLD, "t"), NEW));

        // XML-encoded and keyed-archiver-shaped configurations are read too.
        let xml = encode(
            &dict(vec![(
                "url",
                dict(vec![("relative", Value::String(file_url(NEW)))]),
            )]),
            false,
        );
        assert!(recognised(with_configuration(xml, None), NEW));
        let archived = encode(
            &dict(vec![
                ("$archiver", Value::String("NSKeyedArchiver".into())),
                (
                    "$objects",
                    Value::Array(vec![
                        Value::String("$null".into()),
                        dict(vec![("NS.relative", Value::Integer(2.into()))]),
                        Value::String(file_url(NEW)),
                    ]),
                ),
            ]),
            true,
        );
        assert!(recognised(
            with_configuration(archived, Some(Value::Array(vec![]))),
            NEW
        ));

        // A file URL nested one plist deeper still counts.
        let nested = encode(
            &dict(vec![("inner", Value::Data(tahoe_configuration(NEW)))]),
            true,
        );
        assert!(recognised(with_configuration(nested, None), NEW));
    }

    #[test]
    fn files_take_precedence_over_the_configuration() {
        // macOS 14/15: an opaque Configuration never overrides Files.
        let mut c = Dictionary::new();
        c.insert("Provider".into(), Value::String(IMAGE_PROVIDER.into()));
        c.insert(
            "Configuration".into(),
            Value::Data(tahoe_configuration(OLD)),
        );
        let mut file = Dictionary::new();
        file.insert("relative".into(), Value::String(file_url(NEW)));
        c.insert("Files".into(), Value::Array(vec![Value::Dictionary(file)]));
        assert!(recognised(desktop_with(Value::Dictionary(c), "t"), NEW));
    }

    #[test]
    fn unfamiliar_configurations_are_never_mistaken_for_the_image() {
        let two_files = encode(
            &dict(vec![
                ("url", Value::String(file_url(NEW))),
                ("fallback", Value::String(file_url(OLD))),
            ]),
            true,
        );
        let no_file = encode(
            &dict(vec![("url", Value::String("https://x/y.png".into()))]),
            true,
        );
        let huge = {
            let mut bytes = tahoe_configuration(NEW);
            // Valid plist header, then far more than any real configuration.
            bytes.resize(MAX_CONFIGURATION_BYTES + 1, 0);
            bytes
        };
        let mut deep = dict(vec![("url", Value::String(file_url(NEW)))]);
        for _ in 0..(MAX_CONFIGURATION_DEPTH + 2) {
            deep = dict(vec![("x", deep)]);
        }
        let wide = encode(
            &Value::Array(
                (0..MAX_CONFIGURATION_NODES)
                    .map(|_| Value::String(file_url(NEW)))
                    .collect(),
            ),
            true,
        );
        let cases: Vec<(&str, Vec<u8>)> = vec![
            ("two files", two_files),
            ("no file URL", no_file),
            ("empty", vec![]),
            ("truncated", b"bplist00\x01\x02".to_vec()),
            ("junk", b"\xff\xfe not a plist".to_vec()),
            ("huge", huge),
            ("deep", encode(&deep, true)),
            ("wide", wide),
        ];
        for (name, config) in cases {
            assert!(
                !recognised(with_configuration(config, Some(Value::Array(vec![]))), NEW),
                "{name}"
            );
        }

        // No Configuration at all, Files empty: nothing to read.
        let mut c = Dictionary::new();
        c.insert("Provider".into(), Value::String(IMAGE_PROVIDER.into()));
        c.insert("Files".into(), Value::Array(vec![]));
        assert!(!recognised(desktop_with(Value::Dictionary(c), "t"), NEW));
        // Configuration of the wrong type.
        let mut c = Dictionary::new();
        c.insert("Provider".into(), Value::String(IMAGE_PROVIDER.into()));
        c.insert("Configuration".into(), Value::String(file_url(NEW)));
        assert!(!recognised(desktop_with(Value::Dictionary(c), "t"), NEW));
        // Another provider (e.g. a dynamic wallpaper) naming the same file.
        let mut c = Dictionary::new();
        c.insert(
            "Provider".into(),
            Value::String("com.apple.wallpaper.choice.dynamic".into()),
        );
        c.insert(
            "Configuration".into(),
            Value::Data(tahoe_configuration(NEW)),
        );
        assert!(!recognised(desktop_with(Value::Dictionary(c), "t"), NEW));
    }

    #[test]
    fn an_image_already_shown_elsewhere_is_not_mistaken_for_the_new_save() {
        // S2/B already showed NEW before; macOS has not saved yet.
        let before = encode(&store(image_desktop(OLD, "t0", Some(b"c-old"))), true);
        assert_eq!(fresh_image_entry(Some(&before), &before, NEW), None);
        assert!(existing_image_entry(&before, NEW).is_some());

        // Now macOS saves the current Space's new entry.
        let after = encode(&store(image_desktop(NEW, "t1", Some(b"c-fresh"))), true);
        let fresh = Value::Dictionary(fresh_image_entry(Some(&before), &after, NEW).unwrap());
        assert_eq!(
            get(&fresh, &["Desktop", "LastSet"]),
            &Value::String("t1".into())
        );
    }

    #[test]
    fn a_re_save_of_the_same_image_counts_as_fresh() {
        let before = encode(&store(image_desktop(NEW, "t0", Some(b"c"))), true);
        let after = encode(&store(image_desktop(NEW, "t1", Some(b"c"))), true);
        assert!(fresh_image_entry(Some(&before), &after, NEW).is_some());
    }

    #[test]
    fn missing_or_malformed_before_snapshot_still_detects_the_save() {
        let after = encode(&store(image_desktop(NEW, "t1", Some(b"c"))), true);
        assert!(fresh_image_entry(None, &after, NEW).is_some());
        assert!(fresh_image_entry(Some(b"junk"), &after, NEW).is_some());
        assert_eq!(fresh_image_entry(None, b"junk", NEW), None);
        assert_eq!(fresh_image_entry(None, b"", NEW), None);
    }

    #[test]
    fn all_spaces_layout_points_the_all_spaces_entry_at_the_image_and_removes_desktop_overrides() {
        let input = store(image_desktop(NEW, "t1", Some(b"c-fresh")));
        let fresh = entry_dict(image_desktop(NEW, "t1", Some(b"c-fresh")));
        let out = all_spaces_store(&encode(&input, true), &fresh).unwrap();
        assert!(out.starts_with(b"bplist"), "binary in, binary out");
        let root = Value::Dictionary(decode(&out));

        let choice = &get(
            &root,
            &["AllSpacesAndDisplays", "Desktop", "Content", "Choices"],
        )
        .as_array()
        .unwrap()[0];
        assert_eq!(
            get(choice, &["Files"]).as_array().unwrap()[0]
                .as_dictionary()
                .unwrap()["relative"],
            Value::String(file_url(NEW))
        );
        assert_eq!(
            get(choice, &["Configuration"]),
            &Value::Data(b"c-fresh".to_vec())
        );
        // No Desktop override is left; every override's screen saver is.
        let found = desktops(root.as_dictionary().unwrap()).unwrap();
        assert_eq!(
            found.iter().map(|f| f.at.as_str()).collect::<Vec<_>>(),
            ["AllSpacesAndDisplays"]
        );
        for at in [
            &["Displays", "A"][..],
            &["Spaces", "S1", "Default"],
            &["Spaces", "S1", "Displays", "A"],
            &["Spaces", "S2", "Displays", "B"],
        ] {
            let kept = get(&root, at).as_dictionary().unwrap();
            assert_eq!(
                kept.get("Idle"),
                get(&input, at).as_dictionary().unwrap().get("Idle"),
                "{at:?}"
            );
            assert!(!kept.contains_key("Desktop"), "{at:?}");
        }

        // Preserved: the entry's own date/Idle/Type, SystemDefault, unknown keys.
        assert_eq!(
            get(&root, &["AllSpacesAndDisplays", "Desktop", "LastSet"]),
            &Value::String("t0".into())
        );
        assert_eq!(
            get(&root, &["AllSpacesAndDisplays", "Idle"]),
            get(&input, &["AllSpacesAndDisplays", "Idle"])
        );
        assert_eq!(
            get(&root, &["AllSpacesAndDisplays", "Type"]),
            &Value::String("individual".into())
        );
        assert_eq!(
            get(&root, &["SystemDefault"]),
            get(&input, &["SystemDefault"])
        );
        assert_eq!(get(&root, &["FutureKey"]), &Value::Integer(7.into()));
        assert_eq!(coverage(&out, NEW), Coverage::AllSpaces);
    }

    #[test]
    fn all_spaces_layout_keeps_xml_and_fills_a_missing_desktop_from_the_os_entry() {
        let input = dict(vec![
            (
                "AllSpacesAndDisplays",
                dict(vec![("Type", Value::String("idle".into()))]),
            ),
            (
                "Spaces",
                dict(vec![("S", entry(image_desktop(OLD, "t0", None)))]),
            ),
        ]);
        let fresh = entry_dict(image_desktop(NEW, "t1", None));
        let out = all_spaces_store(&encode(&input, false), &fresh).unwrap();
        assert!(!out.starts_with(b"bplist"), "XML in, XML out");
        let root = Value::Dictionary(decode(&out));
        assert_eq!(
            get(&root, &["AllSpacesAndDisplays", "Desktop"]),
            &image_desktop(NEW, "t1", None)
        );
        assert_eq!(
            get(&root, &["AllSpacesAndDisplays", "Type"]),
            &Value::String("idle".into())
        );
        assert_eq!(
            get(&root, &["Spaces", "S"]),
            &dict(vec![
                ("Idle", get(&input, &["Spaces", "S", "Idle"]).clone()),
                ("Type", Value::String("individual".into())),
            ])
        );
        assert!(
            root.as_dictionary().unwrap().get("Displays").is_none(),
            "absent stays absent"
        );
    }

    #[test]
    fn overrides_without_a_screen_saver_are_removed_whole() {
        let bare = |path: &str| dict(vec![("Desktop", image_desktop(path, "t0", None))]);
        let input = dict(vec![
            (
                "AllSpacesAndDisplays",
                entry(image_desktop(OLD, "t0", None)),
            ),
            ("Displays", dict(vec![("A", bare(OLD))])),
            (
                "Spaces",
                dict(vec![
                    // Only a Desktop: the whole Space goes.
                    (
                        "S1",
                        dict(vec![
                            ("Default", bare(NEW)),
                            ("Displays", dict(vec![("A", bare(NEW))])),
                        ]),
                    ),
                    // A screen saver on one display survives; its sibling goes.
                    (
                        "S2",
                        dict(vec![(
                            "Displays",
                            dict(vec![
                                ("A", entry(image_desktop(OLD, "t0", None))),
                                ("B", bare(OLD)),
                            ]),
                        )]),
                    ),
                    // Unknown non-dictionary data is left alone.
                    ("S3", dict(vec![("Note", Value::String("keep".into()))])),
                ]),
            ),
        ]);
        let fresh = entry_dict(image_desktop(NEW, "t1", None));
        let out = all_spaces_store(&encode(&input, true), &fresh).unwrap();
        let root = Value::Dictionary(decode(&out));
        assert_eq!(get(&root, &["Displays"]), &dict(vec![]));
        let spaces = get(&root, &["Spaces"]).as_dictionary().unwrap();
        assert!(!spaces.contains_key("S1"));
        let s2 = get(&root, &["Spaces", "S2", "Displays"])
            .as_dictionary()
            .unwrap();
        assert_eq!(s2.keys().collect::<Vec<_>>(), ["A"]);
        assert!(s2["A"].as_dictionary().unwrap().contains_key("Idle"));
        assert_eq!(
            get(&root, &["Spaces", "S3", "Note"]),
            &Value::String("keep".into())
        );
        assert_eq!(coverage(&out, NEW), Coverage::AllSpaces);
    }

    #[test]
    fn a_store_without_an_all_spaces_section_takes_the_macos_entry_as_it() {
        let input = dict(vec![(
            "Spaces",
            dict(vec![("S", entry(tahoe_desktop(NEW, "t1")))]),
        )]);
        let fresh = entry_dict(tahoe_desktop(NEW, "t1"));
        let out = all_spaces_store(&encode(&input, true), &fresh).unwrap();
        let root = Value::Dictionary(decode(&out));
        assert_eq!(
            get(&root, &["AllSpacesAndDisplays"]),
            &Value::Dictionary(fresh)
        );
        assert_eq!(coverage(&out, NEW), Coverage::AllSpaces);
    }

    #[test]
    fn tahoe_store_round_trip_detects_the_save_and_rewrites_from_it() {
        // Before: macOS 26 per-Space form showing OLD everywhere.
        let before = encode(&tahoe_reloaded([OLD, OLD, OLD, OLD]), true);
        // NSWorkspace changed the current Space (S1) on both displays.
        let saved = encode(&tahoe_reloaded([NEW, NEW, OLD, OLD]), true);
        assert_eq!(fresh_image_entry(Some(&before), &before, NEW), None);
        let fresh = fresh_image_entry(Some(&before), &saved, NEW).expect("macOS's entry");
        let out = all_spaces_store(&saved, &fresh).unwrap();
        let root = Value::Dictionary(decode(&out));
        // The Tahoe choice, with its Configuration, is copied verbatim.
        assert_eq!(
            get(&root, &["AllSpacesAndDisplays", "Desktop"]),
            &tahoe_desktop(NEW, "t2")
        );
        assert_eq!(coverage(&out, NEW), Coverage::AllSpaces);
        assert_eq!(coverage(&saved, NEW), Coverage::Incomplete);
    }

    #[test]
    fn the_reloaded_per_space_form_counts_only_when_every_entry_shows_the_image() {
        let everywhere = encode(&tahoe_reloaded([NEW, NEW, NEW, NEW]), true);
        assert_eq!(coverage(&everywhere, NEW), Coverage::EveryRecordedSpace);
        // XML encoding is equally accepted.
        let xml = encode(&tahoe_reloaded([NEW, NEW, NEW, NEW]), false);
        assert_eq!(coverage(&xml, NEW), Coverage::EveryRecordedSpace);

        // One display on one Space kept the old picture.
        let one_left = encode(&tahoe_reloaded([NEW, NEW, NEW, OLD]), true);
        assert_eq!(coverage(&one_left, NEW), Coverage::Incomplete);

        // An all-Spaces desktop this code cannot read is not proof.
        let mut odd = tahoe_reloaded([NEW, NEW, NEW, NEW]);
        odd.as_dictionary_mut().unwrap().insert(
            "AllSpacesAndDisplays".into(),
            dict(vec![(
                "Desktop",
                dict(vec![("Content", Value::String("?".into()))]),
            )]),
        );
        assert_eq!(coverage(&encode(&odd, true), NEW), Coverage::Incomplete);
    }

    #[test]
    fn a_recorded_space_without_a_desktop_is_not_proof_of_success() {
        // Review probe: only the current Space shows the image, another
        // Space holds only a screen saver, and there is no all-Spaces entry.
        let probe = dict(vec![(
            "Spaces",
            dict(vec![
                (
                    "S1",
                    dict(vec![("Default", entry(tahoe_desktop(NEW, "t")))]),
                ),
                ("S2", dict(vec![("Idle", Value::String("ss".into()))])),
            ]),
        )]);
        let probe = encode(&probe, true);
        assert_eq!(coverage(&probe, NEW), Coverage::Incomplete);
        assert!(!kept_everywhere(&probe, &probe, NEW));

        // A display recorded without a desktop is the same.
        let mut display_gap = tahoe_reloaded([NEW, NEW, NEW, NEW]);
        display_gap.as_dictionary_mut().unwrap().insert(
            "Displays".into(),
            dict(vec![(
                "C",
                dict(vec![("Idle", Value::String("ss".into()))]),
            )]),
        );
        assert_eq!(
            coverage(&encode(&display_gap, true), NEW),
            Coverage::Incomplete
        );
    }

    #[test]
    fn the_agent_must_keep_every_space_and_display_recorded_before_the_rewrite() {
        // Before the rewrite: Spaces S1, S2 on displays A, B.
        let before = encode(&tahoe_reloaded([NEW, NEW, OLD, OLD]), true);
        let all = encode(&tahoe_reloaded([NEW, NEW, NEW, NEW]), true);
        assert!(kept_everywhere(&before, &all, NEW));

        // The agent kept only S1: S2 lost, though every kept entry shows NEW.
        let mut lost_space = tahoe_reloaded([NEW, NEW, NEW, NEW]);
        lost_space
            .as_dictionary_mut()
            .unwrap()
            .get_mut("Spaces")
            .and_then(Value::as_dictionary_mut)
            .unwrap()
            .remove("S2");
        let lost_space = encode(&lost_space, true);
        assert_eq!(coverage(&lost_space, NEW), Coverage::EveryRecordedSpace);
        assert!(!kept_everywhere(&before, &lost_space, NEW));

        // A display recorded before but absent from every kept Space.
        let mut lost_display = tahoe_reloaded([NEW, NEW, NEW, NEW]);
        for space in ["S1", "S2"] {
            lost_display
                .as_dictionary_mut()
                .unwrap()
                .get_mut("Spaces")
                .and_then(Value::as_dictionary_mut)
                .and_then(|s| s.get_mut(space))
                .and_then(Value::as_dictionary_mut)
                .and_then(|s| s.get_mut("Displays"))
                .and_then(Value::as_dictionary_mut)
                .unwrap()
                .remove("B");
        }
        assert!(!kept_everywhere(&before, &encode(&lost_display, true), NEW));

        // All-Spaces mode needs no per-Space evidence; old pictures never pass.
        let one = encode(
            &dict(vec![(
                "AllSpacesAndDisplays",
                entry(tahoe_desktop(NEW, "t")),
            )]),
            true,
        );
        assert!(kept_everywhere(&before, &one, NEW));
        assert!(!kept_everywhere(&before, &before, NEW));
        assert!(!kept_everywhere(&before, b"junk", NEW));
        assert!(!kept_everywhere(b"junk", &all, NEW));
    }

    #[test]
    fn choices_without_configuration_are_accepted_as_written_by_macos() {
        let before = encode(&store(image_desktop(OLD, "t0", None)), true);
        let after = encode(&store(image_desktop(NEW, "t1", None)), true);
        let fresh = fresh_image_entry(Some(&before), &after, NEW).unwrap();
        let out = all_spaces_store(&after, &fresh).unwrap();
        assert_eq!(coverage(&out, NEW), Coverage::AllSpaces);
    }

    #[test]
    fn refuses_malformed_input() {
        let fresh = entry_dict(image_desktop(NEW, "t", None));
        for bad in [&b""[..], b"bplist00\x01\x02", b"<plist><dict>"] {
            assert!(matches!(
                all_spaces_store(bad, &fresh),
                Err(StoreError::Malformed(_))
            ));
        }
    }

    #[test]
    fn refuses_unrecognised_layouts() {
        let fresh = entry_dict(image_desktop(NEW, "t", None));
        let cases = [
            Value::Array(vec![]),
            Value::Dictionary(Dictionary::new()),
            dict(vec![(
                "SystemDefault",
                entry(image_desktop(OLD, "t", None)),
            )]),
            dict(vec![("AllSpacesAndDisplays", Value::String("x".into()))]),
            dict(vec![(
                "AllSpacesAndDisplays",
                dict(vec![("Desktop", Value::Integer(1.into()))]),
            )]),
            dict(vec![
                ("AllSpacesAndDisplays", Value::Dictionary(Dictionary::new())),
                ("Spaces", Value::Array(vec![])),
            ]),
        ];
        for case in cases {
            assert_eq!(
                all_spaces_store(&encode(&case, true), &fresh),
                Err(StoreError::UnrecognisedLayout),
                "{case:?}"
            );
        }
        // The template must itself be a desktop entry.
        let no_desktop = dict(vec![("LastSet", Value::String("t".into()))])
            .into_dictionary()
            .unwrap();
        let ok_store = encode(&store(image_desktop(OLD, "t", None)), true);
        assert_eq!(
            all_spaces_store(&ok_store, &no_desktop),
            Err(StoreError::UnrecognisedLayout)
        );
    }

    #[test]
    fn all_spaces_coverage_requires_the_all_spaces_entry_and_every_override() {
        let one = |all: &str| {
            encode(
                &dict(vec![(
                    "AllSpacesAndDisplays",
                    entry(image_desktop(all, "t", None)),
                )]),
                true,
            )
        };
        assert_eq!(coverage(&one(NEW), NEW), Coverage::AllSpaces);
        assert_eq!(coverage(&one(OLD), NEW), Coverage::Incomplete);
        // An override still showing another image (macOS restored per-Space state).
        assert_eq!(
            coverage(&encode(&store(image_desktop(NEW, "t", None)), true), NEW),
            Coverage::Incomplete
        );
        assert_eq!(coverage(b"", NEW), Coverage::Unreadable);
        assert_eq!(coverage(b"\x00\x01junk", NEW), Coverage::Unreadable);
        assert_eq!(
            coverage(&encode(&Value::Array(vec![]), true), NEW),
            Coverage::Unreadable
        );
        assert_eq!(
            coverage(&encode(&Value::Dictionary(Dictionary::new()), true), NEW),
            Coverage::Incomplete,
            "no recorded desktop is no proof"
        );
    }

    #[test]
    fn deep_unknown_nesting_is_not_walked_without_bound() {
        let mut deep = entry(image_desktop(NEW, "t1", None));
        for i in 0..20 {
            deep = dict(vec![(if i % 2 == 0 { "x" } else { "y" }, deep)]);
        }
        let after = encode(
            &dict(vec![
                ("AllSpacesAndDisplays", Value::Dictionary(Dictionary::new())),
                ("Spaces", deep),
            ]),
            true,
        );
        assert_eq!(fresh_image_entry(None, &after, NEW), None);
    }

    #[test]
    fn a_store_with_thousands_of_spaces_is_handled_and_described_briefly() {
        let spaces: Dictionary = (0..MAX_DESKTOPS)
            .map(|i| {
                (
                    format!("S{i}"),
                    dict(vec![("Default", entry(tahoe_desktop(NEW, "t")))]),
                )
            })
            .collect();
        let big = encode(
            &dict(vec![
                ("AllSpacesAndDisplays", Value::Dictionary(Dictionary::new())),
                ("Spaces", Value::Dictionary(spaces)),
            ]),
            true,
        );
        assert_eq!(coverage(&big, NEW), Coverage::EveryRecordedSpace);
        let text = describe(&big);
        assert!(
            text.ends_with(&format!("… {} more", MAX_DESKTOPS - DESCRIBE_LIMIT)),
            "{text}"
        );
        assert!(text.len() < 8 * 1024, "bounded: {} bytes", text.len());

        // One more than any real display × Space count: not recognised.
        let spaces: Dictionary = (0..=MAX_DESKTOPS)
            .map(|i| {
                (
                    format!("S{i}"),
                    dict(vec![("Default", entry(tahoe_desktop(NEW, "t")))]),
                )
            })
            .collect();
        let too_many = encode(&dict(vec![("Spaces", Value::Dictionary(spaces))]), true);
        assert_eq!(coverage(&too_many, NEW), Coverage::Incomplete);
        assert_eq!(existing_image_entry(&too_many, NEW), None);
        assert!(describe(&too_many).starts_with("more than"));
    }

    /// Binary plist whose objects form a DAG: object i = [i+1, i+1], the
    /// last a short string, so `levels` objects expand to 2^levels values.
    fn dag_bplist(levels: usize, leaf: &str) -> Vec<u8> {
        let mut out = b"bplist00".to_vec();
        let mut offsets = vec![];
        for i in 0..levels {
            offsets.push(out.len() as u32);
            out.push(0xA2);
            out.extend_from_slice(&((i + 1) as u16).to_be_bytes());
            out.extend_from_slice(&((i + 1) as u16).to_be_bytes());
        }
        offsets.push(out.len() as u32);
        out.push(0x50 | leaf.len() as u8);
        out.extend_from_slice(leaf.as_bytes());
        let table = out.len() as u64;
        for o in &offsets {
            out.extend_from_slice(&o.to_be_bytes());
        }
        out.extend_from_slice(&[0u8; 6]);
        out.extend_from_slice(&[4, 2]);
        out.extend_from_slice(&(offsets.len() as u64).to_be_bytes());
        out.extend_from_slice(&0u64.to_be_bytes());
        out.extend_from_slice(&table.to_be_bytes());
        out
    }

    #[test]
    fn exponentially_expanding_plists_are_refused_quickly() {
        // Review probe: 256 bytes at 22 levels took 1.2 s, doubling per level.
        let started = std::time::Instant::now();
        for levels in [22, 30, 40] {
            let config = dag_bplist(levels, "file:///a.png");
            assert!(config.len() < 512);
            assert!(
                !recognised(with_configuration(config, None), "/a.png"),
                "{levels}"
            );

            let store = dag_bplist(levels, "x");
            assert_eq!(coverage(&store, "/a.png"), Coverage::Unreadable);
            assert_eq!(fresh_image_entry(None, &store, "/a.png"), None);
            assert!(describe(&store).contains("could not be read"));
            let fresh = entry_dict(image_desktop(NEW, "t", None));
            assert!(matches!(
                all_spaces_store(&store, &fresh),
                Err(StoreError::Malformed(_))
            ));
        }
        assert!(
            started.elapsed() < std::time::Duration::from_secs(1),
            "{:?}",
            started.elapsed()
        );
    }

    #[test]
    fn deeply_nested_and_oversized_stores_are_refused_before_parsing() {
        let deep = format!(
            "<?xml version=\"1.0\"?><plist>{}{}</plist>",
            "<array>".repeat(50_000),
            "</array>".repeat(50_000)
        );
        // A small stack: neither the check nor a parse may recurse this deep.
        let result = std::thread::Builder::new()
            .stack_size(256 * 1024)
            .spawn(move || coverage(deep.as_bytes(), "/a.png"))
            .unwrap()
            .join()
            .unwrap();
        assert_eq!(result, Coverage::Unreadable);

        let mut huge = encode(&store(image_desktop(NEW, "t", None)), false);
        huge.resize(MAX_STORE_BYTES + 1, b' ');
        assert_eq!(coverage(&huge, NEW), Coverage::Unreadable);
        assert!(describe(&huge).contains("bytes"));
    }

    #[test]
    fn describe_lists_what_each_desktop_shows() {
        let text = describe(&encode(&store(image_desktop(NEW, "t1", None)), true));
        assert!(
            text.contains(&format!("AllSpacesAndDisplays={OLD}")),
            "{text}"
        );
        assert!(text.contains(&format!("Spaces/S1/Default={NEW}")), "{text}");
        assert!(
            text.contains(&format!("Spaces/S2/Displays/B={NEW}")),
            "{text}"
        );

        let tahoe = describe(&encode(&tahoe_reloaded([NEW, OLD, NEW, NEW]), true));
        assert!(
            tahoe.contains(&format!("Spaces/S1/Displays/B={OLD}")),
            "{tahoe}"
        );

        let mut dynamic = Dictionary::new();
        dynamic.insert(
            "Provider".into(),
            Value::String("com.apple.wallpaper.choice.dynamic".into()),
        );
        let other = encode(
            &dict(vec![(
                "AllSpacesAndDisplays",
                entry(desktop_with(Value::Dictionary(dynamic), "t")),
            )]),
            true,
        );
        assert_eq!(
            describe(&other),
            "AllSpacesAndDisplays=<com.apple.wallpaper.choice.dynamic>"
        );
        assert!(describe(b"").contains("could not be read"));
        assert_eq!(
            describe(&encode(&Value::Array(vec![]), true)),
            "not a dictionary"
        );
        assert_eq!(
            describe(&encode(&Value::Dictionary(Dictionary::new()), true)),
            "no desktop entries"
        );
    }
}

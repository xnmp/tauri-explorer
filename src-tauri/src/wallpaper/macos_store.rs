//! Pure logic for the private macOS 14+ wallpaper store (#1441).
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
//! the entry macOS itself just wrote for the new image, and `Spaces` and
//! `Displays` are emptied. Nothing else (`SystemDefault`, `Idle`, `Type`,
//! dates, unknown keys) is touched, no `Configuration` blob is ever
//! fabricated, and a store whose shape is not recognised is never written.
//! See `docs/lessons/1441-macos-wallpaper-all-spaces.md`.

use plist::{Dictionary, Value};

/// `Provider` of a still-image choice.
pub const IMAGE_PROVIDER: &str = "com.apple.wallpaper.choice.image";

const ALL: &str = "AllSpacesAndDisplays";
/// Sections that hold per-display / per-Space overrides of `ALL`.
const OVERRIDE_SECTIONS: &[&str] = &["Displays", "Spaces"];

/// `Spaces` nests `<space>` → `Displays` → `<display>`; a little headroom
/// beyond that, but never an unbounded walk of an unknown structure.
const MAX_DEPTH: usize = 5;

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

fn parse(store: &[u8]) -> Result<Value, StoreError> {
    Value::from_reader(std::io::Cursor::new(store))
        .map_err(|e| StoreError::Malformed(e.to_string()))
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

/// Whether a desktop shows exactly one still image, at `image_path`.
/// `Configuration` is not required (newer releases may omit it); whatever
/// macOS wrote is copied verbatim, never synthesised.
fn shows_image(desktop: &Dictionary, image_path: &str) -> bool {
    let choice = (|| {
        let content = desktop.get("Content")?.as_dictionary()?;
        let [choice] = content.get("Choices")?.as_array()?.as_slice() else {
            return None;
        };
        let choice = choice.as_dictionary()?;
        if choice.get("Provider")?.as_string()? != IMAGE_PROVIDER {
            return None;
        }
        let [file] = choice.get("Files")?.as_array()?.as_slice() else {
            return None;
        };
        url_path(file.as_dictionary()?.get("relative")?.as_string()?)
    })();
    choice.is_some_and(|p| normalize_path(&p) == normalize_path(image_path))
}

/// Every desktop entry with its location (`"Spaces/<id>/Default"` …).
fn desktops(root: &Dictionary) -> Vec<(String, &Dictionary)> {
    fn walk<'a>(v: &'a Value, at: String, depth: usize, out: &mut Vec<(String, &'a Dictionary)>) {
        let Some(dict) = v.as_dictionary() else {
            return;
        };
        if let Some(d) = desktop(dict) {
            out.push((at, d));
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
    out
}

/// The `Desktop` dictionary macOS wrote for `image_path` between `before`
/// and `after`: an entry showing the image that is new, or differs from the
/// entry at the same location before (e.g. a new `LastSet`). An entry that
/// already showed the image before does not count, so an unrelated Space
/// showing the same picture cannot short-circuit the wait for macOS's save.
pub fn fresh_image_desktop(
    before: Option<&[u8]>,
    after: &[u8],
    image_path: &str,
) -> Option<Dictionary> {
    let after = parse(after).ok()?.into_dictionary()?;
    let before = before
        .and_then(|b| parse(b).ok())
        .and_then(Value::into_dictionary)
        .unwrap_or_default();
    let previous = desktops(&before);
    desktops(&after)
        .into_iter()
        .filter(|(_, d)| shows_image(d, image_path))
        .find(|(at, d)| !previous.iter().any(|(p_at, p)| p_at == at && p == d))
        .map(|(_, d)| d.clone())
}

/// Any `Desktop` already showing `image_path`, for when NSWorkspace made no
/// change because every display already showed the image.
pub fn existing_image_desktop(store: &[u8], image_path: &str) -> Option<Dictionary> {
    let root = parse(store).ok()?.into_dictionary()?;
    desktops(&root)
        .into_iter()
        .find(|(_, d)| shows_image(d, image_path))
        .map(|(_, d)| d.clone())
}

/// The store in all-Spaces mode showing `image_desktop` (a `Desktop`
/// dictionary macOS wrote): `AllSpacesAndDisplays.Desktop.Content` replaced
/// (or the whole `Desktop` if the entry had none), `Spaces` and `Displays`
/// emptied, everything else preserved. Same encoding as the input.
pub fn all_spaces_store(store: &[u8], image_desktop: &Dictionary) -> Result<Vec<u8>, StoreError> {
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
    let content = image_desktop
        .get("Content")
        .and_then(Value::as_dictionary)
        .ok_or(StoreError::UnrecognisedLayout)?
        .clone();
    let all = dict
        .get_mut(ALL)
        .and_then(Value::as_dictionary_mut)
        .ok_or(StoreError::UnrecognisedLayout)?;
    match all.get_mut("Desktop") {
        Some(Value::Dictionary(d)) => {
            d.insert("Content".into(), Value::Dictionary(content));
        }
        Some(_) => return Err(StoreError::UnrecognisedLayout),
        None => {
            all.insert("Desktop".into(), Value::Dictionary(image_desktop.clone()));
        }
    }
    for section in OVERRIDE_SECTIONS {
        if dict.contains_key(section) {
            dict.insert((*section).into(), Value::Dictionary(Dictionary::new()));
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

/// Whether every desktop the store records (all-Spaces entry and any
/// per-display / per-Space override) shows `image_path`.
pub fn shows_everywhere(store: &[u8], image_path: &str) -> bool {
    let Some(root) = parse(store).ok().and_then(Value::into_dictionary) else {
        return false;
    };
    let all = desktops(&root);
    all.iter().any(|(at, _)| at == ALL) && all.iter().all(|(_, d)| shows_image(d, image_path))
}

#[cfg(test)]
mod tests {
    use super::*;

    const OLD: &str = "/Users/me/Pictures/old.jpg";
    const NEW: &str = "/Users/me/My Pictures/it's \"new\";1.png";

    fn image_desktop(path: &str, last_set: &str, config: Option<&[u8]>) -> Value {
        let mut file = Dictionary::new();
        file.insert("relative".into(), Value::String(file_url(path)));
        let mut choice = Dictionary::new();
        if let Some(c) = config {
            choice.insert("Configuration".into(), Value::Data(c.to_vec()));
        }
        choice.insert("Files".into(), Value::Array(vec![Value::Dictionary(file)]));
        choice.insert("Provider".into(), Value::String(IMAGE_PROVIDER.into()));
        let mut content = Dictionary::new();
        content.insert(
            "Choices".into(),
            Value::Array(vec![Value::Dictionary(choice)]),
        );
        content.insert("Shuffle".into(), Value::String("$null".into()));
        let mut desktop = Dictionary::new();
        desktop.insert("Content".into(), Value::Dictionary(content));
        desktop.insert("LastSet".into(), Value::String(last_set.into()));
        Value::Dictionary(desktop)
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
        assert!(fresh_image_desktop(Some(&before), &after, "/private/tmp/w.png").is_some());
    }

    #[test]
    fn an_image_already_shown_elsewhere_is_not_mistaken_for_the_new_save() {
        // S2/B already showed NEW before; macOS has not saved yet.
        let before = encode(&store(image_desktop(OLD, "t0", Some(b"c-old"))), true);
        assert_eq!(fresh_image_desktop(Some(&before), &before, NEW), None);
        assert!(existing_image_desktop(&before, NEW).is_some());

        // Now macOS saves the current Space's new entry.
        let after = encode(&store(image_desktop(NEW, "t1", Some(b"c-fresh"))), true);
        let fresh = fresh_image_desktop(Some(&before), &after, NEW).unwrap();
        assert_eq!(fresh["LastSet"], Value::String("t1".into()));
    }

    #[test]
    fn a_re_save_of_the_same_image_counts_as_fresh() {
        let before = encode(&store(image_desktop(NEW, "t0", Some(b"c"))), true);
        let after = encode(&store(image_desktop(NEW, "t1", Some(b"c"))), true);
        assert!(fresh_image_desktop(Some(&before), &after, NEW).is_some());
    }

    #[test]
    fn missing_or_malformed_before_snapshot_still_detects_the_save() {
        let after = encode(&store(image_desktop(NEW, "t1", Some(b"c"))), true);
        assert!(fresh_image_desktop(None, &after, NEW).is_some());
        assert!(fresh_image_desktop(Some(b"junk"), &after, NEW).is_some());
        assert_eq!(fresh_image_desktop(None, b"junk", NEW), None);
    }

    #[test]
    fn all_spaces_layout_points_the_all_spaces_entry_at_the_image_and_empties_overrides() {
        let input = store(image_desktop(NEW, "t1", Some(b"c-fresh")));
        let fresh = image_desktop(NEW, "t1", Some(b"c-fresh"))
            .into_dictionary()
            .unwrap();
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
        assert_eq!(
            get(&root, &["Spaces"]),
            &Value::Dictionary(Dictionary::new())
        );
        assert_eq!(
            get(&root, &["Displays"]),
            &Value::Dictionary(Dictionary::new())
        );

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
        let fresh = image_desktop(NEW, "t1", None).into_dictionary().unwrap();
        let out = all_spaces_store(&encode(&input, false), &fresh).unwrap();
        assert!(!out.starts_with(b"bplist"), "XML in, XML out");
        let root = Value::Dictionary(decode(&out));
        assert_eq!(
            get(&root, &["AllSpacesAndDisplays", "Desktop"]),
            &Value::Dictionary(fresh)
        );
        assert_eq!(
            get(&root, &["Spaces"]),
            &Value::Dictionary(Dictionary::new())
        );
        assert!(
            root.as_dictionary().unwrap().get("Displays").is_none(),
            "absent stays absent"
        );
    }

    #[test]
    fn choices_without_configuration_are_accepted_as_written_by_macos() {
        let before = encode(&store(image_desktop(OLD, "t0", None)), true);
        let after = encode(&store(image_desktop(NEW, "t1", None)), true);
        let fresh = fresh_image_desktop(Some(&before), &after, NEW).unwrap();
        let out = all_spaces_store(&after, &fresh).unwrap();
        assert!(shows_everywhere(&out, NEW));
    }

    #[test]
    fn refuses_malformed_input() {
        let fresh = image_desktop(NEW, "t", None).into_dictionary().unwrap();
        for bad in [&b""[..], b"bplist00\x01\x02", b"<plist><dict>"] {
            assert!(matches!(
                all_spaces_store(bad, &fresh),
                Err(StoreError::Malformed(_))
            ));
        }
    }

    #[test]
    fn refuses_unrecognised_layouts() {
        let fresh = image_desktop(NEW, "t", None).into_dictionary().unwrap();
        let cases = [
            Value::Array(vec![]),
            Value::Dictionary(Dictionary::new()),
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
        let no_content = dict(vec![("LastSet", Value::String("t".into()))])
            .into_dictionary()
            .unwrap();
        let ok_store = encode(&store(image_desktop(OLD, "t", None)), true);
        assert_eq!(
            all_spaces_store(&ok_store, &no_content),
            Err(StoreError::UnrecognisedLayout)
        );
    }

    #[test]
    fn shows_everywhere_requires_the_all_spaces_entry_and_every_override() {
        let one = |all: &str| {
            encode(
                &dict(vec![(
                    "AllSpacesAndDisplays",
                    entry(image_desktop(all, "t", None)),
                )]),
                true,
            )
        };
        assert!(shows_everywhere(&one(NEW), NEW));
        assert!(!shows_everywhere(&one(OLD), NEW));
        // An override still showing another image (macOS restored per-Space state).
        assert!(!shows_everywhere(
            &encode(&store(image_desktop(NEW, "t", None)), true),
            NEW
        ));
        assert!(!shows_everywhere(b"", NEW));
        assert!(!shows_everywhere(
            &encode(&Value::Dictionary(Dictionary::new()), true),
            NEW
        ));
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
        assert_eq!(fresh_image_desktop(None, &after, NEW), None);
    }
}

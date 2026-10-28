//! Pure transform of the private macOS 14+ wallpaper store (#1441).
//!
//! `~/Library/Application Support/com.apple.wallpaper/Store/Index.plist`
//! records the wallpaper choice for "all Spaces and displays", per display,
//! and per Space. Public API (`NSWorkspace.setDesktopImageURL`) only changes
//! the current Space, so reaching the others means pointing every desktop
//! entry in this store at the new image and restarting `WallpaperAgent`.
//!
//! The format is undocumented and has changed between releases, so this
//! module only rewrites structures it recognises and refuses everything
//! else: a store it cannot parse, or one without the `AllSpacesAndDisplays`
//! entry, is left byte-for-byte untouched. See
//! `docs/lessons/1441-macos-wallpaper-all-spaces.md`.

use plist::{Dictionary, Value};

/// `Provider` of a still-image choice. Dynamic, aerial and colour choices use
/// other providers and carry no `Files`.
pub const IMAGE_PROVIDER: &str = "com.apple.wallpaper.choice.image";

/// Top-level sections that hold desktop entries. `SystemDefault` is the
/// factory fallback and `Idle` (inside each entry) is the screen saver; both
/// are deliberately left alone.
const SLOT_SECTIONS: &[&str] = &["AllSpacesAndDisplays", "Displays", "Spaces"];

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
    /// No still-image choice to model the new entry on (the store only holds
    /// dynamic/aerial/colour wallpapers and the new image has not landed yet).
    NoImageTemplate,
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::Malformed(e) => write!(f, "the wallpaper store could not be read ({e})"),
            StoreError::UnrecognisedLayout => {
                write!(
                    f,
                    "the wallpaper store has a format this version does not recognise"
                )
            }
            StoreError::NoImageTemplate => {
                write!(
                    f,
                    "macOS did not record the new image in the wallpaper store"
                )
            }
        }
    }
}

/// Where the replacement entry was modelled from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TemplateSource {
    /// The entry macOS itself wrote for the new image (via NSWorkspace).
    NewImage,
    /// Another still-image entry, with its file swapped for the new image.
    OtherImage,
}

/// A store rewritten so every desktop entry shows the new image.
#[derive(Debug, Clone, PartialEq)]
pub struct StoreRewrite {
    /// The new store, in the same encoding (binary or XML) as the input.
    pub bytes: Vec<u8>,
    /// Desktop entries found in the store.
    pub entries: usize,
    /// Entries that did not already show the new image.
    pub changed: usize,
    pub source: TemplateSource,
}

/// `URL(fileURLWithPath:).absoluteString` for an absolute POSIX path: the
/// form the store keeps in `Files[].relative`. Every byte outside
/// Foundation's `urlPathAllowed` set is percent-encoded as UTF-8.
pub fn file_url(path: &str) -> String {
    let mut out = String::from("file://");
    for &b in path.as_bytes() {
        let allowed = b.is_ascii_alphanumeric() || b"!$&'()*+,-./:;=@_~".contains(&b);
        if allowed {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
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
            let hex = std::str::from_utf8(hex).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// The `Content` dictionary of a desktop entry, if `entry` is one:
/// `{ Desktop: { Content: { Choices: [...] , ... } } }`.
fn desktop_content(entry: &Dictionary) -> Option<&Dictionary> {
    let content = entry
        .get("Desktop")?
        .as_dictionary()?
        .get("Content")?
        .as_dictionary()?;
    content.get("Choices")?.as_array()?;
    Some(content)
}

fn for_each_entry<'a>(value: &'a Value, depth: usize, f: &mut impl FnMut(&'a Dictionary)) {
    let Some(dict) = value.as_dictionary() else {
        return;
    };
    if desktop_content(dict).is_some() {
        f(dict);
        return;
    }
    if depth < MAX_DEPTH {
        for (_, child) in dict.iter() {
            for_each_entry(child, depth + 1, f);
        }
    }
}

fn for_each_entry_mut(value: &mut Value, depth: usize, f: &mut impl FnMut(&mut Dictionary)) {
    let Some(dict) = value.as_dictionary_mut() else {
        return;
    };
    if desktop_content(dict).is_some() {
        f(dict);
        return;
    }
    if depth < MAX_DEPTH {
        for (_, child) in dict.iter_mut() {
            for_each_entry_mut(child, depth + 1, f);
        }
    }
}

/// Visit the desktop entries of every section, in a stable order.
fn entries(root: &Dictionary) -> Vec<&Dictionary> {
    let mut out = Vec::new();
    for section in SLOT_SECTIONS {
        if let Some(value) = root.get(section) {
            for_each_entry(value, 0, &mut |entry| out.push(entry));
        }
    }
    out
}

/// A still-image choice: image provider, decodable configuration, exactly
/// one file URL. Returns that URL.
fn image_choice_url(choice: &Value) -> Option<&str> {
    let choice = choice.as_dictionary()?;
    if choice.get("Provider")?.as_string()? != IMAGE_PROVIDER {
        return None;
    }
    choice.get("Configuration")?.as_data()?;
    let files = choice.get("Files")?.as_array()?;
    let [file] = files.as_slice() else {
        return None;
    };
    let url = file.as_dictionary()?.get("relative")?.as_string()?;
    url_path(url).map(|_| url)
}

/// The `Content` to give every desktop entry.
///
/// Prefers the entry macOS wrote for the new image itself (its
/// `Configuration` is then exactly what the OS produces). Otherwise models
/// one on any existing still-image entry, swapping in the new file and
/// clearing shuffle. Never fabricates a `Configuration` blob.
fn template(root: &Dictionary, image_path: &str) -> Option<(Dictionary, TemplateSource)> {
    let all = entries(root);
    let single_image_choice = |content: &Dictionary| -> Option<String> {
        let choices = content.get("Choices")?.as_array()?;
        let [choice] = choices.as_slice() else {
            return None;
        };
        image_choice_url(choice).map(String::from)
    };

    for entry in &all {
        let content = desktop_content(entry)?;
        if let Some(url) = single_image_choice(content) {
            if url_path(&url).as_deref() == Some(image_path) {
                return Some((content.clone(), TemplateSource::NewImage));
            }
        }
    }

    for entry in &all {
        let content = desktop_content(entry)?;
        let choices = content.get("Choices")?.as_array()?;
        let Some(choice) = choices.iter().find(|c| image_choice_url(c).is_some()) else {
            continue;
        };
        let mut choice = choice.as_dictionary()?.clone();
        let mut file = Dictionary::new();
        file.insert("relative".into(), Value::String(file_url(image_path)));
        choice.insert("Files".into(), Value::Array(vec![Value::Dictionary(file)]));
        let mut content = content.clone();
        content.insert(
            "Choices".into(),
            Value::Array(vec![Value::Dictionary(choice)]),
        );
        if content.contains_key("Shuffle") {
            // The value the system writes for "no shuffle".
            content.insert("Shuffle".into(), Value::String("$null".into()));
        }
        return Some((content, TemplateSource::OtherImage));
    }
    None
}

/// Whether the store already records `image_path` as a desktop entry
/// (i.e. the NSWorkspace change has been persisted). Malformed → false.
pub fn records_image(store: &[u8], image_path: &str) -> bool {
    let Ok(Value::Dictionary(root)) = Value::from_reader(std::io::Cursor::new(store)) else {
        return false;
    };
    matches!(
        template(&root, image_path),
        Some((_, TemplateSource::NewImage))
    )
}

/// Point every desktop entry of the store at `image_path`.
///
/// Leaves `Idle`, `SystemDefault`, `Type`, dates and any unknown keys alone.
/// Errors leave the caller with the original bytes: nothing is written.
pub fn rewrite_store(store: &[u8], image_path: &str) -> Result<StoreRewrite, StoreError> {
    let is_binary = store.starts_with(b"bplist");
    let mut root = Value::from_reader(std::io::Cursor::new(store))
        .map_err(|e| StoreError::Malformed(e.to_string()))?;

    let dict = root.as_dictionary().ok_or(StoreError::UnrecognisedLayout)?;
    if !dict
        .get("AllSpacesAndDisplays")
        .is_some_and(|v| v.as_dictionary().is_some())
    {
        return Err(StoreError::UnrecognisedLayout);
    }
    let total = entries(dict).len();
    if total == 0 {
        return Err(StoreError::UnrecognisedLayout);
    }
    let (content, source) = template(dict, image_path).ok_or(StoreError::NoImageTemplate)?;

    let mut changed = 0;
    let dict = root
        .as_dictionary_mut()
        .ok_or(StoreError::UnrecognisedLayout)?;
    for section in SLOT_SECTIONS {
        if let Some(value) = dict.get_mut(section) {
            for_each_entry_mut(value, 0, &mut |entry| {
                let Some(Value::Dictionary(desktop)) = entry.get_mut("Desktop") else {
                    return;
                };
                let replacement = Value::Dictionary(content.clone());
                if desktop.get("Content") != Some(&replacement) {
                    desktop.insert("Content".into(), replacement);
                    changed += 1;
                }
            });
        }
    }

    let mut bytes = Vec::new();
    let written = if is_binary {
        root.to_writer_binary(&mut bytes)
    } else {
        root.to_writer_xml(&mut bytes)
    };
    written.map_err(|e| StoreError::Malformed(e.to_string()))?;

    Ok(StoreRewrite {
        bytes,
        entries: total,
        changed,
        source,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const OLD: &str = "/Users/me/Pictures/old.jpg";
    const NEW: &str = "/Users/me/My Pictures/it's \"new\".png";

    fn image_choice(path: &str, config: &[u8]) -> Value {
        let mut file = Dictionary::new();
        file.insert("relative".into(), Value::String(file_url(path)));
        let mut choice = Dictionary::new();
        choice.insert("Configuration".into(), Value::Data(config.to_vec()));
        choice.insert("Files".into(), Value::Array(vec![Value::Dictionary(file)]));
        choice.insert("Provider".into(), Value::String(IMAGE_PROVIDER.into()));
        Value::Dictionary(choice)
    }

    fn aerial_choice() -> Value {
        let mut choice = Dictionary::new();
        choice.insert("Configuration".into(), Value::Data(b"aerial".to_vec()));
        choice.insert("Files".into(), Value::Array(vec![]));
        choice.insert(
            "Provider".into(),
            Value::String("com.apple.wallpaper.choice.aerials".into()),
        );
        Value::Dictionary(choice)
    }

    fn entry(choice: Value) -> Value {
        let mut content = Dictionary::new();
        content.insert("Choices".into(), Value::Array(vec![choice]));
        content.insert("Shuffle".into(), Value::String("$null".into()));
        let mut desktop = Dictionary::new();
        desktop.insert("Content".into(), Value::Dictionary(content));
        desktop.insert("LastSet".into(), Value::String("2025-01-01".into()));
        let mut idle = Dictionary::new();
        idle.insert("Content".into(), Value::String("screen saver".into()));
        let mut e = Dictionary::new();
        e.insert("Desktop".into(), Value::Dictionary(desktop));
        e.insert("Idle".into(), Value::Dictionary(idle));
        e.insert("Type".into(), Value::String("individual".into()));
        Value::Dictionary(e)
    }

    fn dict(pairs: Vec<(&str, Value)>) -> Value {
        Value::Dictionary(pairs.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
    }

    /// Sonoma layout after an NSWorkspace set on the current Space of a
    /// 2-display, 2-Space Mac: the current Space's displays show NEW, every
    /// other entry still shows OLD.
    fn sonoma_store(current_space_choice: Value) -> Value {
        dict(vec![
            ("AllSpacesAndDisplays", entry(image_choice(OLD, b"cfg-old"))),
            (
                "Displays",
                dict(vec![("DISPLAY-A", entry(image_choice(OLD, b"cfg-old")))]),
            ),
            (
                "Spaces",
                dict(vec![
                    (
                        "SPACE-1",
                        dict(vec![
                            ("Default", entry(current_space_choice.clone())),
                            (
                                "Displays",
                                dict(vec![
                                    ("DISPLAY-A", entry(current_space_choice.clone())),
                                    ("DISPLAY-B", entry(current_space_choice)),
                                ]),
                            ),
                        ]),
                    ),
                    (
                        "SPACE-2",
                        dict(vec![
                            ("Default", entry(image_choice(OLD, b"cfg-old"))),
                            (
                                "Displays",
                                dict(vec![("DISPLAY-B", entry(aerial_choice()))]),
                            ),
                        ]),
                    ),
                ]),
            ),
            (
                "SystemDefault",
                entry(image_choice("/System/default.heic", b"cfg-sys")),
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

    /// The image paths shown by every desktop entry outside SystemDefault.
    fn shown_paths(root: &Dictionary) -> Vec<Option<String>> {
        entries(root)
            .iter()
            .map(|e| {
                let choices = desktop_content(e)
                    .unwrap()
                    .get("Choices")
                    .unwrap()
                    .as_array()
                    .unwrap();
                choices
                    .first()
                    .and_then(image_choice_url)
                    .and_then(url_path)
            })
            .collect()
    }

    fn system_default_path(root: &Dictionary) -> Option<String> {
        let e = root.get("SystemDefault").unwrap().as_dictionary().unwrap();
        let c = desktop_content(e)
            .unwrap()
            .get("Choices")
            .unwrap()
            .as_array()
            .unwrap();
        image_choice_url(&c[0]).and_then(url_path)
    }

    #[test]
    fn file_url_matches_foundation_encoding_for_spaces_quotes_and_unicode() {
        assert_eq!(file_url("/a b/c.png"), "file:///a%20b/c.png");
        assert_eq!(
            file_url("/it's \"q\"/x.png"),
            "file:///it's%20%22q%22/x.png"
        );
        assert_eq!(file_url("/é#?%.png"), "file:///%C3%A9%23%3F%25.png");
        assert_eq!(url_path(&file_url(NEW)).as_deref(), Some(NEW));
    }

    #[test]
    fn url_path_rejects_non_file_and_bad_escapes() {
        assert_eq!(url_path("https://example.com/a.png"), None);
        assert_eq!(url_path("file:///a%2"), None);
        assert_eq!(url_path("file:///a%zz"), None);
        assert_eq!(url_path("file://localhost/a%20b").as_deref(), Some("/a b"));
    }

    #[test]
    fn every_space_and_display_shows_the_new_image_using_the_os_written_entry() {
        let store = encode(&sonoma_store(image_choice(NEW, b"cfg-new")), true);
        let rewrite = rewrite_store(&store, NEW).unwrap();

        assert_eq!(rewrite.source, TemplateSource::NewImage);
        assert_eq!(rewrite.entries, 7);
        assert_eq!(
            rewrite.changed, 4,
            "the three current-Space entries already showed NEW"
        );
        assert!(
            rewrite.bytes.starts_with(b"bplist"),
            "binary in, binary out"
        );

        let root = decode(&rewrite.bytes);
        assert!(shown_paths(&root).iter().all(|p| p.as_deref() == Some(NEW)));
        // The OS-written configuration is what every entry now carries.
        let cfg = root["Spaces"].as_dictionary().unwrap()["SPACE-2"]
            .as_dictionary()
            .unwrap()["Default"]
            .as_dictionary()
            .and_then(desktop_content)
            .unwrap()["Choices"]
            .as_array()
            .unwrap()[0]
            .as_dictionary()
            .unwrap()["Configuration"]
            .clone();
        assert_eq!(cfg, Value::Data(b"cfg-new".to_vec()));
    }

    #[test]
    fn leaves_system_default_idle_type_and_unknown_keys_alone() {
        let mut store = sonoma_store(image_choice(NEW, b"cfg-new"));
        store
            .as_dictionary_mut()
            .unwrap()
            .insert("FutureKey".into(), Value::Integer(7.into()));
        let rewrite = rewrite_store(&encode(&store, false), NEW).unwrap();
        let root = decode(&rewrite.bytes);

        assert_eq!(
            system_default_path(&root).as_deref(),
            Some("/System/default.heic")
        );
        assert_eq!(root["FutureKey"], Value::Integer(7.into()));
        let all = root["AllSpacesAndDisplays"].as_dictionary().unwrap();
        assert_eq!(all["Type"], Value::String("individual".into()));
        assert_eq!(
            all["Idle"].as_dictionary().unwrap()["Content"],
            Value::String("screen saver".into())
        );
        assert_eq!(
            all["Desktop"].as_dictionary().unwrap()["LastSet"],
            Value::String("2025-01-01".into())
        );
        assert!(!rewrite.bytes.starts_with(b"bplist"), "XML in, XML out");
    }

    #[test]
    fn models_on_an_existing_image_entry_when_the_new_one_has_not_landed() {
        let store = encode(&sonoma_store(image_choice(OLD, b"cfg-old")), true);
        let rewrite = rewrite_store(&store, NEW).unwrap();

        assert_eq!(rewrite.source, TemplateSource::OtherImage);
        assert_eq!(rewrite.changed, 7);
        let root = decode(&rewrite.bytes);
        assert!(shown_paths(&root).iter().all(|p| p.as_deref() == Some(NEW)));
        assert!(records_image(&rewrite.bytes, NEW));
    }

    #[test]
    fn records_image_reports_whether_the_os_has_persisted_the_new_image() {
        assert!(records_image(
            &encode(&sonoma_store(image_choice(NEW, b"c")), true),
            NEW
        ));
        assert!(!records_image(
            &encode(&sonoma_store(image_choice(OLD, b"c")), true),
            NEW
        ));
        assert!(!records_image(b"", NEW));
        assert!(!records_image(b"garbage", NEW));
    }

    #[test]
    fn refuses_a_store_with_only_non_image_wallpapers() {
        let store = dict(vec![
            ("AllSpacesAndDisplays", entry(aerial_choice())),
            (
                "Spaces",
                dict(vec![("S", dict(vec![("Default", entry(aerial_choice()))]))]),
            ),
        ]);
        assert_eq!(
            rewrite_store(&encode(&store, true), NEW),
            Err(StoreError::NoImageTemplate)
        );
    }

    #[test]
    fn refuses_malformed_or_empty_input() {
        assert!(matches!(
            rewrite_store(b"", NEW),
            Err(StoreError::Malformed(_))
        ));
        assert!(matches!(
            rewrite_store(b"bplist00\x01\x02", NEW),
            Err(StoreError::Malformed(_))
        ));
        assert!(matches!(
            rewrite_store(b"<plist><dict>", NEW),
            Err(StoreError::Malformed(_))
        ));
    }

    #[test]
    fn refuses_unrecognised_layouts() {
        // Not a dictionary.
        let arr = Value::Array(vec![Value::String("x".into())]);
        assert_eq!(
            rewrite_store(&encode(&arr, true), NEW),
            Err(StoreError::UnrecognisedLayout)
        );
        // An empty dictionary (fresh or future format version).
        let empty = Value::Dictionary(Dictionary::new());
        assert_eq!(
            rewrite_store(&encode(&empty, true), NEW),
            Err(StoreError::UnrecognisedLayout)
        );
        // The entry exists but its shape changed (e.g. Choices renamed).
        let changed = dict(vec![(
            "AllSpacesAndDisplays",
            dict(vec![(
                "Desktop",
                dict(vec![(
                    "Content",
                    dict(vec![("Options", Value::Array(vec![]))]),
                )]),
            )]),
        )]);
        assert_eq!(
            rewrite_store(&encode(&changed, true), NEW),
            Err(StoreError::UnrecognisedLayout)
        );
        // Entries only under SystemDefault are not ours to change.
        let only_default = dict(vec![
            ("AllSpacesAndDisplays", Value::Dictionary(Dictionary::new())),
            ("SystemDefault", entry(image_choice(OLD, b"c"))),
        ]);
        assert_eq!(
            rewrite_store(&encode(&only_default, true), NEW),
            Err(StoreError::UnrecognisedLayout)
        );
    }

    #[test]
    fn ignores_image_choices_without_a_configuration_or_with_several_files() {
        let mut bad = image_choice(OLD, b"c").into_dictionary().unwrap();
        bad.remove("Configuration");
        let mut two = image_choice(OLD, b"c").into_dictionary().unwrap();
        let file = two["Files"].as_array().unwrap()[0].clone();
        two.insert("Files".into(), Value::Array(vec![file.clone(), file]));
        let store = dict(vec![
            ("AllSpacesAndDisplays", entry(Value::Dictionary(bad))),
            ("Displays", dict(vec![("D", entry(Value::Dictionary(two)))])),
        ]);
        assert_eq!(
            rewrite_store(&encode(&store, true), NEW),
            Err(StoreError::NoImageTemplate)
        );
    }

    #[test]
    fn a_store_already_showing_the_new_image_everywhere_reports_no_changes() {
        let store = dict(vec![(
            "AllSpacesAndDisplays",
            entry(image_choice(NEW, b"c")),
        )]);
        let rewrite = rewrite_store(&encode(&store, true), NEW).unwrap();
        assert_eq!((rewrite.entries, rewrite.changed), (1, 0));
    }

    #[test]
    fn deep_unknown_nesting_is_not_walked_without_bound() {
        let mut deep = entry(image_choice(OLD, b"c"));
        for i in 0..20 {
            deep = dict(vec![(if i % 2 == 0 { "x" } else { "y" }, deep)]);
        }
        let store = dict(vec![
            ("AllSpacesAndDisplays", entry(image_choice(NEW, b"c"))),
            ("Spaces", deep),
        ]);
        let rewrite = rewrite_store(&encode(&store, true), NEW).unwrap();
        assert_eq!(
            rewrite.entries, 1,
            "the buried entry is out of reach and untouched"
        );
    }
}

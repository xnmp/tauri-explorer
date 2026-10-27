use super::*;
use serde_json::Value;
use std::sync::Arc;

fn fixtures() -> Vec<Value> {
    serde_json::from_str(include_str!("../../tests/fixtures/directory-wire.json")).unwrap()
}

fn listing(value: &Value) -> DirectoryListing {
    DirectoryListing {
        path: value["path"].as_str().unwrap().into(),
        entries: Arc::new(serde_json::from_value(value["entries"].clone()).unwrap()),
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn entry(name: &str, path: &str) -> FileEntry {
    FileEntry {
        name: name.into(),
        path: path.into(),
        kind: FileKind::File,
        size: 0,
        modified: String::new(),
        is_symlink: false,
        symlink_target: None,
        is_empty: None,
        is_git_repo: false,
    }
}

/// The TypeScript decoder and the browser mock's encoder are tested against
/// the same bytes, so the three cannot drift apart unnoticed (#868).
/// `UPDATE_DIRECTORY_WIRE_FIXTURE=1` prints the current bytes instead.
#[test]
fn native_bytes_match_the_shared_decoder_contract() {
    let update = std::env::var("UPDATE_DIRECTORY_WIRE_FIXTURE").is_ok();
    for fixture in fixtures() {
        let body = encode_listing(&listing(&fixture["listing"]), NoExtra {});
        if update {
            println!("WIRE {}", hex(&body));
        } else {
            assert_eq!(hex(&body), fixture["wire"].as_str().unwrap());
        }
    }
}

#[test]
fn the_header_describes_every_column_and_carries_extra_fields() {
    #[derive(Serialize)]
    struct Extra {
        watch_lease: &'static str,
    }
    let body = encode_listing(
        &DirectoryListing {
            path: "/d".into(),
            entries: Arc::new(vec![entry("é", "/d/é"), entry("a", "/d/a")]),
        },
        Extra { watch_lease: "L" },
    );
    let header = header_of(&body);
    assert_eq!(header["path_prefix"], "/d/");
    assert_eq!(header["count"], 2);
    // ASCII names, other names, modified, paths (prefixed), targets.
    assert_eq!(header["bytes"], serde_json::json!([1, 2, 0, 0, 0]));
    assert_eq!(header["watch_lease"], "L");
    let header_len = u32::from_le_bytes(body[4..8].try_into().unwrap()) as usize;
    let rows = &body[8 + header_len..];
    // sizes, name units, modified units, flags, then "a", "é".
    assert_eq!(rows.len(), 2 * (8 + 4 + 4 + 1) + 1 + 2);
    assert_eq!(&rows[16..20], &1u32.to_le_bytes(), "é is one UTF-16 unit");
    assert_eq!(rows[32], FLAG_WIDE_NAME);
    assert_eq!(rows[33], 0);
    assert_eq!(&rows[34..], "aé".as_bytes());
}

#[test]
fn a_single_nonmatching_path_disables_prefix_factoring_for_every_row() {
    let body = encode_listing(
        &DirectoryListing {
            path: "/requested".into(),
            entries: Arc::new(vec![entry("one", "/a/one"), entry("two", "/b/two")]),
        },
        NoExtra {},
    );
    let header = header_of(&body);
    assert!(header["path_prefix"].is_null());
    assert_eq!(header["bytes"][3], "/a/one/b/two".len());
    assert!(body.ends_with(b"onetwo/a/one/b/two"));
}

#[test]
fn utf16_lengths_count_surrogate_pairs() {
    assert_eq!(utf16_len("plain"), 5);
    assert_eq!(utf16_len("雪"), 1);
    assert_eq!(utf16_len("😀"), 2);
    assert_eq!(utf16_len(""), 0);
    assert_eq!(utf16_len(&"日本語😀é".repeat(400)), 2_400);
    assert_eq!(utf16_len(&"a".repeat(4_096)), 4_096);
}

#[test]
fn a_large_listing_encodes_every_row() {
    let entries: Vec<FileEntry> = (0..100_000)
        .map(|i| entry(&format!("entry-{i}"), &format!("/big/entry-{i}")))
        .collect();
    let names: usize = entries.iter().map(|e| e.name.len()).sum();
    let body = encode_listing(
        &DirectoryListing {
            path: "/big".into(),
            entries: Arc::new(entries),
        },
        NoExtra {},
    );
    let header = header_of(&body);
    assert_eq!(header["count"], 100_000);
    assert_eq!(header["bytes"][0], names);
    assert!(body.ends_with(b"entry-99999"));
}

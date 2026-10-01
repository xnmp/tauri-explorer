use super::*;
use serde_json::{json, Value};
use std::sync::Arc;

#[test]
fn native_columns_match_the_shared_decoder_contract() {
    let fixtures: Vec<Value> =
        serde_json::from_str(include_str!("../../tests/fixtures/directory-wire.json")).unwrap();
    for fixture in fixtures {
        let listing = DirectoryListing {
            path: fixture["listing"]["path"].as_str().unwrap().into(),
            entries: Arc::new(
                serde_json::from_value(fixture["listing"]["entries"].clone()).unwrap(),
            ),
        };
        assert_eq!(serde_json::to_value(&listing).unwrap(), fixture["wire"]);
    }
}

#[test]
fn a_single_nonmatching_path_disables_prefix_factoring_for_every_row() {
    let entries = ["/a/one", "/b/two"]
        .into_iter()
        .map(|path| FileEntry {
            name: path.rsplit('/').next().unwrap().into(),
            path: path.into(),
            kind: super::super::FileKind::File,
            size: 0,
            modified: String::new(),
            is_symlink: false,
            symlink_target: None,
            is_empty: None,
            is_git_repo: false,
        })
        .collect();
    let value = serde_json::to_value(DirectoryListing {
        path: "/requested".into(),
        entries: Arc::new(entries),
    })
    .unwrap();
    assert!(value["path_prefix"].is_null());
    assert_eq!(value["columns"]["paths"], json!(["/a/one", "/b/two"]));
}

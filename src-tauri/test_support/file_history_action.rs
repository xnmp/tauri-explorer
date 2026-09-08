use super::{affected_dirs, prepare, Action};
use std::path::Path;

fn absolute(parts: &[&str]) -> String {
    parts
        .iter()
        .fold(
            std::env::temp_dir().join("file-history-action"),
            |base, part| base.join(part),
        )
        .to_string_lossy()
        .into_owned()
}

fn copy(path: String, parent_dir: String, restore_supported: bool) -> Action {
    Action::Copy {
        copied_path: path,
        parent_dir,
        restore_supported,
    }
}

fn prepared(action: Action, trash_restore: bool) -> Action {
    prepare(action, trash_restore).unwrap().unwrap()
}

#[cfg(windows)]
fn unc_path() -> String {
    r"\\server\share\unrestorable.txt".into()
}

#[test]
fn host_capability_overwrites_a_forged_copy_restore_flag() {
    let path = absolute(&["copies", "report.txt"]);
    let parent = absolute(&["copies"]);
    let caller_denied = copy(path.clone(), parent.clone(), false);
    assert_eq!(
        prepared(caller_denied, true),
        copy(path.clone(), parent.clone(), true)
    );

    let caller_claimed = copy(path.clone(), parent.clone(), true);
    assert_eq!(prepared(caller_claimed, false), copy(path, parent, false));
}

#[test]
#[cfg(windows)]
fn host_prunes_unrecoverable_delete_paths_and_empty_nested_batches() {
    let local = absolute(&["trash", "local.txt"]);
    let parent = absolute(&["trash"]);
    let remote = unc_path();
    let action = Action::Batch {
        label: "mixed".into(),
        actions: vec![
            Action::Delete {
                paths: vec![remote.clone()],
                parent_dir: parent.clone(),
            },
            Action::Batch {
                label: "nested".into(),
                actions: vec![Action::Delete {
                    paths: vec![local.clone(), remote],
                    parent_dir: parent.clone(),
                }],
            },
        ],
    };

    assert_eq!(
        prepared(action, true),
        Action::Batch {
            label: "mixed".into(),
            actions: vec![Action::Batch {
                label: "nested".into(),
                actions: vec![Action::Delete {
                    paths: vec![local],
                    parent_dir: parent,
                }],
            }],
        }
    );
}

#[test]
#[cfg(unix)]
fn double_leading_slash_is_a_local_trash_path() {
    let path = "//local/directory/item.txt".to_owned();
    let parent = "//local/directory".to_owned();
    let action = Action::Delete {
        paths: vec![path.clone()],
        parent_dir: parent.clone(),
    };
    assert_eq!(prepared(action.clone(), true), action);
    assert_eq!(
        prepared(copy(path.clone(), parent.clone(), false), true),
        copy(path, parent, true)
    );
}

#[test]
fn unavailable_trash_restore_prunes_delete_actions_completely() {
    let parent = absolute(&["trash"]);
    let action = Action::Delete {
        paths: vec![
            absolute(&["trash", "one.txt"]),
            absolute(&["trash", "two.txt"]),
        ],
        parent_dir: parent,
    };

    assert_eq!(prepare(action, false).unwrap(), None);
}

#[test]
fn malformed_or_non_absolute_paths_are_rejected() {
    let valid_parent = absolute(&["valid"]);
    let cases = [
        copy("relative/file.txt".into(), valid_parent.clone(), true),
        copy(absolute(&["valid", "file.txt"]), "relative".into(), true),
        copy(
            format!("{}\0suffix", absolute(&["valid", "file.txt"])),
            valid_parent,
            true,
        ),
        Action::Move {
            source_path: absolute(&["source", "file.txt"]),
            dest_path: String::new(),
            original_dir: absolute(&["source"]),
        },
    ];

    for action in cases {
        assert!(prepare(action, true)
            .unwrap_err()
            .contains("absolute paths"));
    }
}

#[test]
fn malformed_rename_names_are_rejected() {
    let path = absolute(&["rename", "new.txt"]);
    for name in ["", ".", "..", "nested/name", r"nested\name", "nul\0name"] {
        let action = Action::Rename {
            path: path.clone(),
            old_name: "old.txt".into(),
            new_name: name.into(),
        };
        assert!(prepare(action, true)
            .unwrap_err()
            .contains("Invalid file history entry name"));
    }
}

#[test]
fn recursive_depth_limit_rejects_an_excessively_nested_batch() {
    let mut action = copy(absolute(&["deep", "file.txt"]), absolute(&["deep"]), true);
    for depth in 0..65 {
        action = Action::Batch {
            actions: vec![action],
            label: format!("level {depth}"),
        };
    }

    assert!(prepare(action, true).unwrap_err().contains("too large"));
}

#[test]
fn node_limit_counts_each_path_in_a_delete_action() {
    let path = absolute(&["many", "file.txt"]);
    let action = Action::Delete {
        paths: vec![path; 100_000],
        parent_dir: absolute(&["many"]),
    };

    assert!(prepare(action, true).unwrap_err().contains("too large"));
}

#[test]
fn retained_allocation_limit_rejects_one_oversized_action() {
    let oversized = format!(
        "{}{}",
        absolute(&["large", ""]),
        "x".repeat(33 * 1024 * 1024)
    );
    let action = copy(oversized, absolute(&["large"]), true);

    assert!(prepare(action, true).unwrap_err().contains("memory budget"));
}

#[test]
fn affected_directories_are_distinct_parents_derived_from_effect_paths() {
    let rename_path = absolute(&["rename-parent", "renamed.txt"]);
    let move_source = absolute(&["move-source", "item.txt"]);
    let move_dest = absolute(&["move-destination", "item.txt"]);
    let copied_path = absolute(&["copy-parent", "copy.txt"]);
    let deleted_one = absolute(&["delete-one", "a.txt"]);
    let deleted_two = absolute(&["delete-two", "b.txt"]);
    let forged_parent = absolute(&["forged-metadata"]);
    let action = Action::Batch {
        label: "affected directories".into(),
        actions: vec![
            Action::Rename {
                path: rename_path.clone(),
                old_name: "old.txt".into(),
                new_name: "renamed.txt".into(),
            },
            Action::Move {
                source_path: move_source.clone(),
                dest_path: move_dest.clone(),
                original_dir: forged_parent.clone(),
            },
            copy(copied_path.clone(), forged_parent.clone(), true),
            Action::Delete {
                paths: vec![
                    deleted_one.clone(),
                    deleted_two.clone(),
                    deleted_one.clone(),
                ],
                parent_dir: forged_parent.clone(),
            },
        ],
    };
    let mut expected = vec![
        rename_path,
        move_source,
        move_dest,
        copied_path,
        deleted_one,
        deleted_two,
    ]
    .into_iter()
    .map(|path| {
        Path::new(&path)
            .parent()
            .unwrap()
            .to_string_lossy()
            .into_owned()
    })
    .collect::<Vec<_>>();
    expected.sort();
    expected.dedup();

    let actual = affected_dirs(&action);
    assert_eq!(actual, expected);
    assert!(!actual.contains(&forged_parent));
}

#[test]
#[cfg(windows)]
fn extended_local_disks_remain_restorable_but_network_shares_do_not() {
    for path in [r"\\?\C:\folder\item.txt", r"C:\folder\item.txt"] {
        let action = Action::Delete {
            paths: vec![path.into()],
            parent_dir: r"C:\folder".into(),
        };
        assert_eq!(prepared(action.clone(), true), action);
    }
    for path in [r"\\?\UNC\server\share\item.txt", r"\\server\share\item.txt"] {
        let action = Action::Delete {
            paths: vec![path.into()],
            parent_dir: r"\\server\share".into(),
        };
        assert_eq!(prepare(action, true).unwrap(), None);
    }
}

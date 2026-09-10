use super::*;
use std::os::unix::fs::symlink;

#[cfg(target_os = "linux")]
#[test]
#[ignore = "requires a dedicated unshare --user --map-root-user --mount namespace"]
fn real_bind_mount_aliases_preserve_missing_destination_ownership() {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    assert_eq!(
        std::env::var("TAURI_RECOVERY_BIND_MOUNT_TEST").as_deref(),
        Ok("1")
    );
    assert_ne!(
        fs::read_link("/proc/self/ns/mnt").unwrap(),
        fs::read_link("/proc/1/ns/mnt").unwrap()
    );
    let temporary = tempfile::tempdir().unwrap();
    let actual = temporary.path().join("actual");
    let alias = temporary.path().join("alias");
    fs::create_dir(&actual).unwrap();
    fs::create_dir(&alias).unwrap();
    let source = CString::new(actual.as_os_str().as_bytes()).unwrap();
    let target = CString::new(alias.as_os_str().as_bytes()).unwrap();
    // SAFETY: both strings remain live; this opt-in helper runs in an isolated
    // private mount namespace and binds only two newly created empty directories.
    let mounted = unsafe {
        libc::mount(
            source.as_ptr(),
            target.as_ptr(),
            std::ptr::null(),
            libc::MS_BIND,
            std::ptr::null(),
        )
    };
    assert_eq!(
        mounted,
        0,
        "bind mount: {}",
        std::io::Error::last_os_error()
    );
    struct Mounted(CString);
    impl Drop for Mounted {
        fn drop(&mut self) {
            // SAFETY: the mount point string stays owned through unmount.
            unsafe {
                libc::umount2(self.0.as_ptr(), libc::MNT_DETACH);
            }
        }
    }
    let _mounted = Mounted(target);
    let first = capture(&actual.join("missing/file"), Access::Write, Scope::Subtree).unwrap();
    let second = capture(&alias.join("missing/file"), Access::Write, Scope::Subtree).unwrap();
    assert_ne!(
        first.path, second.path,
        "canonicalization must preserve the bind alias in this reproduction"
    );
    assert!(conflicts(&first, &second));
    assert!(conflicts(&second, &first));
    let sibling = capture(
        &alias.join("missing/sibling"),
        Access::Write,
        Scope::Subtree,
    )
    .unwrap();
    assert!(!conflicts(&first, &sibling));
    fs::create_dir(actual.join("missing")).unwrap();
    let materialized = capture(&actual.join("missing/file"), Access::Write, Scope::Entry).unwrap();
    assert!(conflicts(&second, &materialized));
    assert!(conflicts(&materialized, &second));
}

fn conflicts(first: &Resource, second: &Resource) -> bool {
    let mut index = ConflictIndex::default();
    index.insert(first);
    index.conflicts(second)
}

#[test]
fn missing_names_share_ownership_across_physical_parent_aliases() {
    let temporary = tempfile::tempdir().unwrap();
    let physical = temporary.path().join("actual");
    fs::create_dir(&physical).unwrap();
    let original = capture(
        &physical.join("missing/file"),
        Access::Write,
        Scope::Subtree,
    )
    .unwrap();
    // A second mount/drive spelling can expose the same parent identity without
    // canonicalize changing the spelling. Supply that native observation to the
    // production domain index; no privileged mount is needed for this contract.
    let alias = Resource {
        path: NativePath(temporary.path().join("alias/missing/file")),
        ..original.clone()
    };
    assert!(conflicts(&original, &alias));
    assert!(conflicts(&alias, &original));
    let sibling = Resource {
        path: NativePath(temporary.path().join("alias/missing/other")),
        ..alias.clone()
    };
    assert!(!conflicts(&original, &sibling));

    fs::create_dir(physical.join("missing")).unwrap();
    let materialized =
        capture(&physical.join("missing/file"), Access::Write, Scope::Entry).unwrap();
    assert!(conflicts(&alias, &materialized));
    assert!(conflicts(&materialized, &alias));

    fs::create_dir(temporary.path().join("unrelated")).unwrap();
    let unrelated = capture(
        &temporary.path().join("unrelated/missing/file"),
        Access::Write,
        Scope::Subtree,
    )
    .unwrap();
    assert!(!conflicts(&original, &unrelated));
}

#[test]
fn physical_namespace_prefixes_preserve_subtree_and_read_sharing_rules() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path();
    fs::create_dir(root.join("actual")).unwrap();
    let parent = capture(&root.join("actual/missing"), Access::Read, Scope::Subtree).unwrap();
    let child = Resource {
        path: NativePath(root.join("alias/missing/file")),
        ..parent.clone()
    };
    assert!(!conflicts(&parent, &child));
    let writer = Resource {
        access: Access::Write,
        ..child
    };
    assert!(conflicts(&parent, &writer));
    assert!(conflicts(&writer, &parent));
    let sibling = Resource {
        path: NativePath(root.join("alias/missing-sibling")),
        ..writer
    };
    assert!(!conflicts(&parent, &sibling));

    let nested = Resource {
        path: NativePath(root.join("actual/missing/a")),
        ..parent.clone()
    };
    for claims in [[&parent, &nested], [&nested, &parent]] {
        let mut index = ConflictIndex::default();
        for claim in claims {
            index.insert(claim);
        }
        let later_child = Resource {
            path: NativePath(root.join("alias/missing/z")),
            access: Access::Write,
            scope: Scope::Entry,
            ..parent.clone()
        };
        assert!(index.conflicts(&later_child));
        assert!(!index.conflicts(&sibling));
    }
}

#[test]
fn maximum_claim_fanout_keeps_alias_matches_and_unrelated_siblings_distinct() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path();
    fs::create_dir(root.join("actual")).unwrap();
    let captured = capture(&root.join("actual/missing"), Access::Write, Scope::Entry).unwrap();
    // A bounded projection keeps this domain load independent of the host's
    // temporary-directory depth and the aggregate native-record budget.
    let seed = Resource {
        path: NativePath(PathBuf::from("/actual/missing")),
        ancestors: vec![captured.ancestors[0], *captured.ancestors.last().unwrap()],
        ..captured
    };
    let resources: Vec<_> = (0..MAX_CLAIMS)
        .map(|index| Resource {
            path: NativePath(PathBuf::from(format!("/actual/entry-{index}"))),
            ..seed.clone()
        })
        .collect();
    validate(&resources).unwrap();
    let mut index = ConflictIndex::default();
    for resource in &resources {
        index.insert(resource);
    }
    for number in 0..MAX_CLAIMS {
        let alias = Resource {
            path: NativePath(PathBuf::from(format!("/alias/entry-{number}"))),
            access: Access::Read,
            ..seed.clone()
        };
        assert!(index.conflicts(&alias));
    }
    let absent = Resource {
        path: NativePath(PathBuf::from("/alias/unrelated")),
        ..seed
    };
    assert!(!index.conflicts(&absent));
}

#[test]
fn indexed_conflicts_match_path_contract_for_mixed_native_names() {
    use std::{ffi::OsString, os::unix::ffi::OsStringExt};
    let mut paths: Vec<PathBuf> = [
        "/a", "/a/b", "/a/b/c", "/a/z", "/a!", "/a-/b", "/a.more", "/a//b/", "/a/./b", "/A/b",
        "/b", "/b/a", "/b/a/z",
    ]
    .into_iter()
    .map(PathBuf::from)
    .collect();
    for bytes in [
        b"/a/\x01".as_slice(),
        b"/a/\xff",
        b"/a/\xff/child",
        b"/a/line\nbreak",
    ] {
        paths.push(PathBuf::from(OsString::from_vec(bytes.to_vec())));
    }
    let candidates: Vec<_> = paths
        .into_iter()
        .flat_map(|path| {
            [Access::Read, Access::Write]
                .into_iter()
                .flat_map(move |access| {
                    let path = path.clone();
                    [Scope::Entry, Scope::Subtree]
                        .into_iter()
                        .map(move |scope| Resource {
                            path: NativePath(path.clone()),
                            object: None,
                            // Only the root exists; all names are missing suffixes.
                            ancestors: vec![ObjectId::unix(1, 1)],
                            access,
                            scope,
                        })
                })
        })
        .collect();
    validate(&candidates).unwrap();
    let overlaps = |left: &Resource, right: &Resource| {
        (left.access == Access::Write || right.access == Access::Write)
            && (left.path.0 == right.path.0
                || left.scope == Scope::Subtree && right.path.0.starts_with(&left.path.0)
                || right.scope == Scope::Subtree && left.path.0.starts_with(&right.path.0))
    };
    // Multiple insertion orders exercise both wider and narrower subtree admission.
    for seed in 0..candidates.len() {
        let mut index = ConflictIndex::default();
        let mut accepted = Vec::new();
        for step in 0..12 {
            let claim = &candidates[(seed + step * 17) % candidates.len()];
            index.insert(claim);
            accepted.push(claim);
            for query in &candidates {
                assert_eq!(
                    index.conflicts(query),
                    accepted.iter().any(|claim| overlaps(claim, query)),
                    "seed={seed}, step={step}, query={query:?}"
                );
            }
        }
    }
}

#[test]
fn deep_claims_near_the_record_budget_preserve_alias_and_sibling_outcomes() {
    let parent: PathBuf = std::iter::once(PathBuf::from("/"))
        .chain((0..MAX_DEPTH - 2).map(|n| PathBuf::from(format!("d{n}"))))
        .collect();
    let ancestors: Vec<_> = (0..MAX_DEPTH - 1)
        .map(|n| ObjectId::unix(1, n as u64 + 1))
        .collect();
    let maximum_path = parent.join(format!("entry-{MAX_CLAIMS}"));
    let count = MAX_RESOURCE_BYTES / add_budget(0, &maximum_path, ancestors.len()).unwrap();
    let resources: Vec<_> = (0..count)
        .map(|n| Resource {
            path: NativePath(parent.join(format!("entry-{n}"))),
            object: None,
            ancestors: ancestors.clone(),
            access: Access::Write,
            scope: Scope::Subtree,
        })
        .collect();
    validate(&resources).unwrap();
    let started = std::time::Instant::now();
    let mut index = ConflictIndex::default();
    for resource in &resources {
        index.insert(resource);
    }
    let built = started.elapsed();
    let alias_parent = Path::new("/alias").join(parent.strip_prefix("/d0").unwrap());
    for n in [0, count / 2, count - 1] {
        let alias = Resource {
            path: NativePath(alias_parent.join(format!("entry-{n}"))),
            ..resources[n].clone()
        };
        assert!(index.conflicts(&alias));
    }
    let sibling = Resource {
        path: NativePath(alias_parent.join("unrelated")),
        ..resources[0].clone()
    };
    assert!(!index.conflicts(&sibling));
    eprintln!(
        "deep resource load: {count} claims, {} ancestors, build={built:?}, total={:?}",
        ancestors.len(),
        started.elapsed()
    );
}

#[test]
fn sibling_mutations_coexist_but_parent_moves_conflict() {
    let temporary = tempfile::tempdir().unwrap();
    let parent = temporary.path().join("parent");
    fs::create_dir(&parent).unwrap();
    let a = capture(&parent.join("a"), Access::Write, Scope::Subtree).unwrap();
    let b = capture(&parent.join("b"), Access::Write, Scope::Subtree).unwrap();
    let ancestor = capture(&parent, Access::Write, Scope::Subtree).unwrap();
    assert!(!conflicts(&a, &b));
    assert!(conflicts(&a, &ancestor));
    assert!(conflicts(&ancestor, &b));
}

#[test]
fn parent_aliases_and_hardlinked_entries_share_ownership() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path();
    fs::create_dir(root.join("actual")).unwrap();
    symlink("actual", root.join("alias")).unwrap();
    fs::write(root.join("actual/a"), b"same inode").unwrap();
    fs::hard_link(root.join("actual/a"), root.join("hardlink")).unwrap();
    let read = capture(&root.join("alias/a"), Access::Read, Scope::Subtree).unwrap();
    let write = capture(&root.join("actual/a"), Access::Write, Scope::Subtree).unwrap();
    let linked = capture(&root.join("hardlink"), Access::Write, Scope::Subtree).unwrap();
    assert!(conflicts(&read, &write));
    assert!(conflicts(&read, &linked));
    let missing_alias = capture(
        &root.join("alias/missing/leaf"),
        Access::Write,
        Scope::Subtree,
    )
    .unwrap();
    let missing_real = capture(
        &root.join("actual/missing/leaf"),
        Access::Write,
        Scope::Subtree,
    )
    .unwrap();
    assert!(conflicts(&missing_alias, &missing_real));
}

#[test]
fn removing_a_symlink_does_not_claim_its_target() {
    let temporary = tempfile::tempdir().unwrap();
    fs::write(temporary.path().join("target"), b"bytes").unwrap();
    symlink("target", temporary.path().join("link")).unwrap();
    let link = capture(
        &temporary.path().join("link"),
        Access::Write,
        Scope::Subtree,
    )
    .unwrap();
    let target = capture(
        &temporary.path().join("target"),
        Access::Write,
        Scope::Subtree,
    )
    .unwrap();
    assert!(!conflicts(&link, &target));
}

#[test]
fn read_only_subtrees_share_and_component_prefixes_do_not_overlap() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path();
    fs::create_dir(root.join("dir")).unwrap();
    let read = capture(&root.join("dir"), Access::Read, Scope::Subtree).unwrap();
    let nested = capture(&root.join("dir/file"), Access::Read, Scope::Entry).unwrap();
    let sibling = capture(&root.join("dir-file"), Access::Write, Scope::Subtree).unwrap();
    assert!(!conflicts(&read, &nested));
    assert!(!conflicts(&read, &sibling));
    let write = Resource {
        access: Access::Write,
        ..nested
    };
    assert!(conflicts(&read, &write));
}

#[test]
fn malformed_resources_are_rejected_before_capture() {
    for path in ["relative", "/tmp/../elsewhere", "/tmp/\0bad"] {
        assert!(capture(Path::new(path), Access::Write, Scope::Entry).is_err());
    }
    assert!(validate(&[]).is_err());
    for (path, count) in [("/", 1), ("/entry", 0), ("/entry", 2), ("/a/entry", 3)] {
        let resource = Resource {
            path: NativePath(PathBuf::from(path)),
            object: None,
            ancestors: vec![ObjectId::unix(1, 1); count],
            access: Access::Write,
            scope: Scope::Entry,
        };
        assert!(
            validate(&[resource]).is_err(),
            "invalid ancestry: {path}, {count}"
        );
    }
}

#[test]
fn aggregate_resources_are_rejected_before_serialization_or_filesystem_probes() {
    let path = PathBuf::from(format!("/{}", "x".repeat(128 * 1024 - 1)));
    let resource = Resource {
        path: NativePath(path.clone()),
        object: None,
        ancestors: vec![object(&fs::metadata("/").unwrap())],
        access: Access::Write,
        scope: Scope::Entry,
    };
    let resources = vec![resource; 129];
    let error = validate(&resources).expect_err("aggregate paths exceed the record budget");
    assert!(error.to_string().contains("budget"));
    let requests = vec![
        Request {
            path,
            access: Access::Write,
            scope: Scope::Entry
        };
        129
    ];
    let error = capture_requests(&requests)
        .expect_err("reject before attempting impossible filesystem names");
    assert!(error.to_string().contains("budget"));
}

#[test]
fn selection_allows_distinct_hardlinks_but_rejects_namespace_and_directory_aliases() {
    let root = tempfile::tempdir().unwrap();
    let a = root.path().join("a");
    let b = root.path().join("b");
    fs::write(&a, b"same inode").unwrap();
    fs::hard_link(&a, &b).unwrap();
    let first = capture(&a, Access::Write, Scope::Subtree).unwrap();
    let second = capture(&b, Access::Write, Scope::Subtree).unwrap();
    let mut index = SelectionIndex::default();
    index
        .insert(&first, SelectionRole::Source { directory: false })
        .unwrap();
    index
        .insert(&second, SelectionRole::Source { directory: false })
        .unwrap();
    assert!(index
        .insert(&first, SelectionRole::Source { directory: false })
        .is_err());
    // Inter-operation admission must remain conservative for these writers.
    assert!(conflicts(&first, &second));
    fs::create_dir(root.path().join("dir")).unwrap();
    let directory = capture(&root.path().join("dir"), Access::Write, Scope::Subtree).unwrap();
    let alias = Resource {
        path: NativePath(root.path().join("bind-dir")),
        ..directory.clone()
    };
    let mut index = SelectionIndex::default();
    index
        .insert(&directory, SelectionRole::Source { directory: true })
        .unwrap();
    assert!(index
        .insert(&alias, SelectionRole::Source { directory: true })
        .is_err());
}

#[test]
fn selection_excludes_physical_sources_from_artifact_containers_in_both_orders() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("directory");
    fs::create_dir(&directory).unwrap();
    let container = capture(&directory, Access::Read, Scope::Subtree).unwrap();
    let child = capture(
        &directory.join("missing/entry"),
        Access::Write,
        Scope::Subtree,
    )
    .unwrap();
    let alias = Resource {
        path: NativePath(root.path().join("bind/missing/entry")),
        ..child.clone()
    };
    for reverse in [false, true] {
        let mut index = SelectionIndex::default();
        let mut entries = [
            (&container, SelectionRole::Container),
            (&alias, SelectionRole::Source { directory: false }),
        ];
        if reverse {
            entries.reverse();
        }
        index.insert(entries[0].0, entries[0].1).unwrap();
        assert!(index.insert(entries[1].0, entries[1].1).is_err());
    }
}

#[test]
fn selection_shares_layout_parents_but_keeps_artifact_names_exclusive() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("files");
    fs::create_dir(&directory).unwrap();
    let shared = capture(&directory, Access::Write, Scope::Entry).unwrap();
    let payload = capture(&directory.join("payload"), Access::Write, Scope::Subtree).unwrap();
    for reverse in [false, true] {
        let mut index = SelectionIndex::default();
        let mut entries = [
            (&shared, SelectionRole::Shared),
            (&payload, SelectionRole::Exclusive),
        ];
        if reverse {
            entries.reverse();
        }
        for (resource, role) in entries {
            index.insert(resource, role).unwrap();
        }
        index.insert(&shared, SelectionRole::Shared).unwrap();
        assert!(index.insert(&payload, SelectionRole::Exclusive).is_err());
        let mut duplicate = payload.clone();
        duplicate.scope = Scope::Entry;
        assert!(index.insert(&duplicate, SelectionRole::Shared).is_err());
    }
}

#[test]
fn repeated_shared_observations_do_not_consume_the_unique_claim_budget() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("directory");
    fs::create_dir(&directory).unwrap();
    let shared = capture(&directory, Access::Read, Scope::Entry).unwrap();
    let root_claim = Resource {
        scope: Scope::Subtree,
        ..shared.clone()
    };
    let mut index = SelectionIndex::default();
    for _ in 0..=MAX_CLAIMS {
        index.insert(&shared, SelectionRole::Shared).unwrap();
        index.insert(&root_claim, SelectionRole::Container).unwrap();
    }
    let destination = capture(&directory.join("payload"), Access::Write, Scope::Subtree).unwrap();
    index
        .insert(&destination, SelectionRole::Exclusive)
        .unwrap();
    assert!(index
        .insert(&destination, SelectionRole::Exclusive)
        .is_err());
}

#[test]
fn selection_rejects_excessive_unique_artifact_authority() {
    let root = tempfile::tempdir().unwrap();
    let mut candidate = capture(&root.path().join("payload"), Access::Write, Scope::Entry).unwrap();
    let mut index = SelectionIndex::default();
    let mut rejected = false;
    for number in 0..=MAX_CLAIMS {
        candidate.path = NativePath(root.path().join(format!("payload-{number}")));
        if index.insert(&candidate, SelectionRole::Exclusive).is_err() {
            rejected = true;
            break;
        }
    }
    assert!(
        rejected,
        "unique artifacts must obey aggregate claim/byte limits"
    );
    assert!(fs::read_dir(root.path()).unwrap().next().is_none());
}

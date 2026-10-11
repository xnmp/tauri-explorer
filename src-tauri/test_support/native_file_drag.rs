use super::*;

fn path(name: &str) -> String {
    if cfg!(target_os = "windows") {
        format!("C:\\source\\{name}")
    } else {
        format!("/source/{name}")
    }
}

fn source() -> Source {
    Source {
        session_id: "first".into(),
        path: path("a.png"),
        name: "a.png".into(),
        kind: "file".into(),
        paths: Some(vec![path("z.png"), path("a.png")]),
        native_copy_policy: Some(CopyPolicy::Modifier),
    }
}
fn paths() -> Vec<PathBuf> {
    vec![path("a.png").into(), path("z.png").into()]
}

#[test]
fn native_source_round_trip_preserves_source_copy_policy() {
    for policy in ["move", "modifier"] {
        let mut json = serde_json::to_value(source()).unwrap();
        json["nativeCopyPolicy"] = policy.into();
        let restored: Source = serde_json::from_value(json).unwrap();
        assert_eq!(
            serde_json::to_value(restored).unwrap()["nativeCopyPolicy"],
            policy
        );
    }
}

#[test]
fn receiver_event_carries_drop_time_modifiers_independently_of_source_policy() {
    for copying in [false, true] {
        let event = Event::Drop {
            paths: paths(),
            position: tauri::PhysicalPosition { x: 20.0, y: 30.0 },
            source: Some(source()),
            copy_modifier: Some(copying),
        };
        let json = serde_json::to_value(event).unwrap();
        assert_eq!(json["type"], "drop");
        assert_eq!(json["copyModifier"], copying);
        assert_eq!(json["source"]["nativeCopyPolicy"], "modifier");
    }
}

#[test]
fn queued_receiver_payloads_survive_source_completion_before_frontend_delivery() {
    let mut registry = Registry::default();
    registry.begin(1, "source-window".into(), Some(source()));
    let enter = registry.enter("receiver-window", &paths());
    registry.complete(1);
    let drop = registry.receive_drop("receiver-window", &paths());
    assert_eq!(enter, Some(source()));
    assert_eq!(drop, Some(source()));
    // A later external drag of the same files is never mistaken for the old source.
    assert_eq!(registry.enter("receiver-window", &paths()), None);
    assert_eq!(registry.receive_drop("receiver-window", &paths()), None);
}

#[test]
fn receiver_identity_is_replaced_and_full_native_sets_are_revalidated() {
    let mut registry = Registry::default();
    registry.begin(1, "source-window".into(), Some(source()));
    registry.enter("receiver-window", &paths());
    assert_eq!(
        registry.receive_drop("receiver-window", &[path("a.png").into()]),
        None
    );
    registry.enter("receiver-window", &paths());
    registry.leave("receiver-window");
    assert_eq!(registry.receive_drop("receiver-window", &paths()), None);
    registry.enter("receiver-window", &paths());
    registry.enter("receiver-window", &[path("external.png").into()]);
    assert_eq!(registry.receive_drop("receiver-window", &paths()), None);
}

#[test]
fn late_completion_and_window_disposal_do_not_retire_other_sources() {
    let mut registry = Registry::default();
    registry.begin(1, "first-window".into(), Some(source()));
    registry.begin(2, "second-window".into(), Some(source()));
    registry.complete(1);
    assert_eq!(registry.enter("receiver-window", &paths()), Some(source()));
    registry.destroyed("first-window");
    assert_eq!(registry.enter("receiver-window", &paths()), Some(source()));
    registry.destroyed("second-window");
    assert_eq!(registry.enter("receiver-window", &paths()), None);
}

#[test]
fn malformed_source_is_rejected_as_a_whole_and_multiplicity_is_preserved() {
    let original = source();
    for invalid in [
        Source {
            kind: "url".into(),
            ..original.clone()
        },
        Source {
            path: path("absent.png"),
            ..original.clone()
        },
        Source {
            paths: Some(vec![]),
            ..original.clone()
        },
        Source {
            paths: Some(vec![path("a.png"), "relative.png".into()]),
            ..original.clone()
        },
        Source {
            paths: Some(vec![path("a.png"), path("../a.png")]),
            ..original.clone()
        },
        Source {
            session_id: String::new(),
            ..original.clone()
        },
        Source {
            paths: Some(vec![path("a.png"), path("bad\0.png")]),
            ..original.clone()
        },
    ] {
        assert!(!matches(&invalid, &paths()));
    }
    let duplicates = Source {
        paths: Some(vec![original.path.clone(), original.path.clone()]),
        ..original.clone()
    };
    assert!(!matches(&duplicates, &[original.path.clone().into()]));
    assert!(matches(
        &duplicates,
        &[original.path.clone().into(), original.path.into()]
    ));
}

#[test]
fn filesystem_roots_can_drag_out_but_do_not_claim_explorer_receiver_identity() {
    let root = if cfg!(target_os = "windows") {
        "C:\\"
    } else {
        "/"
    };
    let source = Source {
        path: root.into(),
        paths: None,
        kind: "directory".into(),
        ..source()
    };
    let paths = vec![PathBuf::from(root)];
    // Preserve native OS drag-out admission; Explorer path admission excludes roots.
    assert!(matches(&source, &paths));
    let mut registry = Registry::default();
    registry.begin(1, "source-window".into(), Some(source));
    assert_eq!(registry.enter("receiver-window", &paths), None);
    assert_eq!(registry.receive_drop("receiver-window", &paths), None);
}

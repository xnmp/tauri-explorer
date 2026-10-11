use super::*;

#[test]
fn prepared_windows_link_transport_survives_link_deletion_or_retargeting() {
    let linked = Source {
        path: r"C:\source\Link".into(),
        paths: None,
        kind: "directory".into(),
        ..source()
    };
    let native = vec![PathBuf::from(r"C:\important")];
    let mut registry = Registry::default();
    registry.begin_prepared(1, "source".into(), Some(linked.clone()), &native, true);
    // Only the prepared transport is available. The original link may now
    // be deleted or point elsewhere; receiver matching must never resolve it.
    assert_eq!(registry.enter("receiver", &native), Some(linked.clone()));
    registry.complete(1);
    assert_eq!(registry.receive_drop("receiver", &native), Some(linked));
}

#[test]
fn platform_callback_captures_copy_before_delayed_dispatch_and_ctrl_release() {
    use std::sync::Arc;
    use wry::{drag_drop_snapshot, DragDropEvent};
    let registry = Arc::new(Mutex::new(Registry::default()));
    let captured = registry.clone();
    drag_drop_snapshot::set_observer(Some(Arc::new(move |window, event, copying| {
        captured.lock().unwrap().capture(window, event, copying);
    })));
    let queued = Mutex::new(Vec::new());
    let handler = |event| {
        queued.lock().unwrap().push(event);
        true
    };
    drag_drop_snapshot::dispatch(
        42,
        true,
        DragDropEvent::Drop {
            paths: paths(),
            position: (20, 30),
        },
        &handler,
    );
    // Ctrl is released before the event-loop consumes the queued Drop. No
    // dispatch-time modifier lookup exists in the captured receiver payload.
    drag_drop_snapshot::dispatch(
        43,
        false,
        DragDropEvent::Drop {
            paths: paths(),
            position: (20, 30),
        },
        &handler,
    );
    drag_drop_snapshot::set_observer(None);
    let mut registry = registry.lock().unwrap();
    for (window, expected) in [(42, true), (43, false)] {
        let event = registry
            .take(
                window,
                &tauri::DragDropEvent::Drop {
                    paths: paths(),
                    position: tauri::PhysicalPosition { x: 20.0, y: 30.0 },
                },
            )
            .expect("callback captured the event before queuing");
        assert_eq!(
            serde_json::to_value(event).unwrap()["copyModifier"],
            expected
        );
    }
    assert_eq!(queued.lock().unwrap().len(), 2);
}

#[test]
fn windows_link_source_matches_the_canonical_native_transport_on_every_os() {
    let linked = Source {
        path: r"C:\source\Link".into(),
        paths: None,
        kind: "directory".into(),
        ..source()
    };
    let canonicalize = |path: &str| match path {
        r"C:\source\Link" => r"C:\important".into(),
        other => other.into(),
    };
    assert!(matches_with(
        &linked,
        &[r"C:\important".into()],
        true,
        canonicalize
    ));
    // Verified transport aliases must not fail the renderer's second path-set
    // admission, or bookmark delivery would become an external transfer again.
    assert_eq!(
        receiver_event_paths(&[r"C:\important".into()], Some(&linked)),
        vec![PathBuf::from(r"C:\source\Link")]
    );
    assert!(!matches_with(
        &linked,
        &[r"C:\unrelated".into()],
        true,
        canonicalize
    ));
}

#[test]
fn callback_queue_preserves_receiver_source_after_completion_and_rejects_mismatched_delivery() {
    let mut registry = Registry::default();
    registry.begin(1, "source".into(), Some(source()));
    registry.capture(
        42,
        &wry::DragDropEvent::Enter {
            paths: paths(),
            position: (20, 30),
        },
        true,
    );
    registry.capture(
        42,
        &wry::DragDropEvent::Drop {
            paths: paths(),
            position: (20, 30),
        },
        true,
    );
    registry.complete(1);
    let point = tauri::PhysicalPosition { x: 20.0, y: 30.0 };
    for delivered in [
        tauri::DragDropEvent::Enter {
            paths: paths(),
            position: point,
        },
        tauri::DragDropEvent::Drop {
            paths: paths(),
            position: point,
        },
    ] {
        let json = serde_json::to_value(registry.take(42, &delivered).unwrap()).unwrap();
        assert_eq!(json["source"]["sessionId"], "first");
        assert_eq!(json["copyModifier"], true);
    }
    registry.capture(
        42,
        &wry::DragDropEvent::Drop {
            paths: paths(),
            position: (20, 30),
        },
        false,
    );
    assert!(registry
        .take(
            42,
            &tauri::DragDropEvent::Drop {
                paths: vec![path("unrelated").into()],
                position: point
            }
        )
        .is_none());
    assert!(registry.pending.is_empty());
}

#[test]
fn malformed_windows_sources_never_acquire_receiver_identity() {
    for path in [
        r"C:relative",
        r"relative\file",
        r"C:\source\..\important",
        "C:\\bad\0",
    ] {
        let source = Source {
            path: path.into(),
            paths: None,
            ..source()
        };
        assert!(!matches_with(&source, &[path.into()], true, |_| panic!(
            "invalid path resolved"
        )));
    }
}

#[test]
fn windows_transport_preserves_unc_and_canonical_multiset_order() {
    let unc = Source {
        path: r"\\server\share\Link".into(),
        paths: None,
        kind: "directory".into(),
        ..source()
    };
    assert!(matches_with(
        &unc,
        &[unc.path.clone().into()],
        true,
        |_| panic!("vendor skips UNC canonicalization")
    ));
    let linked = Source {
        path: r"C:\source\Link".into(),
        paths: Some(vec![r"C:\source\Link".into(), r"C:\source\a.png".into()]),
        ..source()
    };
    let canonicalize = |path: &str| path.replace(r"source\Link", "important");
    assert!(matches_with(
        &linked,
        &[r"C:\source\a.png".into(), r"C:\important".into()],
        true,
        canonicalize
    ));
    assert!(!matches_with(
        &linked,
        &[r"C:\important".into()],
        true,
        canonicalize
    ));
}

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

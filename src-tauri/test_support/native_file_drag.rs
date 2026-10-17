use super::*;

// The observer is process-global; native dispatch probes must not install or
// invoke it concurrently with another probe's callback assertions.
static OBSERVER_TEST_LOCK: Mutex<()> = Mutex::new(());

#[test]
fn completion_backlog_cannot_lend_identity_to_a_later_external_enter() {
    use std::sync::Arc;
    let registry = Arc::new(Mutex::new(Registry::default()));
    registry.lock().unwrap().begin(
        1,
        "source".into(),
        Some(Source {
            native_copy_policy: Some(CopyPolicy::Move),
            ..source()
        }),
    );
    // An original receiver has already captured Enter before cancellation.
    registry.lock().unwrap().capture_at(
        41,
        &wry::DragDropEvent::Enter {
            paths: paths(),
            position: (20, 30),
        },
        false,
        1000.25,
    );
    let retire_registry = registry.clone();
    let delivered = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let notification_delivered = delivered.clone();
    let mut queue = VecDeque::new();
    complete_native_drag(
        move || retire_registry.lock().unwrap().complete(1),
        move || {
            notification_delivered.store(true, Ordering::Relaxed);
        },
        |notification| queue.push_back(notification),
    );
    assert!(!delivered.load(Ordering::Relaxed));
    // Tao/GTK can service this platform callback with completion still queued.
    for event in [
        wry::DragDropEvent::Enter {
            paths: paths(),
            position: (20, 30),
        },
        wry::DragDropEvent::Drop {
            paths: paths(),
            position: (20, 30),
        },
    ] {
        registry
            .lock()
            .unwrap()
            .capture_at(42, &event, true, 1002.25);
    }
    queue.pop_front().unwrap()();
    assert!(delivered.load(Ordering::Relaxed));
    let point = tauri::PhysicalPosition { x: 20.0, y: 30.0 };
    for event in [
        tauri::DragDropEvent::Enter {
            paths: paths(),
            position: point,
        },
        tauri::DragDropEvent::Drop {
            paths: paths(),
            position: point,
        },
    ] {
        let payload =
            serde_json::to_value(registry.lock().unwrap().take(42, &event).unwrap()).unwrap();
        assert_eq!(payload["source"], serde_json::Value::Null);
        assert_eq!(payload["copyModifier"], true);
        assert_eq!(payload["completedGestureSequence"], 1);
    }
    let original = serde_json::to_value(
        registry
            .lock()
            .unwrap()
            .take(
                41,
                &tauri::DragDropEvent::Enter {
                    paths: paths(),
                    position: point,
                },
            )
            .unwrap(),
    )
    .unwrap();
    assert_eq!(original["source"]["sessionId"], "first");
    assert_eq!(original["completedGestureSequence"], 0);
}

#[test]
fn failed_start_does_not_fence_a_surviving_html5_source() {
    let mut registry = Registry::default();
    registry.begin(1, "source".into(), Some(source()));
    registry.failed_start(1);
    registry.capture_at(
        42,
        &wry::DragDropEvent::Enter {
            paths: paths(),
            position: (20, 30),
        },
        false,
        1000.25,
    );
    let payload = serde_json::to_value(
        registry
            .take(
                42,
                &tauri::DragDropEvent::Enter {
                    paths: paths(),
                    position: tauri::PhysicalPosition { x: 20.0, y: 30.0 },
                },
            )
            .unwrap(),
    )
    .unwrap();
    assert_eq!(payload["source"], serde_json::Value::Null);
    assert_eq!(payload["completedGestureSequence"], 0);
}

#[test]
fn deferred_platform_leave_does_not_reach_a_reused_native_receiver() {
    let _observer_guard = OBSERVER_TEST_LOCK.lock().unwrap();
    use std::{cell::RefCell, rc::Rc};
    let original = Rc::new(42usize);
    let weak_original = Rc::downgrade(&original);
    let events = RefCell::new(Vec::new());
    let handler = |event| {
        events.borrow_mut().push(event);
        true
    };
    drop(original);
    let replacement = Rc::new(42usize);
    // The numeric handle matches, but the callback belongs to the original
    // runtime object; it must reach neither observer nor queued handler.
    assert!(!wry::drag_drop_snapshot::dispatch_deferred(
        *replacement,
        false,
        wry::DragDropEvent::Leave,
        || weak_original.upgrade().map(|window| *window),
        &handler
    ));
    assert!(events.borrow().is_empty());
    let weak_replacement = Rc::downgrade(&replacement);
    assert!(wry::drag_drop_snapshot::dispatch_deferred(
        *replacement,
        false,
        wry::DragDropEvent::Leave,
        || weak_replacement.upgrade().map(|window| *window),
        &handler
    ));
    assert!(matches!(
        events.borrow().as_slice(),
        [wry::DragDropEvent::Leave]
    ));
}

#[test]
fn recent_native_start_is_rejected_before_exporting_files_on_every_platform() {
    let recent = Source {
        native_copy_policy: Some(CopyPolicy::Link),
        ..source()
    };
    assert!(native_drag_options(Some(&recent)).is_err());
}

#[test]
fn outgoing_native_actions_stay_copy_for_every_internal_intent() {
    for policy in [None, Some(CopyPolicy::Modifier), Some(CopyPolicy::Move)] {
        let ordinary = Source {
            native_copy_policy: policy,
            ..source()
        };
        assert!(matches!(
            native_drag_options(Some(&ordinary)).unwrap().mode,
            drag::DragMode::Copy
        ));
    }
    assert!(matches!(
        native_drag_options(None).unwrap().mode,
        drag::DragMode::Copy
    ));
}

#[test]
fn snapshot_only_receiver_is_cleaned_by_label_without_affecting_other_windows() {
    let mut registry = Registry::default();
    registry.begin(1, "source-window".into(), Some(source()));
    // Same registration used by the platform observer before Tauri enqueues
    // the first receiver event, which need never reach the destroyed window.
    for (id, label) in [(42, "closing-receiver"), (43, "live-receiver")] {
        registry.register_window(id, label);
        registry.capture(
            id,
            &wry::DragDropEvent::Enter {
                paths: paths(),
                position: (20, 30),
            },
            false,
        );
    }
    registry.window_event("closing-receiver", &tauri::WindowEvent::Destroyed, || {
        panic!("Destroyed cannot retrieve its native handle")
    });
    registry.complete(1);
    registry.capture(
        42,
        &wry::DragDropEvent::Drop {
            paths: paths(),
            position: (20, 30),
        },
        false,
    );
    let replacement = registry
        .take(
            42,
            &tauri::DragDropEvent::Drop {
                paths: paths(),
                position: tauri::PhysicalPosition { x: 20.0, y: 30.0 },
            },
        )
        .unwrap();
    assert_eq!(
        serde_json::to_value(replacement).unwrap()["source"],
        serde_json::Value::Null
    );
    let live = registry
        .take(
            43,
            &tauri::DragDropEvent::Enter {
                paths: paths(),
                position: tauri::PhysicalPosition { x: 20.0, y: 30.0 },
            },
        )
        .unwrap();
    assert_eq!(
        serde_json::to_value(live).unwrap()["source"]["sessionId"],
        "first"
    );
    registry.capture(
        43,
        &wry::DragDropEvent::Drop {
            paths: paths(),
            position: (20, 30),
        },
        false,
    );
    let live_drop = registry
        .take(
            43,
            &tauri::DragDropEvent::Drop {
                paths: paths(),
                position: tauri::PhysicalPosition { x: 20.0, y: 30.0 },
            },
        )
        .unwrap();
    assert_eq!(
        serde_json::to_value(live_drop).unwrap()["source"]["sessionId"],
        "first"
    );
}

#[test]
fn destroyed_receiver_with_unavailable_runtime_handle_cannot_poison_reused_native_id() {
    // Tauri's runtime removes the native window before emitting Destroyed.
    struct FakeRuntimeWindow {
        handle: Option<usize>,
    }
    impl FakeRuntimeWindow {
        fn native_handle(&self) -> Option<usize> {
            self.handle
        }
    }
    let mut window = FakeRuntimeWindow { handle: Some(42) };
    let mut registry = Registry::default();
    registry.begin(1, "source-window".into(), Some(source()));
    // A live runtime event exposes the id before any receiver dispatch.
    registry.window_event("old-receiver", &tauri::WindowEvent::Focused(true), || {
        window.native_handle()
    });
    registry.capture(
        42,
        &wry::DragDropEvent::Enter {
            paths: paths(),
            position: (20, 30),
        },
        false,
    );
    window.handle = None;
    registry.window_event("old-receiver", &tauri::WindowEvent::Destroyed, || {
        window.native_handle()
    });
    registry.complete(1);
    // The OS reuses 42. A source-less Drop must not inherit the dead receiver.
    window.handle = Some(42);
    registry.window_event("replacement", &tauri::WindowEvent::Focused(true), || {
        window.native_handle()
    });
    registry.capture(
        42,
        &wry::DragDropEvent::Drop {
            paths: paths(),
            position: (20, 30),
        },
        false,
    );
    let delivered = registry
        .window_event(
            "replacement",
            &tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop {
                paths: paths(),
                position: tauri::PhysicalPosition { x: 20.0, y: 30.0 },
            }),
            || window.native_handle(),
        )
        .expect("replacement drop has its own snapshot");
    assert_eq!(
        serde_json::to_value(delivered).unwrap()["source"],
        serde_json::Value::Null
    );
    registry.capture(42, &wry::DragDropEvent::Leave, false);
    assert!(matches!(
        registry.window_event(
            "replacement",
            &tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Leave),
            || window.native_handle()
        ),
        Some(Event::Leave)
    ));
}

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
    let _observer_guard = OBSERVER_TEST_LOCK.lock().unwrap();
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
        gesture_sequence: 1,
        path: path("a.png"),
        name: "a.png".into(),
        kind: "file".into(),
        paths: Some(vec![path("z.png"), path("a.png")]),
        native_copy_policy: Some(CopyPolicy::Modifier),
        html5: false,
    }
}
fn paths() -> Vec<PathBuf> {
    vec![path("a.png").into(), path("z.png").into()]
}

#[test]
fn native_source_round_trip_preserves_source_copy_policy() {
    for policy in ["move", "modifier", "link"] {
        let mut json = serde_json::to_value(source()).unwrap();
        json["nativeCopyPolicy"] = policy.into();
        let restored: Source = serde_json::from_value(json).unwrap();
        assert_eq!(restored.gesture_sequence, 1);
        assert_eq!(
            serde_json::to_value(restored).unwrap()["nativeCopyPolicy"],
            policy
        );
    }
}

#[test]
fn native_provenance_requires_a_frontend_safe_gesture_sequence() {
    for sequence in [0, 9_007_199_254_740_992, u64::MAX] {
        let invalid = Source {
            gesture_sequence: sequence,
            ..source()
        };
        assert!(!matches(&invalid, &paths()));
    }
    let mut json = serde_json::to_value(source()).unwrap();
    json.as_object_mut().unwrap().remove("gestureSequence");
    assert!(serde_json::from_value::<Source>(json).is_err());
}

#[test]
fn receiver_event_carries_drop_time_modifiers_independently_of_source_policy() {
    for copying in [false, true] {
        let event = Event::Drop {
            external_source: None,
            paths: paths(),
            position: tauri::PhysicalPosition { x: 20.0, y: 30.0 },
            source: Some(source()),
            copy_modifier: Some(copying),
            observed_at: 1011.25,
            observation_clock: "process-clock".into(),
            completed_gesture_sequence: 0,
        };
        let json = serde_json::to_value(event).unwrap();
        assert_eq!(json["type"], "drop");
        assert_eq!(json["copyModifier"], copying);
        assert_eq!(json["observedAt"], 1011.25);
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

#[test]
fn automatic_html5_observation_survives_source_retirement_and_delayed_delivery() {
    let mut registry = Registry::default();
    // A failed explicit start has retired the Rust source. Wry still observes
    // the original HTML5 drag; the frontend must correlate its observation,
    // never the later IPC delivery time, with the retained HTML5 lifetime.
    registry.begin(1, "source".into(), Some(source()));
    registry.complete(1);
    for (native, delivered, observed_at) in [
        (
            wry::DragDropEvent::Enter {
                paths: paths(),
                position: (20, 30),
            },
            tauri::DragDropEvent::Enter {
                paths: paths(),
                position: tauri::PhysicalPosition { x: 20.0, y: 30.0 },
            },
            1011.25,
        ),
        (
            wry::DragDropEvent::Drop {
                paths: paths(),
                position: (20, 30),
            },
            tauri::DragDropEvent::Drop {
                paths: paths(),
                position: tauri::PhysicalPosition { x: 20.0, y: 30.0 },
            },
            1011.5,
        ),
    ] {
        registry.capture_at(42, &native, true, observed_at);
        registry.destroyed("source");
        let payload = serde_json::to_value(registry.take(42, &delivered).unwrap()).unwrap();
        assert_eq!(payload["source"], serde_json::Value::Null);
        assert_eq!(payload["observedAt"], observed_at);
        assert_eq!(payload["copyModifier"], true);
    }
}

#[test]
fn platform_observations_share_the_sampled_process_monotonic_clock() {
    let mut registry = Registry::default();
    let before = registry.clock_sample();
    let native = wry::DragDropEvent::Enter {
        paths: paths(),
        position: (20, 30),
    };
    registry.capture(42, &native, false);
    let after = registry.clock_sample();
    let event = registry
        .take(
            42,
            &tauri::DragDropEvent::Enter {
                paths: paths(),
                position: tauri::PhysicalPosition { x: 20.0, y: 30.0 },
            },
        )
        .unwrap();
    let json = serde_json::to_value(event).unwrap();
    let observed = json["observedAt"].as_f64().unwrap();
    assert!(observed >= before.now && observed <= after.now);
    assert_eq!(json["observationClock"], before.id);
    assert_eq!(before.id, after.id);
    // A new runtime never gives authority to a prior runtime's time floor.
    let restart = Registry::default().clock_sample();
    assert_ne!(restart.id, after.id);
}

#[test]
fn source_intent_overrides_stale_native_modifiers_at_the_drop_payload() {
    // Ctrl pressed after handoff, held from the start, released before drop,
    // and never pressed. The cached GTK value is deliberately wrong in three
    // cases. Assert the event actually delivered to the frontend consumer.
    for (cached, tracked) in [(false, true), (true, true), (true, false), (false, false)] {
        let mut registry = Registry::default();
        registry.begin(1, "source".into(), Some(source()));
        registry.capture_at(
            42,
            &wry::DragDropEvent::Enter {
                paths: paths(),
                position: (20, 30),
            },
            cached,
            1000.0,
        );
        registry
            .take(
                42,
                &tauri::DragDropEvent::Enter {
                    paths: paths(),
                    position: tauri::PhysicalPosition { x: 20.0, y: 30.0 },
                },
            )
            .unwrap();
        registry.capture_with_intent(
            42,
            &wry::DragDropEvent::Drop {
                paths: paths(),
                position: (20, 30),
            },
            cached,
            1001.0,
            |source| {
                assert_eq!(source.session_id, "first");
                Some(Ok(tracked))
            },
        );
        let payload = serde_json::to_value(
            registry
                .take(
                    42,
                    &tauri::DragDropEvent::Drop {
                        paths: paths(),
                        position: tauri::PhysicalPosition { x: 20.0, y: 30.0 },
                    },
                )
                .unwrap(),
        )
        .unwrap();
        assert_eq!(payload["copyModifier"], tracked, "cached={cached}");
        assert_eq!(payload["source"]["sessionId"], "first");
    }
}

#[test]
fn external_drop_never_borrows_an_in_app_intent_channel() {
    for cached in [false, true] {
        let mut registry = Registry::default();
        registry.capture_at(
            42,
            &wry::DragDropEvent::Enter {
                paths: paths(),
                position: (20, 30),
            },
            cached,
            1000.0,
        );
        registry
            .take(
                42,
                &tauri::DragDropEvent::Enter {
                    paths: paths(),
                    position: tauri::PhysicalPosition { x: 20.0, y: 30.0 },
                },
            )
            .unwrap();
        registry.capture_with_intent(
            42,
            &wry::DragDropEvent::Drop {
                paths: paths(),
                position: (20, 30),
            },
            cached,
            1001.0,
            |_| panic!("external source has no app-owned intent"),
        );
        let payload = serde_json::to_value(
            registry
                .take(
                    42,
                    &tauri::DragDropEvent::Drop {
                        paths: paths(),
                        position: tauri::PhysicalPosition { x: 20.0, y: 30.0 },
                    },
                )
                .unwrap(),
        )
        .unwrap();
        assert_eq!(payload["source"], serde_json::Value::Null);
        assert_eq!(payload["copyModifier"], cached);
    }
}

#[test]
fn unavailable_fresh_intent_cannot_publish_a_destructive_guess() {
    let mut registry = Registry::default();
    registry.begin(1, "source".into(), Some(source()));
    registry.capture_at(
        42,
        &wry::DragDropEvent::Enter {
            paths: paths(),
            position: (20, 30),
        },
        false,
        1000.0,
    );
    registry
        .take(
            42,
            &tauri::DragDropEvent::Enter {
                paths: paths(),
                position: tauri::PhysicalPosition { x: 20.0, y: 30.0 },
            },
        )
        .unwrap();
    registry.capture_with_intent(
        42,
        &wry::DragDropEvent::Drop {
            paths: paths(),
            position: (20, 30),
        },
        false,
        1001.0,
        |_| Some(Err("missing focus restoration".into())),
    );
    registry.capture_at(
        42,
        &wry::DragDropEvent::Enter {
            paths: paths(),
            position: (20, 30),
        },
        false,
        1002.0,
    );
    assert!(matches!(
        registry.take(
            42,
            &tauri::DragDropEvent::Drop {
                paths: paths(),
                position: tauri::PhysicalPosition { x: 20.0, y: 30.0 },
            }
        ),
        Some(Event::Leave)
    ));
    assert!(matches!(
        registry.take(
            42,
            &tauri::DragDropEvent::Enter {
                paths: paths(),
                position: tauri::PhysicalPosition { x: 20.0, y: 30.0 },
            }
        ),
        Some(Event::Enter { .. })
    ));
}

#[test]
fn move_only_listing_drop_does_not_require_a_copy_modifier_snapshot() {
    let mut registry = Registry::default();
    registry.begin(
        1,
        "source".into(),
        Some(Source {
            native_copy_policy: Some(CopyPolicy::Move),
            ..source()
        }),
    );
    registry.capture_at(
        42,
        &wry::DragDropEvent::Enter {
            paths: paths(),
            position: (20, 30),
        },
        false,
        1000.0,
    );
    registry
        .take(
            42,
            &tauri::DragDropEvent::Enter {
                paths: paths(),
                position: tauri::PhysicalPosition { x: 20.0, y: 30.0 },
            },
        )
        .unwrap();
    registry.capture_with_intent(
        42,
        &wry::DragDropEvent::Drop {
            paths: paths(),
            position: (20, 30),
        },
        true,
        1001.0,
        |_| Some(Err("No fresh keyboard-focus snapshot".into())),
    );
    let payload = serde_json::to_value(
        registry
            .take(
                42,
                &tauri::DragDropEvent::Drop {
                    paths: paths(),
                    position: tauri::PhysicalPosition { x: 20.0, y: 30.0 },
                },
            )
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        payload["type"], "drop",
        "a fixed move policy has no modifier observation dependency"
    );
    assert_eq!(payload["source"]["nativeCopyPolicy"], "move");
}

#[test]
fn linux_html5_listing_retains_webkits_original_native_drag() {
    let listing = serde_json::from_value::<Source>(serde_json::json!({
        "sessionId": "listing-drag", "gestureSequence": 1,
        "path": path("a.png"), "name": "a.png", "kind": "file",
        "nativeCopyPolicy": "move", "html5": true,
    }))
    .unwrap();
    assert_eq!(listing.uses_webkit_source(), cfg!(target_os = "linux"));
    assert!(native_drag_options(Some(&listing)).is_ok());
    // Pointer/API sources still start their explicit native session.
    let pointer = Source {
        html5: false,
        ..listing.clone()
    };
    assert!(!pointer.uses_webkit_source());
    assert!(native_drag_options(Some(&pointer)).is_ok());
    // Miller adopts the same native source while retaining fresh copy intent.
    let miller = Source {
        native_copy_policy: Some(CopyPolicy::Modifier),
        ..listing
    };
    assert_eq!(miller.uses_webkit_source(), cfg!(target_os = "linux"));
    assert!(miller.needs_copy_intent());
    assert!(native_drag_options(Some(&miller)).is_ok());
}

#[test]
fn ended_html5_source_cannot_be_adopted_late_or_retire_its_replacement() {
    let mut registry = Registry::default();
    let first = Source {
        html5: true,
        ..source()
    };
    assert!(registry.end_html5("source", &first, false));
    assert!(!registry.can_adopt_html5(&first));
    let next = Source {
        session_id: "next".into(),
        gesture_sequence: 2,
        ..first.clone()
    };
    assert!(registry.can_adopt_html5(&next));
    registry.begin(2, "source".into(), Some(next.clone()));
    registry.bind_html5_context(2, 77);
    assert!(registry.end_html5("source", &first, false));
    assert_eq!(
        registry.enter_with_context("receiver", &paths(), Some(77)),
        Some(next.clone())
    );
    // Row disposal preserves an observed live GTK context. Actual DOM end
    // and widget destruction complete it through the common native sink.
    assert!(!registry.end_html5("source", &next, true));
    assert_eq!(
        registry.enter_with_context("receiver", &paths(), Some(77)),
        Some(next.clone())
    );
    assert!(registry.end_html5("source", &next, false));
    assert!(!registry.can_adopt_html5(&next));
    assert_eq!(registry.enter("receiver", &paths()), None);
}

#[test]
fn html5_enter_before_adoption_retains_fresh_intent_after_source_completion() {
    let mut registry = Registry::default();
    let original = Source {
        html5: true,
        ..source()
    };
    assert_eq!(registry.enter_with_context("42", &paths(), Some(77)), None);
    registry.begin(1, "source".into(), Some(original.clone()));
    registry.bind_html5_context(1, 77);
    registry.complete(1);
    registry.capture_with_intent(
        42,
        &wry::DragDropEvent::Drop {
            paths: paths(),
            position: (20, 30),
        },
        false,
        1001.0,
        |source| {
            assert_eq!(source, &original);
            Some(Ok(true))
        },
    );
    let payload = serde_json::to_value(
        registry
            .take(
                42,
                &tauri::DragDropEvent::Drop {
                    paths: paths(),
                    position: tauri::PhysicalPosition { x: 20.0, y: 30.0 },
                },
            )
            .unwrap(),
    )
    .unwrap();
    assert_eq!(payload["type"], "drop");
    assert_eq!(payload["source"]["sessionId"], original.session_id);
    assert_eq!(payload["copyModifier"], true);
}

#[test]
fn window_destruction_fences_source_before_late_widget_completion() {
    let mut registry = Registry::default();
    let original = Source {
        html5: true,
        ..source()
    };
    registry.begin(1, "closing-source".into(), Some(original.clone()));
    registry.destroyed("closing-source");
    registry.complete(1);
    assert!(!registry.can_adopt_html5(&original));
    let event = wry::DragDropEvent::Enter {
        paths: paths(),
        position: (20, 30),
    };
    registry.capture_at(42, &event, true, 2000.0);
    let delivered = registry
        .take(
            42,
            &tauri::DragDropEvent::Enter {
                paths: paths(),
                position: tauri::PhysicalPosition { x: 20.0, y: 30.0 },
            },
        )
        .unwrap();
    let payload = serde_json::to_value(delivered).unwrap();
    assert_eq!(payload["source"], serde_json::Value::Null);
    assert_eq!(
        payload["completedGestureSequence"],
        original.gesture_sequence
    );
}

#[test]
fn delayed_older_adoption_cannot_replace_newer_active_source() {
    let mut registry = Registry::default();
    let newer = Source {
        session_id: "newer".into(),
        gesture_sequence: 2,
        html5: true,
        ..source()
    };
    registry.begin(2, "source".into(), Some(newer.clone()));
    assert!(!registry.can_adopt_html5(&source()));
    assert!(!registry.can_adopt_html5(&newer));
    registry.bind_html5_context(2, 77);
    assert_eq!(
        registry.enter_with_context("receiver", &paths(), Some(77)),
        Some(newer)
    );
}

#[test]
fn unadopted_own_context_is_cancelled_without_borrowing_a_later_external_drop() {
    let mut registry = Registry::default();
    registry.enter_with_context("42", &paths(), Some(77));
    let native_drop = wry::DragDropEvent::Drop {
        paths: paths(),
        position: (20, 30),
    };
    let delivered = tauri::DragDropEvent::Drop {
        paths: paths(),
        position: tauri::PhysicalPosition { x: 20.0, y: 30.0 },
    };
    registry.capture_with_intent(42, &native_drop, true, 1000.0, |_| {
        panic!("unowned source has no intent")
    });
    assert!(matches!(registry.take(42, &delivered), Some(Event::Leave)));
    registry.enter_with_context("42", &paths(), None);
    registry.capture_with_intent(42, &native_drop, true, 2000.0, |_| {
        panic!("external source has no app intent")
    });
    let payload = serde_json::to_value(registry.take(42, &delivered).unwrap()).unwrap();
    assert_eq!(payload["type"], "drop");
    assert_eq!(payload["source"], serde_json::Value::Null);
    assert_eq!(payload["copyModifier"], true);
}

#[test]
fn gtk_source_identity_is_callback_scoped_and_restored_on_nesting_and_unwind() {
    let _guard = OBSERVER_TEST_LOCK.lock().unwrap();
    use wry::{drag_drop_snapshot as snapshot, DragDropEvent};
    assert_eq!(snapshot::source_window(), None);
    snapshot::dispatch_with_source_window(
        1,
        false,
        DragDropEvent::Leave,
        Some(11),
        Some(true),
        &|_| {
            assert_eq!(snapshot::source_window(), Some(11));
            snapshot::dispatch_with_source_window(
                1,
                false,
                DragDropEvent::Leave,
                Some(22),
                Some(false),
                &|_| {
                    assert_eq!(snapshot::source_window(), Some(22));
                    assert_eq!(snapshot::source_is_local(), Some(false));
                    false
                },
            );
            assert_eq!(snapshot::source_window(), Some(11));
            true
        },
    );
    assert_eq!(snapshot::source_window(), None);
    let _ = std::panic::catch_unwind(|| {
        snapshot::dispatch_with_source_window(
            1,
            false,
            DragDropEvent::Leave,
            Some(33),
            None,
            &|_| panic!("scoped callback"),
        )
    });
    assert_eq!(snapshot::source_window(), None);
}

#[test]
fn drop_context_cannot_inherit_an_earlier_different_enter_source() {
    let _guard = OBSERVER_TEST_LOCK.lock().unwrap();
    use std::cell::RefCell;
    let registry = RefCell::new(Registry::default());
    let original = Source {
        html5: true,
        ..source()
    };
    registry
        .borrow_mut()
        .begin(1, "source".into(), Some(original));
    registry.borrow_mut().bind_html5_context(1, 100);
    registry
        .borrow_mut()
        .enter_with_context("42", &paths(), Some(100));
    let event = wry::DragDropEvent::Drop {
        paths: paths(),
        position: (20, 30),
    };
    wry::drag_drop_snapshot::dispatch_with_source_window(
        42,
        true,
        event.clone(),
        Some(200),
        Some(false),
        &|event| {
            registry
                .borrow_mut()
                .capture_with_intent(42, &event, true, 1000.0, |_| {
                    panic!("external drop has no source intent")
                });
            true
        },
    );
    let payload = serde_json::to_value(
        registry
            .borrow_mut()
            .take(
                42,
                &tauri::DragDropEvent::Drop {
                    paths: paths(),
                    position: tauri::PhysicalPosition { x: 20.0, y: 30.0 },
                },
            )
            .unwrap(),
    )
    .unwrap();
    assert_eq!(payload["source"], serde_json::Value::Null);
    // Only GTK can prove another native source owns this context. Other
    // platforms still reject the stale identity, without claiming GTK proof.
    #[cfg(target_os = "linux")]
    assert_eq!(payload["externalSource"], true);
    #[cfg(not(target_os = "linux"))]
    assert!(payload.get("externalSource").is_none());
    assert_eq!(payload["copyModifier"], true);
}

#[test]
fn external_drop_without_gdk_window_never_borrows_stale_modifier_intent() {
    let _guard = OBSERVER_TEST_LOCK.lock().unwrap();
    let registry = std::cell::RefCell::new(Registry::default());
    let original = Source {
        html5: true,
        native_copy_policy: Some(CopyPolicy::Modifier),
        ..source()
    };
    registry
        .borrow_mut()
        .begin(1, "source".into(), Some(original));
    registry.borrow_mut().bind_html5_context(1, 100);
    registry
        .borrow_mut()
        .enter_with_context("42", &paths(), Some(100));
    registry.borrow_mut().complete(1);
    let event = wry::DragDropEvent::Drop {
        paths: paths(),
        position: (20, 30),
    };
    wry::drag_drop_snapshot::dispatch_with_source_window(
        42,
        true,
        event.clone(),
        None,
        Some(false),
        &|event| {
            registry
                .borrow_mut()
                .capture_with_intent(42, &event, true, 1000.0, |_| {
                    panic!("external drop must not query source monitor")
                });
            true
        },
    );
    let payload = serde_json::to_value(
        registry
            .borrow_mut()
            .take(
                42,
                &tauri::DragDropEvent::Drop {
                    paths: paths(),
                    position: tauri::PhysicalPosition { x: 20.0, y: 30.0 },
                },
            )
            .unwrap(),
    )
    .unwrap();
    assert_eq!(payload["source"], serde_json::Value::Null);
    #[cfg(target_os = "linux")]
    assert_eq!(payload["externalSource"], true);
    #[cfg(not(target_os = "linux"))]
    assert!(payload.get("externalSource").is_none());
    assert_eq!(payload["copyModifier"], true);
}

#[test]
fn delayed_uri_reply_keeps_the_first_receiver_motion_token_after_ipc_window_reuse() {
    use std::sync::{atomic::AtomicUsize, Arc};
    use wry::drag_drop_snapshot as snapshot;
    let _guard = OBSERVER_TEST_LOCK.lock().unwrap();
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            snapshot::set_source_resolver(None);
        }
    }
    let _reset = Reset;
    let current = Arc::new(AtomicUsize::new(100));
    let lookup = current.clone();
    snapshot::set_source_resolver(Some(Arc::new(move |window, local| {
        (window == Some(77) && local == Some(true)).then(|| lookup.load(Ordering::Relaxed))
    })));
    let first_motion = snapshot::resolve_source(Some(77), Some(true));
    current.store(200, Ordering::Relaxed);
    let registry = std::cell::RefCell::new(Registry::default());
    registry.borrow_mut().begin(
        2,
        "newer-source".into(),
        Some(Source {
            html5: true,
            ..source()
        }),
    );
    registry.borrow_mut().bind_html5_context(2, 200);
    let enter = wry::DragDropEvent::Enter {
        paths: paths(),
        position: (20, 30),
    };
    snapshot::dispatch_with_source_snapshot(42, false, enter, first_motion, &|event| {
        registry.borrow_mut().capture_at(42, &event, false, 1000.0);
        true
    });
    let payload = serde_json::to_value(
        registry
            .borrow_mut()
            .take(
                42,
                &tauri::DragDropEvent::Enter {
                    paths: paths(),
                    position: tauri::PhysicalPosition { x: 20.0, y: 30.0 },
                },
            )
            .unwrap(),
    )
    .unwrap();
    assert_eq!(payload["source"], serde_json::Value::Null);
    let drop = wry::DragDropEvent::Drop {
        paths: paths(),
        position: (20, 30),
    };
    snapshot::dispatch_with_source_snapshot(42, false, drop, first_motion, &|event| {
        registry
            .borrow_mut()
            .capture_with_intent(42, &event, false, 1001.0, |_| {
                panic!("old URI reply cannot borrow new source intent")
            });
        true
    });
    assert!(matches!(
        registry.borrow_mut().take(
            42,
            &tauri::DragDropEvent::Drop {
                paths: paths(),
                position: tauri::PhysicalPosition { x: 20.0, y: 30.0 }
            }
        ),
        Some(Event::Leave)
    ));
    assert_eq!(snapshot::source_token(), None);
}

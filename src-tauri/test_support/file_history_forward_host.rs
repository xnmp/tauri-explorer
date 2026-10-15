//! `run_forward` records history through the host's trash capability.
use super::*;
use crate::file_history::{register, Action, Recovery};
use crate::platform::TrashRestore;

fn deleted_action() -> Action {
    let parent = std::env::temp_dir().join("forward-host");
    Action::Delete {
        paths: vec![parent.join("gone.txt").to_string_lossy().into_owned()],
        parent_dir: parent.to_string_lossy().into_owned(),
        recovery: Recovery::Capture,
    }
}

#[test]
fn host_constant_matches_the_platform_trash_capability() {
    let expected = if cfg!(target_os = "macos") {
        TrashRestore::Unsupported
    } else {
        TrashRestore::Supported
    };
    assert_eq!(TrashRestore::HOST, expected);
}

#[test]
fn a_forward_deletion_is_recorded_only_where_the_host_can_restore_it() {
    let owner = Owner::default();
    register(owner.clone(), tauri::ipc::Channel::new(|_| Ok(()))).unwrap();
    let reply = tauri::async_runtime::block_on(run_forward(owner, false, Vec::new(), async {
        MutationOutcome {
            result: Ok(()),
            effect: ForwardEffect::Changed(Some(deleted_action())),
            warning: None,
            affected: Vec::new(),
        }
    }))
    .unwrap();
    // Native completion passes through `prepare_forward(.., TrashRestore::HOST)`:
    // an unrestorable deletion leaves no undo entry, a restorable one does.
    let restorable = !cfg!(target_os = "macos");
    assert_eq!(reply.history.undo_id.is_some(), restorable);
    assert_eq!(reply.history.stack_size, usize::from(restorable));
    assert!(reply.warning.is_none(), "{:?}", reply.warning);
}

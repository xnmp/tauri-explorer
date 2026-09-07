use super::*;
use std::sync::Arc;
use tauri::Manager;

#[cfg(any(target_os = "linux", target_os = "windows"))]
fn acknowledge(slot: &WindowOwner) {
    slot.termination.set(()).unwrap();
}

#[cfg(not(any(target_os = "linux", target_os = "windows")))]
fn acknowledge(_slot: &WindowOwner) {}

#[test]
fn page_start_without_native_resource_use_does_not_allocate_ownership() {
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let left = tauri::WebviewWindowBuilder::new(&app, "unused-left", Default::default())
        .build()
        .unwrap()
        .as_ref()
        .window();
    let right = tauri::WebviewWindowBuilder::new(&app, "unused-right", Default::default())
        .build()
        .unwrap()
        .as_ref()
        .window();

    on_page_started(&left);
    on_page_started(&left);

    assert!(existing_owner(&left.resources_table()).is_none());
    assert!(existing_owner(&right.resources_table()).is_none());
}

#[test]
fn concrete_window_handles_share_identity_and_lifecycle_retirement() {
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let window = tauri::WebviewWindowBuilder::new(&app, "resource-owner", Default::default())
        .build()
        .unwrap()
        .as_ref()
        .window();
    let cloned_handle = window.clone();
    let other = tauri::WebviewWindowBuilder::new(&app, "other-owner", Default::default())
        .build()
        .unwrap()
        .as_ref()
        .window();

    let slot = resource_owner(&mut window.resources_table());
    let cloned_slot = resource_owner(&mut cloned_handle.resources_table());
    let other_slot = resource_owner(&mut other.resources_table());
    assert!(Arc::ptr_eq(&slot, &cloned_slot));
    assert!(!Arc::ptr_eq(&slot, &other_slot));

    let first_session = slot.scope.lock().unwrap().session().unwrap();
    acknowledge(&slot);
    let first = acquire_owner(&window, &first_session).unwrap();
    let clone_view = release_owner(&cloned_handle, &first_session).unwrap();
    assert!(first.same(&clone_view));
    assert!(first.active());

    on_page_started(&window);
    assert!(!first.active());
    assert!(release_owner(&cloned_handle, &first_session).is_none());
    assert_eq!(
        acquire_owner(&window, &first_session)
            .unwrap_err()
            .to_string(),
        "Native resource renderer was replaced"
    );
    let second_session = slot.scope.lock().unwrap().session().unwrap();
    let second = acquire_owner(&window, &second_session).unwrap();
    assert_ne!(first_session, second_session);
    assert!(!first.same(&second));
    assert!(second.active());

    on_window_destroyed(&cloned_handle);
    assert!(!second.active());
    assert!(slot.scope.lock().unwrap().session().is_none());
    assert!(release_owner(&window, &second_session).is_none());

    on_page_started(&window);
    assert!(slot.scope.lock().unwrap().session().is_none());
    let other_session = other_slot.scope.lock().unwrap().session().unwrap();
    acknowledge(&other_slot);
    assert!(acquire_owner(&other, &other_session).unwrap().active());
}

#[test]
fn destruction_before_first_command_closes_future_admission() {
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let window = tauri::WebviewWindowBuilder::new(&app, "never-acknowledged", Default::default())
        .build()
        .unwrap()
        .as_ref()
        .window();

    assert!(existing_owner(&window.resources_table()).is_none());
    on_window_destroyed(&window);
    let slot = existing_owner(&window.resources_table())
        .expect("destruction must leave a closed native-window tombstone in its ResourceTable");
    assert!(slot.scope.lock().unwrap().session().is_none());
    assert!(release_owner(&window, "0").is_none());
    acknowledge(&slot);
    assert_eq!(
        acquire_owner(&window, "0").unwrap_err().to_string(),
        "Native resource renderer was replaced"
    );

    on_page_started(&window);
    assert!(slot.scope.lock().unwrap().session().is_none());
    assert!(slot.scope.lock().unwrap().owner("0").is_none());
}

#[test]
fn same_label_replacement_has_fresh_authority_and_ignores_old_handle_destruction() {
    let old_app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let old_window = tauri::WebviewWindowBuilder::new(&old_app, "reused-label", Default::default())
        .build()
        .unwrap()
        .as_ref()
        .window();
    let delayed_old_handle = old_window.clone();
    let old_slot = resource_owner(&mut old_window.resources_table());
    let old_session = old_slot.scope.lock().unwrap().session().unwrap();
    acknowledge(&old_slot);
    let old = acquire_owner(&old_window, &old_session).unwrap();
    on_window_destroyed(&old_window);
    assert!(!old.active());

    // The mock dispatcher cannot remove and recreate one label, so a second
    // application supplies the concrete replacement ResourceTable.
    let replacement_app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let replacement =
        tauri::WebviewWindowBuilder::new(&replacement_app, "reused-label", Default::default())
            .build()
            .unwrap()
            .as_ref()
            .window();
    let replacement_slot = resource_owner(&mut replacement.resources_table());
    let replacement_session = replacement_slot.scope.lock().unwrap().session().unwrap();
    acknowledge(&replacement_slot);
    let replacement_owner = acquire_owner(&replacement, &replacement_session).unwrap();
    assert_eq!(old_window.label(), replacement.label());
    assert!(!Arc::ptr_eq(&old_slot, &replacement_slot));
    assert!(!old.same(&replacement_owner));
    assert!(replacement_owner.active());

    on_window_destroyed(&delayed_old_handle);
    assert!(replacement_owner.active());
    assert!(replacement_slot
        .scope
        .lock()
        .unwrap()
        .owner(&replacement_session)
        .is_some());
}

#[test]
fn generation_exhaustion_retires_authority_and_fails_closed() {
    let mut scope = scope::RendererScope::at_generation(u64::MAX);
    let final_session = scope.session().unwrap();
    let final_owner = scope.owner(&final_session).unwrap();
    assert_eq!(final_session, u64::MAX.to_string());
    assert!(final_owner.active());

    let retired = scope
        .advance()
        .expect("the final live owner must be retired");
    assert!(retired.same(&final_owner));
    assert!(!retired.active());
    assert!(scope.session().is_none());
    assert!(scope.owner(&final_session).is_none());
    assert!(scope.advance().is_none());
    assert!(scope.close().is_none());
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
#[test]
fn acquisition_requires_native_ack_and_the_current_generation() {
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let window = tauri::WebviewWindowBuilder::new(&app, "ack-owner", Default::default())
        .build()
        .unwrap()
        .as_ref()
        .window();
    let slot = resource_owner(&mut window.resources_table());
    let first_session = slot.scope.lock().unwrap().session().unwrap();

    let error = acquire_owner(&window, &first_session).unwrap_err();
    assert_eq!(
        error.to_string(),
        "Native resource renderer session was not acknowledged"
    );

    acknowledge(&slot);
    let first = acquire_owner(&window, &first_session).unwrap();
    assert!(first.active());

    on_page_started(&window);
    assert!(!first.active());
    assert_eq!(
        acquire_owner(&window, &first_session)
            .unwrap_err()
            .to_string(),
        "Native resource renderer was replaced"
    );
    let second_session = slot.scope.lock().unwrap().session().unwrap();
    let second = acquire_owner(&window, &second_session).unwrap();
    assert!(second.active());
    assert!(!second.same(&first));

    on_window_destroyed(&window);
    assert!(!second.active());
    assert_eq!(
        acquire_owner(&window, &second_session)
            .unwrap_err()
            .to_string(),
        "Native resource renderer was replaced"
    );
}

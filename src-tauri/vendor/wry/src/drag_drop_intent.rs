//! Drag callback actions are authoritative during native keyboard grabs.
//! Constants are the platform ABI values; this module has no GUI dependencies.
#[derive(Clone, Copy)]
pub enum PlatformDragIntent {
  Gtk {
    selected_action: u32,
    suggested_action: u32,
  },
  AppKit {
    source_operation_mask: usize,
  },
  Ole {
    effect: u32,
  },
}

pub fn copy_modifier(event: PlatformDragIntent) -> bool {
  match event {
    PlatformDragIntent::Gtk {
      selected_action,
      suggested_action,
    } => {
      let action = if selected_action == 0 {
        suggested_action
      } else {
        selected_action
      };
      action == 2 // GDK_ACTION_COPY, not an allowed-action bitset
    }
    // AppKit filters this mask with the current drag modifiers. Publish the
    // same supported action returned by the destination to AppKit.
    PlatformDragIntent::AppKit {
      source_operation_mask,
    } => appkit_operation(source_operation_mask) == 1,
    PlatformDragIntent::Ole { effect } => effect == 1, // DROPEFFECT_COPY
  }
}

/// Prefer Move normally; a modifier-filtered Copy mask selects Copy.
/// Generic/Link-only and empty masks cannot authorize a file operation.
pub fn appkit_operation(source_operation_mask: usize) -> usize {
  if source_operation_mask & 16 != 0 {
    16
  } else if source_operation_mask & 1 != 0 {
    1
  } else {
    0
  }
}

/// OLE supplies fresh grfKeyState and allowed effects on every callback.
/// Negotiate one supported action and publish that same action to the observer.
pub fn ole_operation(key_state: u32, allowed_effects: u32) -> u32 {
  let preferred = if key_state & 8 != 0 { 1 } else { 2 }; // MK_CONTROL
  if allowed_effects & preferred != 0 {
    preferred
  } else if allowed_effects & 1 != 0 {
    1
  } else {
    0
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  #[test]
  fn action_changes_are_not_keyboard_cache_changes() {
    for (selected_action, suggested_action, copying) in [
      (4, 2, false),
      (2, 4, true),
      (0, 2, true),
      (0, 4, false),
      (0, 0, false),
    ] {
      assert_eq!(
        copy_modifier(PlatformDragIntent::Gtk {
          selected_action,
          suggested_action
        }),
        copying
      );
    }
    for (source_operation_mask, copying) in [
      (1, true),
      (17, false),
      (16, false),
      (0, false),
      (5, true),
      (2, false),
      (4, false),
    ] {
      assert_eq!(
        copy_modifier(PlatformDragIntent::AppKit {
          source_operation_mask
        }),
        copying
      );
    }
    for (keys, allowed, effect) in [(8, 3, 1), (0, 3, 2), (0, 1, 1), (8, 2, 0), (8, 0, 0)] {
      let actual = ole_operation(keys, allowed);
      assert_eq!(actual, effect);
      assert_eq!(
        copy_modifier(PlatformDragIntent::Ole { effect: actual }),
        effect == 1
      );
    }
  }
}

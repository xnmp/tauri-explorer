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
    // AppKit filters this mask with the current drag modifiers. Derive the
    // internal action independently of the Copy/None OS acknowledgement.
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
/// Derive internal intent; this is never the effect acknowledged to OLE.
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

/// Final GTK acknowledgement. Move may be selected during negotiation to
/// capture intent, but completion requires Copy support and never deletes data.
pub fn gtk_drop_effect(
  allowed_actions: u32,
  selected_action: u32,
  protocol: i32,
  accepted: bool,
) -> u32 {
  // Only GDK_DRAG_PROTO_XDND (2) can safely rewrite the final action.
  // Wayland cannot change a non-Ask action after Drop, offers all actions even
  // for a Copy preference, and GTK3 destination contexts report protocol None.
  // Every other/unknown protocol must already have negotiated Copy.
  if accepted && allowed_actions & 2 != 0 && (protocol == 2 || selected_action == 2) {
    2
  } else {
    0
  }
}

/// AppKit uses the destination's returned operation for source cleanup.
/// Reject Move-only sources rather than return an operation they did not offer.
pub fn appkit_drop_effect(source_operation_mask: usize, accepted: bool) -> usize {
  if accepted && source_operation_mask & 1 != 0 {
    1
  } else {
    0
  }
}

/// Used for every OLE response, separately from callback-time intent.
pub fn ole_drop_effect(allowed_effects: u32, accepted: bool) -> u32 {
  if accepted && allowed_effects & 1 != 0 {
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

#[cfg(test)]
mod effect_tests {
  use super::*;

  #[test]
  fn gtk_never_finishes_move_and_keeps_negotiated_intent() {
    for allowed in 0..64 {
      for accepted in [false, true] {
        assert!(matches!(gtk_drop_effect(allowed, 4, 2, accepted), 0 | 2));
        assert_ne!(gtk_drop_effect(allowed, 4, 2, accepted), 4);
      }
    }
    for protocol in [0, 1, 3, 4, 5, 6, 7, i32::MIN, i32::MAX] {
      assert_eq!(gtk_drop_effect(6, 4, protocol, true), 0);
      assert_eq!(gtk_drop_effect(6, 2, protocol, true), 2);
      assert_eq!(gtk_drop_effect(6, 2, protocol, false), 0);
    }
    for negotiated in [0, 4, 8, 16, 32, 6] {
      assert_eq!(gtk_drop_effect(6, negotiated, 7, true), 0);
    }
    assert_eq!(gtk_drop_effect(6, 4, 2, false), 0);
    assert_eq!(gtk_drop_effect(4, 4, 2, true), 0);
    assert_eq!(gtk_drop_effect(2, 2, 2, true), 2);
    for (selected_action, suggested_action, copying) in [
      (4, 2, false),
      (2, 4, true),
      (4, 2, false),
      (0, 2, true),
      (0, 4, false),
    ] {
      assert_eq!(
        copy_modifier(PlatformDragIntent::Gtk {
          selected_action,
          suggested_action
        }),
        copying
      );
      assert_eq!(gtk_drop_effect(6, 4, 2, true), 2);
    }
  }

  #[test]
  fn appkit_never_reports_move_and_keeps_modifier_filtered_intent() {
    for mask in 0..64 {
      for accepted in [false, true] {
        assert!(matches!(appkit_drop_effect(mask, accepted), 0 | 1));
        assert_ne!(appkit_drop_effect(mask, accepted), 16);
      }
    }
    for (source_operation_mask, copying) in [(17, false), (1, true), (17, false)] {
      assert_eq!(
        copy_modifier(PlatformDragIntent::AppKit {
          source_operation_mask
        }),
        copying
      );
      assert_eq!(appkit_drop_effect(source_operation_mask, true), 1);
    }
    assert_eq!(appkit_drop_effect(16, true), 0);
    assert_eq!(appkit_drop_effect(17, false), 0);
    assert_eq!(appkit_drop_effect(0, true), 0);
  }

  #[test]
  fn ole_never_reports_move_and_keeps_fresh_key_state_intent() {
    for allowed in 0..8 {
      for accepted in [false, true] {
        assert!(matches!(ole_drop_effect(allowed, accepted), 0 | 1));
        assert_ne!(ole_drop_effect(allowed, accepted), 2);
      }
    }
    for (keys, copying) in [(0, false), (8, true), (0, false)] {
      assert_eq!(
        copy_modifier(PlatformDragIntent::Ole {
          effect: ole_operation(keys, 3)
        }),
        copying
      );
      assert_eq!(ole_drop_effect(3, true), 1);
    }
    assert_eq!(ole_drop_effect(2, true), 0);
    assert_eq!(ole_drop_effect(3, false), 0);
    assert_eq!(ole_drop_effect(0, true), 0);
  }
}

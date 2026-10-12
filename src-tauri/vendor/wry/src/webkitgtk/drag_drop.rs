// Copyright 2020-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use std::{
  cell::{Cell, UnsafeCell},
  path::PathBuf,
  rc::Rc,
};

use gtk::{
  glib::{translate::IntoGlib, GString},
  prelude::*,
};
use webkit2gtk::WebView;

use crate::DragDropEvent;

#[derive(PartialEq, Eq, PartialOrd, Ord, Clone, Copy, Debug)]
enum DragControllerState {
  Entered,
  Leaving,
  Left,
}

struct DragDropController {
  paths: UnsafeCell<Option<Vec<PathBuf>>>,
  state: Cell<DragControllerState>,
  position: Cell<(i32, i32)>,
  handler: Box<dyn Fn(DragDropEvent) -> bool>,
}

impl DragDropController {
  fn new(handler: Box<dyn Fn(DragDropEvent) -> bool>) -> Self {
    Self {
      handler,
      paths: UnsafeCell::new(None),
      state: Cell::new(DragControllerState::Left),
      position: Cell::new((0, 0)),
    }
  }

  fn store_paths(&self, paths: Vec<PathBuf>) {
    unsafe { *self.paths.get() = Some(paths) };
  }

  fn take_paths(&self) -> Option<Vec<PathBuf>> {
    unsafe { &mut *self.paths.get() }.take()
  }

  fn store_position(&self, position: (i32, i32)) {
    self.position.replace(position);
  }

  fn enter(&self) {
    self.state.set(DragControllerState::Entered);
  }

  fn leaving(&self) {
    self.state.set(DragControllerState::Leaving);
  }

  fn leave(&self) {
    self.state.set(DragControllerState::Left);
  }

  fn state(&self) -> DragControllerState {
    self.state.get()
  }

  fn call(&self, webview: &WebView, context: &gtk::gdk::DragContext, event: DragDropEvent) -> bool {
    let copying =
      crate::drag_drop_intent::copy_modifier(crate::drag_drop_intent::PlatformDragIntent::Gtk {
        selected_action: context.selected_action().bits(),
        suggested_action: context.suggested_action().bits(),
      });
    crate::drag_drop_snapshot::dispatch(window_id(webview), copying, event, &*self.handler)
  }
}

fn window_id(webview: &WebView) -> usize {
  webview
    .toplevel()
    .map(|window| window.as_ptr() as usize)
    .unwrap_or(0)
}

pub(crate) fn connect_drag_event(webview: &WebView, handler: Box<dyn Fn(DragDropEvent) -> bool>) {
  let controller = Rc::new(DragDropController::new(handler));

  {
    let controller = controller.clone();
    webview.connect_drag_data_received(move |webview, ctx, _, _, data, info, _| {
      if info == 2 {
        let uris = data.uris();
        let paths = uris.iter().map(path_buf_from_uri).collect::<Vec<_>>();
        controller.enter();
        controller.call(
          webview,
          ctx,
          DragDropEvent::Enter {
            paths: paths.clone(),
            position: controller.position.get(),
          },
        );
        controller.store_paths(paths);
      }
    });
  }

  {
    let controller = controller.clone();
    webview.connect_drag_motion(move |webview, ctx, x, y, _| {
      if controller.state() == DragControllerState::Entered {
        controller.call(webview, ctx, DragDropEvent::Over { position: (x, y) });
      } else {
        controller.store_position((x, y));
      }
      false
    });
  }

  {
    let controller = controller.clone();
    webview.connect_drag_drop(move |webview, ctx, x, y, time| {
      if controller.state() == DragControllerState::Leaving {
        if let Some(paths) = controller.take_paths() {
          // Snapshot the negotiated/suggested intent BEFORE changing the
          // final protocol action. Never ask GTK to delete source data.
          let allowed = ctx.actions().bits();
          let selected = ctx.selected_action().bits();
          // GTK3 Wayland destination contexts can report protocol None.
          // Only verified Xdnd permits final-action rewriting.
          let protocol = ctx.protocol().into_glib();
          let supported =
            crate::drag_drop_intent::gtk_drop_effect(allowed, selected, protocol, true) != 0;
          let accepted = supported
            && !paths.is_empty()
            && controller.call(
              webview,
              ctx,
              DragDropEvent::Drop {
                paths,
                position: (x, y),
              },
            );
          if !accepted {
            // Drop suppresses the deferred Leave queued by GTK. Rejection must
            // still retire the receiver and frontend hover/source identity.
            controller.call(webview, ctx, DragDropEvent::Leave);
          }
          let effect =
            crate::drag_drop_intent::gtk_drop_effect(allowed, selected, protocol, accepted);
          ctx.drag_status(gtk::gdk::DragAction::from_bits_truncate(effect), time);
          ctx.drag_finish(effect != 0, false, time);
          controller.leave();
          // Consume rejection too: WebKit's default must not acknowledge Move.
          return true;
        }
      }

      if controller.state() != DragControllerState::Left {
        controller.call(webview, ctx, DragDropEvent::Leave);
        controller.leave();
      }
      ctx.drag_status(gtk::gdk::DragAction::empty(), time);
      ctx.drag_finish(false, false, time);
      true
    });
  }

  webview.connect_drag_leave(move |webview, _, _| {
    if controller.state() != DragControllerState::Left {
      controller.leaving();
      let controller = controller.clone();
      let window = window_id(webview);
      let original_view = webview.downgrade();
      let original_window = webview.toplevel().map(|window| window.downgrade());
      gtk::glib::idle_add_local_once(move || {
        if controller.state() == DragControllerState::Leaving {
          controller.leave();
          crate::drag_drop_snapshot::dispatch_deferred(
            window,
            false,
            DragDropEvent::Leave,
            || {
              let view = original_view.upgrade()?;
              let original_window = original_window.as_ref()?.upgrade()?;
              // A destroyed/reparented view cannot attribute a delayed Leave
              // to a new top-level window reusing the old GTK address.
              (view.toplevel().as_ref() == Some(&original_window))
                .then_some(original_window.as_ptr() as usize)
            },
            &*controller.handler,
          );
        }
      });
    }
  });
}

fn path_buf_from_uri(gstr: &GString) -> PathBuf {
  let path = gstr.as_str();
  let path = path.strip_prefix("file://").unwrap_or(path);
  let path = percent_encoding::percent_decode(path.as_bytes())
    .decode_utf8_lossy()
    .to_string();
  PathBuf::from(path)
}

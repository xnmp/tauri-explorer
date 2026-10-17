// Copyright 2020-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use std::{
  cell::{Cell, RefCell, UnsafeCell},
  path::PathBuf,
  rc::Rc,
};

use gtk::{glib::GString, prelude::*};
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
  context: RefCell<Option<gtk::gdk::DragContext>>,
  source: Cell<crate::drag_drop_snapshot::SourceSnapshot>,
  inside: Cell<bool>,
  generation: Cell<u64>,
  entered_at: Cell<u32>,
  position: Cell<(i32, i32)>,
  handler: Box<dyn Fn(DragDropEvent) -> bool>,
}

impl DragDropController {
  fn new(handler: Box<dyn Fn(DragDropEvent) -> bool>) -> Self {
    Self {
      handler,
      paths: UnsafeCell::new(None),
      state: Cell::new(DragControllerState::Left),
      context: RefCell::new(None),
      source: Cell::new(Default::default()),
      inside: Cell::new(false),
      generation: Cell::new(0),
      entered_at: Cell::new(0),
      position: Cell::new((0, 0)),
    }
  }

  fn store_paths(&self, paths: Vec<PathBuf>, context: &gtk::gdk::DragContext) {
    self.context.replace(Some(context.clone()));
    unsafe { *self.paths.get() = Some(paths) };
  }

  fn take_paths(&self) -> Option<Vec<PathBuf>> {
    unsafe { &mut *self.paths.get() }.take()
  }

  fn owns_context(&self, context: &gtk::gdk::DragContext) -> bool {
    self.context.borrow().as_ref() == Some(context)
  }

  fn observe_context(&self, context: &gtk::gdk::DragContext, time: u32) {
    if !self.owns_context(context) || !self.inside.get() {
      self.context.replace(Some(context.clone()));
      let window =
        unsafe { gtk::gdk::ffi::gdk_drag_context_get_source_window(context.as_ptr()) } as usize;
      self.source.set(crate::drag_drop_snapshot::resolve_source(
        (window != 0).then_some(window),
        Some(context.drag_get_source_widget().is_some()),
      ));
      unsafe { *self.paths.get() = None };
      self.leave();
      self.inside.set(true);
      self.generation.set(self.generation.get().wrapping_add(1));
      self.entered_at.set(time);
    }
  }

  fn accepts_data(&self, context: &gtk::gdk::DragContext, time: u32) -> bool {
    self.owns_context(context)
      && self.inside.get()
      && (if time == 0 {
        self.source.get().local != Some(true)
      } else {
        time.wrapping_sub(self.entered_at.get()) as i32 >= 0
      })
  }

  fn filesystem_paths(&self) -> bool {
    // SAFETY: GTK invokes this controller only on its owning main thread.
    unsafe { &*self.paths.get() }
      .as_ref()
      .is_some_and(|paths| !paths.is_empty() && paths.iter().all(|path| path.is_absolute()))
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
    self.inside.set(false);
    self.state.set(DragControllerState::Left);
  }

  fn state(&self) -> DragControllerState {
    self.state.get()
  }

  fn snapshot(
    &self,
    webview: &WebView,
    _: &gtk::gdk::DragContext,
  ) -> (bool, crate::drag_drop_snapshot::SourceSnapshot) {
    let copying = gtk::gdk::Keymap::for_display(&webview.display()).is_some_and(|keymap| {
      keymap.modifier_state() & gtk::gdk::ModifierType::CONTROL_MASK.bits() != 0
    });
    (copying, self.source.get())
  }

  fn call_snapshot(
    &self,
    webview: &WebView,
    event: DragDropEvent,
    snapshot: (bool, crate::drag_drop_snapshot::SourceSnapshot),
  ) -> bool {
    crate::drag_drop_snapshot::dispatch_with_source_snapshot(
      window_id(webview),
      snapshot.0,
      event,
      snapshot.1,
      &*self.handler,
    )
  }

  fn call(&self, webview: &WebView, event: DragDropEvent, context: &gtk::gdk::DragContext) -> bool {
    self.call_snapshot(webview, event, self.snapshot(webview, context))
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
    webview.connect_drag_data_received(move |webview, context, _, _, data, info, time| {
      if info == 2 && data.length() > 0 && controller.accepts_data(context, time) {
        let uris = data.uris();
        if uris.is_empty() {
          return;
        }
        let paths = uris.iter().map(path_buf_from_uri).collect::<Vec<_>>();
        controller.enter();
        controller.call(
          webview,
          DragDropEvent::Enter {
            paths: paths.clone(),
            position: controller.position.get(),
          },
          context,
        );
        controller.store_paths(paths, context);
      }
    });
  }

  {
    let controller = controller.clone();
    webview.connect_drag_motion(move |webview, context, x, y, time| {
      controller.observe_context(context, time);
      if controller.state() == DragControllerState::Entered && controller.owns_context(context) {
        let accepted = controller.call(webview, DragDropEvent::Over { position: (x, y) }, context);
        if accepted && controller.filesystem_paths() {
          // The host owns this filesystem receiver. Acknowledge Copy only:
          // internal move intent is separate, and WebKit must not negotiate a
          // second DOM destination or request deletion from an external app.
          let action = if context.actions().contains(gtk::gdk::DragAction::COPY) {
            gtk::gdk::DragAction::COPY
          } else {
            gtk::gdk::DragAction::empty()
          };
          context.drag_status(action, time);
          return true;
        }
      } else {
        controller.store_position((x, y));
      }
      false
    });
  }

  {
    let controller = controller.clone();
    webview.connect_drag_drop(move |webview, ctx, x, y, time| {
      let snapshot = controller.snapshot(webview, ctx);
      if controller.state() == DragControllerState::Leaving && controller.owns_context(ctx) {
        if let Some(paths) = controller.take_paths() {
          if paths.iter().all(|path| path.is_absolute())
            && !ctx.actions().contains(gtk::gdk::DragAction::COPY)
          {
            ctx.drop_finish(false, time);
            controller.leave();
            controller.call_snapshot(webview, DragDropEvent::Leave, snapshot);
            return true;
          }
          ctx.drop_finish(true, time);
          controller.leave();
          return controller.call_snapshot(
            webview,
            DragDropEvent::Drop {
              paths,
              position: (x, y),
            },
            snapshot,
          );
        }
      }

      false
    });
  }

  webview.connect_drag_leave(move |webview, context, _| {
    if !controller.owns_context(context) {
      return;
    }
    // GDK Wayland reuses one destination context per seat. Leave is a real
    // boundary even if its asynchronous URI request never produced Enter.
    controller.inside.set(false);
    if controller.state() != DragControllerState::Left {
      controller.leaving();
      let controller = controller.clone();
      let window = window_id(webview);
      let original_context = context.clone();
      let original_generation = controller.generation.get();
      let original_view = webview.downgrade();
      let original_window = webview.toplevel().map(|window| window.downgrade());
      gtk::glib::idle_add_local_once(move || {
        if controller.state() == DragControllerState::Leaving
          && controller.owns_context(&original_context)
          && controller.generation.get() == original_generation
        {
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

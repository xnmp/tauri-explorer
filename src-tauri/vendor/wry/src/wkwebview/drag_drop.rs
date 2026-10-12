// Copyright 2020-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use std::{ffi::CStr, path::PathBuf};

use objc2::{
  runtime::{Bool, ProtocolObject},
  DeclaredClass,
};
use objc2_app_kit::{NSDragOperation, NSDraggingInfo, NSFilenamesPboardType};
use objc2_foundation::{NSArray, NSPoint, NSRect, NSString};

use crate::DragDropEvent;

use super::WryWebView;

fn reported_operation(
  drag_info: &ProtocolObject<dyn NSDraggingInfo>,
  accepted: bool,
) -> NSDragOperation {
  NSDragOperation::from_bits_truncate(crate::drag_drop_intent::appkit_drop_effect(
    unsafe { drag_info.draggingSourceOperationMask() }.bits(),
    accepted,
  ))
}

fn call(
  this: &WryWebView,
  drag_info: &ProtocolObject<dyn NSDraggingInfo>,
  event: DragDropEvent,
) -> bool {
  let window = this
    .window()
    .map(|window| (&*window as *const _) as usize)
    .unwrap_or(0);
  let copying =
    crate::drag_drop_intent::copy_modifier(crate::drag_drop_intent::PlatformDragIntent::AppKit {
      source_operation_mask: unsafe { drag_info.draggingSourceOperationMask() }.bits(),
    });
  crate::drag_drop_snapshot::dispatch(window, copying, event, &*this.ivars().drag_drop_handler)
}

pub(crate) unsafe fn collect_paths(drag_info: &ProtocolObject<dyn NSDraggingInfo>) -> Vec<PathBuf> {
  let pb = drag_info.draggingPasteboard();
  let mut drag_drop_paths = Vec::new();
  let types = NSArray::arrayWithObject(NSFilenamesPboardType);

  if pb.availableTypeFromArray(&types).is_some() {
    let paths = pb.propertyListForType(NSFilenamesPboardType).unwrap();
    let paths = paths.downcast::<NSArray>().unwrap();
    for path in paths {
      let path = path.downcast::<NSString>().unwrap();
      let path = CStr::from_ptr(path.UTF8String()).to_string_lossy();
      drag_drop_paths.push(PathBuf::from(path.into_owned()));
    }
  }
  drag_drop_paths
}

pub(crate) fn dragging_entered(
  this: &WryWebView,
  drag_info: &ProtocolObject<dyn NSDraggingInfo>,
) -> NSDragOperation {
  let paths = unsafe { collect_paths(drag_info) };
  let dl: NSPoint = unsafe { drag_info.draggingLocation() };
  let frame: NSRect = this.frame();
  let position = (dl.x as i32, (frame.size.height - dl.y) as i32);

  let accepted =
    !paths.is_empty() && call(this, drag_info, DragDropEvent::Enter { paths, position });
  reported_operation(drag_info, accepted)
}

pub(crate) fn dragging_updated(
  this: &WryWebView,
  drag_info: &ProtocolObject<dyn NSDraggingInfo>,
) -> NSDragOperation {
  let dl: NSPoint = unsafe { drag_info.draggingLocation() };
  let frame: NSRect = this.frame();
  let position = (dl.x as i32, (frame.size.height - dl.y) as i32);

  let accepted = call(this, drag_info, DragDropEvent::Over { position });
  reported_operation(drag_info, accepted)
}

pub(crate) fn perform_drag_operation(
  this: &WryWebView,
  drag_info: &ProtocolObject<dyn NSDraggingInfo>,
) -> Bool {
  if reported_operation(drag_info, true) == NSDragOperation::None {
    return Bool::NO;
  }
  let paths = unsafe { collect_paths(drag_info) };
  let dl: NSPoint = unsafe { drag_info.draggingLocation() };
  let frame: NSRect = this.frame();
  let position = (dl.x as i32, (frame.size.height - dl.y) as i32);

  Bool::new(!paths.is_empty() && call(this, drag_info, DragDropEvent::Drop { paths, position }))
}

pub(crate) fn dragging_exited(this: &WryWebView, drag_info: &ProtocolObject<dyn NSDraggingInfo>) {
  call(this, drag_info, DragDropEvent::Leave);
}

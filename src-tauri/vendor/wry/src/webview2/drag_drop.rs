// Copyright 2020-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

// A silly implementation of file drop handling for Windows!

use crate::DragDropEvent;

use std::{
  cell::UnsafeCell,
  ffi::OsString,
  os::{raw::c_void, windows::ffi::OsStringExt},
  path::PathBuf,
  ptr,
  rc::Rc,
};

use windows::{
  core::{implement, BOOL},
  Win32::{
    Foundation::{DRAGDROP_E_INVALIDHWND, HWND, LPARAM, POINT, POINTL},
    Graphics::Gdi::ScreenToClient,
    System::{
      Com::{IDataObject, DVASPECT_CONTENT, FORMATETC, TYMED_HGLOBAL},
      Ole::{
        IDropTarget, IDropTarget_Impl, RegisterDragDrop, RevokeDragDrop, CF_HDROP, DROPEFFECT,
        DROPEFFECT_NONE,
      },
      SystemServices::MODIFIERKEYS_FLAGS,
    },
    UI::{
      Shell::{DragFinish, DragQueryFileW, HDROP},
      WindowsAndMessaging::{EnumChildWindows, GetAncestor, GA_ROOT},
    },
  },
};

#[derive(Default)]
pub(crate) struct DragDropController {
  drop_targets: Vec<IDropTarget>,
}

impl DragDropController {
  #[inline]
  pub(crate) fn new(hwnd: HWND, handler: Box<dyn Fn(DragDropEvent) -> bool>) -> Self {
    let mut controller = DragDropController::default();

    let handler = Rc::new(handler);

    // Enumerate child windows to find the WebView2 "window" and override!
    {
      let mut callback = |hwnd| controller.inject_in_hwnd(hwnd, handler.clone());
      let mut trait_obj: &mut dyn FnMut(HWND) -> bool = &mut callback;
      let closure_pointer_pointer: *mut c_void = unsafe { std::mem::transmute(&mut trait_obj) };
      let lparam = LPARAM(closure_pointer_pointer as _);
      unsafe extern "system" fn enumerate_callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let closure = &mut *(lparam.0 as *mut c_void as *mut &mut dyn FnMut(HWND) -> bool);
        closure(hwnd).into()
      }
      let _ = unsafe { EnumChildWindows(Some(hwnd), Some(enumerate_callback), lparam) };
    }

    controller
  }

  #[inline]
  fn inject_in_hwnd(&mut self, hwnd: HWND, handler: Rc<dyn Fn(DragDropEvent) -> bool>) -> bool {
    let drag_drop_target: IDropTarget = DragDropTarget::new(hwnd, handler).into();
    if unsafe { RevokeDragDrop(hwnd) } != Err(DRAGDROP_E_INVALIDHWND.into())
      && unsafe { RegisterDragDrop(hwnd, &drag_drop_target) }.is_ok()
    {
      self.drop_targets.push(drag_drop_target);
    }

    true
  }
}

#[implement(IDropTarget)]
pub struct DragDropTarget {
  hwnd: HWND,
  listener: Rc<dyn Fn(DragDropEvent) -> bool>,
  enter_is_valid: UnsafeCell<bool>, /* If the currently hovered item is not valid there must not be any `HoveredFileCancelled` emitted */
}

impl DragDropTarget {
  fn call(&self, event: DragDropEvent, effect: DROPEFFECT) -> bool {
    let window = unsafe { GetAncestor(self.hwnd, GA_ROOT) };
    crate::drag_drop_snapshot::dispatch(
      window.0 as usize,
      crate::drag_drop_intent::copy_modifier(crate::drag_drop_intent::PlatformDragIntent::Ole {
        effect: effect.0,
      }),
      event,
      &*self.listener,
    )
  }
  pub fn new(hwnd: HWND, listener: Rc<dyn Fn(DragDropEvent) -> bool>) -> DragDropTarget {
    Self {
      hwnd,
      listener,
      enter_is_valid: false.into(),
    }
  }

  unsafe fn iterate_filenames<F>(
    data_obj: windows_core::Ref<'_, IDataObject>,
    mut callback: F,
  ) -> Option<HDROP>
  where
    F: FnMut(PathBuf),
  {
    let drop_format = FORMATETC {
      cfFormat: CF_HDROP.0,
      ptd: ptr::null_mut(),
      dwAspect: DVASPECT_CONTENT.0,
      lindex: -1,
      tymed: TYMED_HGLOBAL.0 as u32,
    };

    match data_obj
      .as_ref()
      .expect("Received null IDataObject")
      .GetData(&drop_format)
    {
      Ok(medium) => {
        let hdrop = HDROP(medium.u.hGlobal.0 as _);

        // The second parameter (0xFFFFFFFF) instructs the function to return the item count
        let item_count = DragQueryFileW(hdrop, 0xFFFFFFFF, None);

        for i in 0..item_count {
          // Get the length of the path string NOT including the terminating null character.
          // Previously, this was using a fixed size array of MAX_PATH length, but the
          // Windows API allows longer paths under certain circumstances.
          let character_count = DragQueryFileW(hdrop, i, None) as usize;

          // Fill path_buf with the null-terminated file name
          let str_len = character_count + 1;
          let mut path_buf = vec![0; str_len];
          DragQueryFileW(hdrop, i, Some(&mut path_buf));
          callback(OsString::from_wide(&path_buf[0..character_count]).into());
        }

        Some(hdrop)
      }
      Err(_error) => {
        #[cfg(feature = "tracing")]
        tracing::warn!(
          "{}",
          match _error.code() {
            windows::Win32::Foundation::DV_E_FORMATETC => {
              // If the dropped item is not a file this error will occur.
              // In this case it is OK to return without taking further action.
              "Error occurred while processing dropped/hovered item: item is not a file."
            }
            _ => "Unexpected error occurred while processing dropped/hovered item.",
          }
        );
        None
      }
    }
  }
}

#[allow(non_snake_case)]
impl IDropTarget_Impl for DragDropTarget_Impl {
  fn DragEnter(
    &self,
    pDataObj: windows_core::Ref<'_, IDataObject>,
    grfKeyState: MODIFIERKEYS_FLAGS,
    pt: &POINTL,
    pdwEffect: *mut DROPEFFECT,
  ) -> windows::core::Result<()> {
    let mut pt = POINT { x: pt.x, y: pt.y };
    let _ = unsafe { ScreenToClient(self.hwnd, &mut pt) };

    let mut paths = Vec::new();
    let hdrop = unsafe { DragDropTarget::iterate_filenames(pDataObj, |path| paths.push(path)) };

    let enter_is_valid = hdrop.is_some() && !paths.is_empty();

    if !enter_is_valid {
      unsafe {
        *self.enter_is_valid.get() = false;
        *pdwEffect = DROPEFFECT_NONE;
      }
      return Ok(());
    };

    unsafe {
      *self.enter_is_valid.get() = enter_is_valid;
    }

    let allowed = unsafe { (*pdwEffect).0 };
    let cursor_effect = DROPEFFECT(crate::drag_drop_intent::ole_operation(
      grfKeyState.0,
      allowed,
    ));
    let accepted = self.call(
      DragDropEvent::Enter {
        paths,
        position: (pt.x as _, pt.y as _),
      },
      cursor_effect,
    );

    unsafe {
      *pdwEffect = DROPEFFECT(crate::drag_drop_intent::ole_drop_effect(allowed, accepted));
    }

    Ok(())
  }

  fn DragOver(
    &self,
    grfKeyState: MODIFIERKEYS_FLAGS,
    pt: &POINTL,
    pdwEffect: *mut DROPEFFECT,
  ) -> windows::core::Result<()> {
    let allowed = unsafe { (*pdwEffect).0 };
    let intent = DROPEFFECT(crate::drag_drop_intent::ole_operation(
      grfKeyState.0,
      allowed,
    ));
    let accepted = if unsafe { *self.enter_is_valid.get() } {
      let mut pt = POINT { x: pt.x, y: pt.y };
      let _ = unsafe { ScreenToClient(self.hwnd, &mut pt) };
      self.call(
        DragDropEvent::Over {
          position: (pt.x as _, pt.y as _),
        },
        intent,
      )
    } else {
      false
    };
    unsafe {
      *pdwEffect = DROPEFFECT(crate::drag_drop_intent::ole_drop_effect(allowed, accepted));
    }
    Ok(())
  }

  fn DragLeave(&self) -> windows::core::Result<()> {
    if unsafe { *self.enter_is_valid.get() } {
      self.call(DragDropEvent::Leave, DROPEFFECT_NONE);
    }
    Ok(())
  }

  fn Drop(
    &self,
    pDataObj: windows_core::Ref<'_, IDataObject>,
    grfKeyState: MODIFIERKEYS_FLAGS,
    pt: &POINTL,
    pdwEffect: *mut DROPEFFECT,
  ) -> windows::core::Result<()> {
    let allowed = unsafe { (*pdwEffect).0 };
    let intent = DROPEFFECT(crate::drag_drop_intent::ole_operation(
      grfKeyState.0,
      allowed,
    ));
    // Clear the output on every failure path, including a Drop without Enter.
    unsafe { *pdwEffect = DROPEFFECT_NONE };
    let valid = unsafe { *self.enter_is_valid.get() };
    unsafe { *self.enter_is_valid.get() = false };
    if !valid || crate::drag_drop_intent::ole_drop_effect(allowed, true) == 0 {
      self.call(DragDropEvent::Leave, DROPEFFECT_NONE);
      return Ok(());
    }
    let mut pt = POINT { x: pt.x, y: pt.y };
    let _ = unsafe { ScreenToClient(self.hwnd, &mut pt) };
    let mut paths = Vec::new();
    let hdrop = unsafe { DragDropTarget::iterate_filenames(pDataObj, |path| paths.push(path)) };
    let accepted = if hdrop.is_some() && !paths.is_empty() {
      self.call(
        DragDropEvent::Drop {
          paths,
          position: (pt.x as _, pt.y as _),
        },
        intent,
      )
    } else {
      self.call(DragDropEvent::Leave, DROPEFFECT_NONE);
      false
    };
    unsafe {
      *pdwEffect = DROPEFFECT(crate::drag_drop_intent::ole_drop_effect(allowed, accepted));
    }
    if let Some(hdrop) = hdrop {
      unsafe { DragFinish(hdrop) };
    }

    Ok(())
  }
}

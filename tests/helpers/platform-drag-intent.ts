/** Compile the production callback expressions and GTK Drop body with inert
 * platform adapters. This checks callback control flow, not physical OS delivery.
 * No alternative intent/effect policy is implemented in this fixture. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execute = promisify(execFile);
const gtkSource = readFileSync("src-tauri/vendor/wry/src/webkitgtk/drag_drop.rs", "utf8");
const macSource = readFileSync("src-tauri/vendor/wry/src/wkwebview/drag_drop.rs", "utf8");
const windowsSource = readFileSync("src-tauri/vendor/wry/src/webview2/drag_drop.rs", "utf8");
function match(source: string, pattern: RegExp): string {
  const value = source.match(pattern)?.[1];
  if (!value) throw new Error(`Native callback fixture needs updating: ${pattern}`);
  return value;
}
function body(source: string, marker: string): string {
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`Missing production callback: ${marker}`);
  const brace = source.indexOf("{", start + marker.length);
  let depth = 1, end = brace + 1;
  while (depth && end < source.length) {
    if (source[end] === "{") depth++;
    if (source[end] === "}") depth--;
    end++;
  }
  if (depth) throw new Error(`Unbalanced production callback: ${marker}`);
  return source.slice(brace + 1, end - 1);
}
const gtkCopy = match(gtkSource, /let copying = ([\s\S]*?);\n/);
const macCopy = match(macSource, /let copying = ([\s\S]*?);\n/);
const windowsCopy = match(windowsSource, /window\.0 as usize,\s*([^,]+),/);
const gtkMotion = body(gtkSource, "webview.connect_drag_motion(move |webview, context, x, y, time|");
const gtkOwnsContext = body(gtkSource, "  fn owns_context(");
const gtkObserveContext = body(gtkSource, "  fn observe_context(");
const gtkAcceptsData = body(gtkSource, "  fn accepts_data(");
const gtkStorePaths = body(gtkSource, "  fn store_paths(");
const gtkReceived = body(gtkSource, "webview.connect_drag_data_received(move |webview, context, _, _, data, info, time|");
const gtkLeave = body(gtkSource, "webview.connect_drag_leave(move |webview, context, _|");
const gtkLeaveBoundary = gtkLeave.slice(0, gtkLeave.indexOf("    if controller.state()"));
if (!gtkLeaveBoundary.trim()) throw new Error("Missing GTK receiver leave boundary");
const gtkDeferredLeave = match(gtkLeave, /if (controller\.state\(\) == DragControllerState::Leaving[\s\S]*?)\n\s*\{\n\s*controller\.leave\(\);/);
const gtkSnapshot = body(gtkSource, "  fn snapshot(");
const gtkFilesystem = body(gtkSource, "  fn filesystem_paths(");
const gtkDrop = body(gtkSource, "webview.connect_drag_drop(move |webview, ctx, x, y, time|");
const windowsEffect = match(windowsSource, /let cursor_effect = ([\s\S]*?);\n/);
const windowsDrop = body(windowsSource, "  fn Drop(");
const windowsOver = body(windowsSource, "  fn DragOver(");
const macEffect = (callback: string) => match(body(macSource, `pub(crate) fn ${callback}(`),
  /} else \{\s*(NSDragOperation::\w+|Bool::\w+)\s*\}\s*$/).trim();

const folder = mkdtempSync(join(tmpdir(), "pdlg-intent-"));
let results: Map<string, string>;
export let nativeCallbackTestResult: string;
try {
  const source = join(folder, "main.rs"), binary = join(folder, "intent");
  writeFileSync(source, `
use std::cell::{Cell, RefCell, UnsafeCell};
use std::path::PathBuf;
#[derive(Clone, Copy, PartialEq)] enum DragControllerState { Entered, Leaving, Left }
#[derive(Clone)] enum DragDropEvent { Enter { paths: Vec<PathBuf>, position: (i32, i32) }, Over { position: (i32, i32) }, Drop { paths: Vec<PathBuf>, position: (i32, i32) }, Leave }
struct Controller { state: Cell<DragControllerState>, inside: Cell<bool>, generation: Cell<u64>, entered_at: Cell<u32>, position: Cell<(i32,i32)>, paths: UnsafeCell<Option<Vec<PathBuf>>>, delivered: Cell<bool>, enters: Cell<u32>, leaves: Cell<u32>, accepted: bool, context: RefCell<Option<Context>>, source: Cell<drag_drop_snapshot::SourceSnapshot>, snapshot_local: Cell<Option<bool>> }
impl Controller {
  fn owns_context(&self, context: &Context) -> bool { ${gtkOwnsContext} }
  fn observe_context(&self, context: &Context, time: u32) { ${gtkObserveContext} }
  fn accepts_data(&self, context: &Context, time: u32) -> bool { ${gtkAcceptsData} }
  fn store_paths(&self, paths: Vec<PathBuf>, context: &Context) { ${gtkStorePaths} }
  fn enter(&self) { self.state.set(DragControllerState::Entered); }
  fn state(&self) -> DragControllerState { self.state.get() }
  fn take_paths(&self) -> Option<Vec<PathBuf>> { unsafe { &mut *self.paths.get() }.take() }
  fn filesystem_paths(&self) -> bool { ${gtkFilesystem} }
  fn store_position(&self, _: (i32, i32)) {}
  fn leave(&self) { self.state.set(DragControllerState::Left); }
  fn snapshot(&self, webview: &View, _: &Context) -> (bool, drag_drop_snapshot::SourceSnapshot) { ${gtkSnapshot} }
  fn call_snapshot(&self, view: &View, event: DragDropEvent, snapshot: (bool, drag_drop_snapshot::SourceSnapshot)) -> bool { self.snapshot_local.set(snapshot.1.local); self.call(view, event, &Context { id: 0, window: 77, actions: 0, source_local: Cell::new(false), finished: Cell::new(None), status: Cell::new(None) }) }
  fn call(&self, _: &View, event: DragDropEvent, _: &Context) -> bool { self.delivered.set(matches!(event, DragDropEvent::Drop { .. })); if matches!(event, DragDropEvent::Enter { .. }) { self.enters.set(self.enters.get()+1); } if matches!(event, DragDropEvent::Leave) { self.leaves.set(self.leaves.get()+1); } self.accepted }
}
mod drag_drop_snapshot {
  use std::cell::Cell;
  #[derive(Clone, Copy, Default)] pub struct SourceSnapshot { pub window: Option<usize>, pub local: Option<bool>, pub token: Option<usize> }
  thread_local! { pub static TOKEN: Cell<Option<usize>> = const { Cell::new(None) }; }
  pub fn resolve_source(window: Option<usize>, local: Option<bool>) -> SourceSnapshot { SourceSnapshot { window, local, token: TOKEN.with(Cell::get) } }
}
fn source_snapshot() -> drag_drop_snapshot::SourceSnapshot { drag_drop_snapshot::SourceSnapshot { window: Some(77), local: Some(true), token: None } }
fn context(id: usize) -> Context { Context { id, window: 77, actions: 2, source_local: Cell::new(true), finished: Cell::new(None), status: Cell::new(None) } }
struct View { modifiers: u32 }
impl View { fn display(&self) -> u32 { self.modifiers } }
mod gtk { pub mod gdk {
  pub type DragContext = crate::Context;
  pub mod ffi { pub unsafe fn gdk_drag_context_get_source_window(context: *const crate::Context) -> *mut () { (*context).window as *mut () } }
  pub struct Keymap(u32);
  impl Keymap { pub fn for_display(modifiers: &u32) -> Option<Self> { Some(Self(*modifiers)) } pub fn modifier_state(&self) -> u32 { self.0 } }
  pub struct DragAction;
  impl DragAction { pub const COPY: u32 = 2; pub fn empty() -> u32 { 0 } }
  pub struct ModifierType;
  impl ModifierType { pub const CONTROL_MASK: Self = Self; pub fn bits(&self) -> u32 { 4 } }
} }
struct NSEvent;
struct NSEventModifierFlags(u32);
impl NSEventModifierFlags { const Option: Self = Self(524288); fn contains(&self, other: Self) -> bool { self.0 & other.0 != 0 } }
thread_local! { static MAC_MODIFIERS: Cell<u32> = const { Cell::new(0) }; }
impl NSEvent { fn modifierFlags_class() -> NSEventModifierFlags { NSEventModifierFlags(MAC_MODIFIERS.with(Cell::get)) } }
struct Flags(u32);
const MK_CONTROL: Flags = Flags(8);
struct Actions(u32);
impl Actions { fn contains(&self, action: u32) -> bool { self.0 & action != 0 } }
#[derive(Clone)] struct Context { id: usize, window: usize, actions: u32, source_local: Cell<bool>, finished: Cell<Option<bool>>, status: Cell<Option<u32>> }
impl PartialEq for Context { fn eq(&self, other: &Self) -> bool { self.id == other.id } }
impl Context { fn as_ptr(&self) -> *const Self { self } fn drag_get_source_widget(&self) -> Option<()> { self.source_local.get().then_some(()) } fn actions(&self) -> Actions { Actions(self.actions) } fn drag_status(&self, action: u32, _: u32) { self.status.set(Some(action)); } fn drop_finish(&self, success: bool, _: u32) { self.finished.set(Some(success)); self.source_local.set(false); } }
struct SelectionData { length: i32, uris: Vec<String> }
impl SelectionData { fn length(&self) -> i32 { self.length } fn uris(&self) -> Vec<String> { self.uris.clone() } }
fn path_buf_from_uri(uri: &String) -> PathBuf { uri.into() }
fn gtk_received(controller: &Controller, webview: &View, context: &Context, data: &SelectionData, info: u32, time: u32) { ${gtkReceived} }
fn gtk_leave_boundary(controller: &Controller, context: &Context) { ${gtkLeaveBoundary} }
fn gtk_deferred_leave_eligible(controller: &Controller, original_context: &Context, original_generation: u64) -> bool { ${gtkDeferredLeave} }
fn gtk_motion(controller: &Controller, webview: &View, context: &Context, x: i32, y: i32, time: u32) -> bool { ${gtkMotion} }
fn gtk_drop(controller: &Controller, webview: &View, ctx: &Context, x: i32, y: i32, time: u32) -> bool { ${gtkDrop} }
const DROPEFFECT_COPY: u32 = 1;
const DROPEFFECT_NONE: u32 = 0;
struct NSDragOperation;
impl NSDragOperation { const Copy: u32 = 1; const Move: u32 = 16; }
struct Bool;
impl Bool { const YES: u32 = 1; const NO: u32 = 0; }
mod windows { pub mod core { pub type Result<T> = std::result::Result<T, ()>; pub type Ref<'a, T> = &'a T; } }
struct IDataObject;
struct POINTL { x: i32, y: i32 }
struct POINT { x: i32, y: i32 }
type DROPEFFECT = u32;
type MODIFIERKEYS_FLAGS = Flags;
fn ScreenToClient(_: u32, _: &mut POINT) -> bool { true }
fn DragFinish(_: u32) {}
struct DragDropTarget { hwnd: u32, enter_is_valid: UnsafeCell<bool>, cursor_effect: UnsafeCell<u32> }
impl DragDropTarget {
  fn iterate_filenames<F>(_: &IDataObject, mut callback: F) -> Option<u32> where F: FnMut(PathBuf) { callback("/external".into()); Some(1) }
  fn call(&self, _: DragDropEvent, _: Flags) -> bool { true }
  fn over(&self, grfKeyState: MODIFIERKEYS_FLAGS, pt: &POINTL, pdwEffect: *mut DROPEFFECT) -> windows::core::Result<()> { ${windowsOver} }
  fn drop(&self, pDataObj: windows::core::Ref<'_, IDataObject>, grfKeyState: MODIFIERKEYS_FLAGS, pt: &POINTL, _pdwEffect: *mut DROPEFFECT) -> windows::core::Result<()> {
    ${windowsDrop}
  }
}
#[cfg(test)] mod tests {
  use super::*;
  #[test] fn first_receiver_observation_pins_identity_before_asynchronous_uri_reply() {
    let controller = Controller { state: Cell::new(DragControllerState::Left),
      paths: UnsafeCell::new(None), delivered: Cell::new(false), enters: Cell::new(0), leaves: Cell::new(0), context: RefCell::new(None),
      source: Cell::new(source_snapshot()), inside: Cell::new(true), generation: Cell::new(0), entered_at: Cell::new(0), position: Cell::new((0,0)), snapshot_local: Cell::new(None), accepted: true };
    let a = context(1);
    let b = context(2); // GTK may pool the same source IPC window across owners.
    drag_drop_snapshot::TOKEN.with(|token| token.set(Some(10)));
    controller.observe_context(&a, 10);
    drag_drop_snapshot::TOKEN.with(|token| token.set(Some(20)));
    controller.observe_context(&a, 10); // A's URI reply can arrive after B starts.
    assert_eq!(controller.snapshot(&View { modifiers: 0 }, &a).1.token, Some(10));
    assert!(controller.owns_context(&a));
    controller.observe_context(&b, 20);
    assert_eq!(controller.snapshot(&View { modifiers: 0 }, &b).1.token, Some(20));
    assert!(!controller.owns_context(&a));
    gtk_received(&controller, &View { modifiers: 0 }, &a, &SelectionData { length: 5, uris: vec!["/old".into()] }, 2, 20);
    assert_eq!(controller.enters.get(), 0);
  }
  #[test] fn wayland_reused_seat_context_restarts_after_leave_even_before_uri_arrives() {
    let controller = Controller { state: Cell::new(DragControllerState::Left),
      paths: UnsafeCell::new(None), delivered: Cell::new(false), enters: Cell::new(0), leaves: Cell::new(0), context: RefCell::new(None),
      source: Cell::new(source_snapshot()), inside: Cell::new(false), generation: Cell::new(0), entered_at: Cell::new(0), position: Cell::new((0,0)), snapshot_local: Cell::new(None), accepted: true };
    let seat_context = context(1);
    drag_drop_snapshot::TOKEN.with(|token| token.set(Some(10)));
    controller.observe_context(&seat_context, 100);
    let old_generation = controller.generation.get();
    gtk_leave_boundary(&controller, &seat_context); // No URI Enter occurred.
    assert!(!controller.accepts_data(&seat_context, 100));
    drag_drop_snapshot::TOKEN.with(|token| token.set(Some(20)));
    controller.observe_context(&seat_context, 200);
    assert_eq!(controller.snapshot(&View { modifiers: 0 }, &seat_context).1.token, Some(20));
    controller.state.set(DragControllerState::Leaving);
    assert!(!gtk_deferred_leave_eligible(&controller, &seat_context, old_generation));
    assert!(gtk_deferred_leave_eligible(&controller, &seat_context, controller.generation.get()));
  }
  #[test] fn gtk_selection_admission_ignores_cancelled_old_or_unknown_local_data() {
    for (length, uris, time, local, admitted) in [
      (-1, vec![], 0, false, false),
      (0, vec!["/old"], 0, false, false),
      (5, vec![], 200, true, false),
      (5, vec!["/old"], 199, true, false),
      (5, vec!["/old"], 0, true, false),
      (5, vec!["/current"], 200, true, true),
      (5, vec!["/external"], 0, false, true),
    ] {
      let controller = Controller { state: Cell::new(DragControllerState::Left),
        paths: UnsafeCell::new(None), delivered: Cell::new(false), enters: Cell::new(0), leaves: Cell::new(0), context: RefCell::new(Some(context(1))),
        source: Cell::new(drag_drop_snapshot::SourceSnapshot { local: Some(local), ..source_snapshot() }), inside: Cell::new(true), generation: Cell::new(0), entered_at: Cell::new(200), position: Cell::new((0,0)), snapshot_local: Cell::new(None), accepted: true };
      gtk_received(&controller, &View { modifiers: 0 }, &context(1), &SelectionData { length, uris: uris.into_iter().map(str::to_owned).collect() }, 2, time);
      assert_eq!(controller.enters.get(), u32::from(admitted));
    }
  }
  fn gtk_result(uri: bool) -> (bool, bool, Option<bool>) {
    let controller = Controller { state: Cell::new(if uri { DragControllerState::Leaving } else { DragControllerState::Left }),
      paths: UnsafeCell::new(uri.then(|| vec!["urn:tauri-explorer:drag:recent".into()])), delivered: Cell::new(false), enters: Cell::new(0), leaves: Cell::new(0), context: RefCell::new(Some(context(1))), source: Cell::new(source_snapshot()), inside: Cell::new(true), generation: Cell::new(0), entered_at: Cell::new(0), position: Cell::new((0,0)), snapshot_local: Cell::new(None), accepted: true };
    let ctx = Context { id: 1, window: 77, actions: 2, source_local: Cell::new(true), finished: Cell::new(None), status: Cell::new(None) };
    let consumed = gtk_drop(&controller, &View { modifiers: 0 }, &ctx, 0, 0, 0);
    (controller.delivered.get(), consumed, ctx.finished.get())
  }
  #[test] fn gtk_filesystem_motion_owns_copy_ack_but_nonfiles_keep_dom_transport() {
    for (path, accepted, actions, id, owns, status) in [
      ("/a file#ñ", true, 2, 1, true, Some(2)),
      ("/file", true, 4, 1, true, Some(0)),
      ("/file", true, 2, 2, false, None),
      ("urn:tauri-explorer:drag:recent", true, 2, 1, false, None),
      ("/file", false, 2, 1, false, None),
    ] {
      let controller = Controller { state: Cell::new(DragControllerState::Entered),
        paths: UnsafeCell::new(Some(vec![path.into()])), delivered: Cell::new(false), enters: Cell::new(0), leaves: Cell::new(0), context: RefCell::new(Some(context(1))), source: Cell::new(source_snapshot()), inside: Cell::new(true), generation: Cell::new(0), entered_at: Cell::new(0), position: Cell::new((0,0)), snapshot_local: Cell::new(None), accepted };
      let ctx = Context { id, window: 77, actions, source_local: Cell::new(true), finished: Cell::new(None), status: Cell::new(None) };
      assert_eq!(gtk_motion(&controller, &View { modifiers: 0 }, &ctx, 0, 0, 0), owns);
      assert_eq!(ctx.status.get(), status);
      assert_eq!(ctx.finished.get(), None);
    }
  }

  #[test] fn gtk_unsupported_move_only_source_rejects_and_clears_receiver() {
    let controller = Controller { state: Cell::new(DragControllerState::Leaving),
      paths: UnsafeCell::new(Some(vec!["/external".into()])), delivered: Cell::new(false), enters: Cell::new(0), leaves: Cell::new(0), context: RefCell::new(Some(context(1))), source: Cell::new(source_snapshot()), inside: Cell::new(true), generation: Cell::new(0), entered_at: Cell::new(0), position: Cell::new((0,0)), snapshot_local: Cell::new(None), accepted: true };
    let ctx = Context { id: 1, window: 77, actions: 4, source_local: Cell::new(true), finished: Cell::new(None), status: Cell::new(None) };
    assert!(gtk_drop(&controller, &View { modifiers: 0 }, &ctx, 0, 0, 0));
    assert_eq!(ctx.finished.get(), Some(false));
    assert_eq!(controller.leaves.get(), 1);
    assert_eq!(controller.snapshot_local.get(), Some(true));
    assert!(!ctx.source_local.get());
    assert!(!controller.delivered.get());
  }
  #[test] fn gtk_non_uri_drop_reaches_dom_without_finishing() {
    assert_eq!(gtk_result(false), (false, false, None));
  }
  #[test] fn gtk_recent_uri_delivers_without_copy_action_admission() {
    assert_eq!(gtk_result(true), (true, true, Some(true)));
  }
  #[test] fn unmodified_callbacks_do_not_infer_copy_from_os_actions() {
    let webview = View { modifiers: 0 };
    assert!(!(${gtkCopy}));
    MAC_MODIFIERS.with(|value| value.set(0));
    assert!(!(${macCopy}));
    let keys = Flags(0);
    assert!(!(${windowsCopy}));
  }
  #[test] fn admitted_external_callbacks_keep_copy_acknowledgement() {
    assert_eq!([${macEffect("dragging_entered")}, ${macEffect("dragging_updated")}, ${macEffect("perform_drag_operation")}], [1, 1, 1]);
    let enter_is_valid = true;
    let mut effect = ${windowsEffect};
    let target = DragDropTarget { hwnd: 0, enter_is_valid: UnsafeCell::new(true), cursor_effect: UnsafeCell::new(effect) };
    assert_eq!(effect, 1);
    target.over(Flags(0), &POINTL { x: 0, y: 0 }, &mut effect).unwrap();
    assert_eq!(effect, 1);
    target.drop(&IDataObject, Flags(0), &POINTL { x: 0, y: 0 }, &mut effect).unwrap();
    assert_eq!(effect, 1);
  }
}
fn main() {
  for cached in [0, 4] {
    let webview = View { modifiers: cached };
    println!("linux:{cached} {}", ${gtkCopy});
  }
  for cached in [0, 524288] {
    MAC_MODIFIERS.with(|value| value.set(cached));
    println!("mac:{cached} {}", ${macCopy});
  }
  for state in [0, 8] {
    let keys = Flags(state);
    println!("windows:{state} {}", ${windowsCopy});
  }
  for enter_is_valid in [false, true] {
    let mut effect = ${windowsEffect};
    let target = DragDropTarget { hwnd: 0, enter_is_valid: UnsafeCell::new(enter_is_valid), cursor_effect: UnsafeCell::new(effect) };
    println!("effect:windows:enter:{enter_is_valid} {effect}");
    target.over(Flags(0), &POINTL { x: 0, y: 0 }, &mut effect).unwrap();
    println!("effect:windows:over:{enter_is_valid} {effect}");
    target.drop(&IDataObject, Flags(0), &POINTL { x: 0, y: 0 }, &mut effect).unwrap();
    println!("effect:windows:drop:{enter_is_valid} {effect}");
  }
  println!("effect:mac:enter:true {}", ${macEffect("dragging_entered")});
  println!("effect:mac:over:true {}", ${macEffect("dragging_updated")});
  println!("effect:mac:drop:true {}", ${macEffect("perform_drag_operation")});
  for uri in [false, true] { for accepted in [false, true] {
    let controller = Controller { state: Cell::new(if uri { DragControllerState::Leaving } else { DragControllerState::Left }),
      paths: UnsafeCell::new(uri.then(|| vec!["urn:tauri-explorer:drag:recent".into()])), delivered: Cell::new(false), enters: Cell::new(0), leaves: Cell::new(0), context: RefCell::new(Some(context(1))), source: Cell::new(source_snapshot()), inside: Cell::new(true), generation: Cell::new(0), entered_at: Cell::new(0), position: Cell::new((0,0)), snapshot_local: Cell::new(None), accepted };
    let ctx = Context { id: 1, window: 77, actions: 2, source_local: Cell::new(true), finished: Cell::new(None), status: Cell::new(None) };
    let consumed = gtk_drop(&controller, &View { modifiers: 0 }, &ctx, 0, 0, 0);
    println!("gtk:{uri}:{accepted} {}:{}:{}", controller.delivered.get(), !consumed, ctx.finished.get() == Some(true));
  } }
}
`);
  await execute("rustc", ["--edition=2021", "-Awarnings", source, "-o", binary]);
  await execute("rustc", ["--edition=2021", "-Awarnings", "--test", source, "-o", binary + "-tests"]);
  const nativeTests = await execute(binary + "-tests", { encoding: "utf8" });
  nativeCallbackTestResult = match(nativeTests.stdout, /(test result: [^\n]+)/);
  results = new Map((await execute(binary, { encoding: "utf8" })).stdout.trim().split("\n").map(line => {
    const [key, value] = line.split(" "); return [key, value];
  }));
} finally { rmSync(folder, { recursive: true, force: true }); }

export type PlatformDragEvent =
  | { platform: "linux"; cachedModifiers: number }
  | { platform: "mac"; cachedModifiers: number }
  | { platform: "windows"; keyState: number };
export function platformCopyModifier(event: PlatformDragEvent): boolean {
  return result(`${event.platform}:${event.platform === "windows" ? event.keyState : event.cachedModifiers}`) === "true";
}
function result(key: string): string {
  const value = results.get(key);
  if (value === undefined) throw new Error(`Unsupported native callback fixture: ${key}`);
  return value;
}
/** Session URI delivery retains DOM transport; filesystem ACK admits Copy only. */
export function gtkDropCallback(hasUriList: boolean, handlerAccepts = true) {
  const [delivered, domFallback, finished] = result(`gtk:${hasUriList}:${handlerAccepts}`).split(":").map(value => value === "true");
  return { delivered, domFallback, finished };
}
export function platformDropEffect(platform: "mac" | "windows", phase: "enter" | "over" | "drop"): number {
  return Number(result(`effect:${platform}:${phase}:true`));
}

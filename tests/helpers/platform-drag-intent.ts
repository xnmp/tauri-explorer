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
#[derive(Clone, Copy, PartialEq)] enum DragControllerState { Entered, Leaving, Left }
#[derive(Clone)] enum DragDropEvent { Over { position: (i32, i32) }, Drop { paths: Vec<String>, position: (i32, i32) }, Leave }
struct Controller { state: Cell<DragControllerState>, paths: RefCell<Option<Vec<String>>>, delivered: Cell<bool>, accepted: bool }
impl Controller {
  fn state(&self) -> DragControllerState { self.state.get() }
  fn take_paths(&self) -> Option<Vec<String>> { self.paths.borrow_mut().take() }
  fn leave(&self) { self.state.set(DragControllerState::Left); }
  fn call(&self, _: &View, event: DragDropEvent) -> bool { self.delivered.set(matches!(event, DragDropEvent::Drop { .. })); self.accepted }
}
struct View { modifiers: u32 }
impl View { fn display(&self) -> u32 { self.modifiers } }
mod gtk { pub mod gdk {
  pub struct Keymap(u32);
  impl Keymap { pub fn for_display(modifiers: &u32) -> Option<Self> { Some(Self(*modifiers)) } pub fn modifier_state(&self) -> u32 { self.0 } }
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
struct Context { finished: Cell<Option<bool>> }
impl Context { fn drop_finish(&self, success: bool, _: u32) { self.finished.set(Some(success)); } }
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
  fn iterate_filenames<F>(_: &IDataObject, mut callback: F) -> Option<u32> where F: FnMut(String) { callback("/external".into()); Some(1) }
  fn call(&self, _: DragDropEvent, _: Flags) -> bool { true }
  fn over(&self, grfKeyState: MODIFIERKEYS_FLAGS, pt: &POINTL, pdwEffect: *mut DROPEFFECT) -> windows::core::Result<()> { ${windowsOver} }
  fn drop(&self, pDataObj: windows::core::Ref<'_, IDataObject>, grfKeyState: MODIFIERKEYS_FLAGS, pt: &POINTL, _pdwEffect: *mut DROPEFFECT) -> windows::core::Result<()> {
    ${windowsDrop}
  }
}
#[cfg(test)] mod tests {
  use super::*;
  fn gtk_result(uri: bool) -> (bool, bool, Option<bool>) {
    let controller = Controller { state: Cell::new(if uri { DragControllerState::Leaving } else { DragControllerState::Left }),
      paths: RefCell::new(uri.then(|| vec!["urn:tauri-explorer:drag:recent".into()])), delivered: Cell::new(false), accepted: true };
    let ctx = Context { finished: Cell::new(None) };
    let consumed = gtk_drop(&controller, &View { modifiers: 0 }, &ctx, 0, 0, 0);
    (controller.delivered.get(), consumed, ctx.finished.get())
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
      paths: RefCell::new(uri.then(|| vec!["urn:tauri-explorer:drag:recent".into()])), delivered: Cell::new(false), accepted };
    let ctx = Context { finished: Cell::new(None) };
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
/** The GTK callback does not read the offered action set or protocol. */
export function gtkDropCallback(hasUriList: boolean, handlerAccepts = true) {
  const [delivered, domFallback, finished] = result(`gtk:${hasUriList}:${handlerAccepts}`).split(":").map(value => value === "true");
  return { delivered, domFallback, finished };
}
export function platformDropEffect(platform: "mac" | "windows", phase: "enter" | "over" | "drop"): number {
  return Number(result(`effect:${platform}:${phase}:true`));
}

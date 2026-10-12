/** Execute the exact dependency-free extractor compiled into vendored Wry.
 * Batch its tiny platform domain once; never hand the receiver an oracle bool. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const execute = promisify(execFile);
const folder = mkdtempSync(join(tmpdir(), "pdlg-intent-"));
let results: Map<string, boolean>;
try {
  const source = join(folder, "main.rs"), binary = join(folder, "intent");
  writeFileSync(source, `#[path = ${JSON.stringify(resolve("src-tauri/vendor/wry/src/drag_drop_intent.rs"))}] mod intent;
use intent::{copy_modifier, ole_operation, PlatformDragIntent};
fn main() {
  for selected in [0, 2, 4] { for suggested in [2, 4] { for cached in [0, 4] {
    println!("linux:{selected}:{suggested}:{cached} {}", copy_modifier(PlatformDragIntent::Gtk { selected_action: selected, suggested_action: suggested }));
  } } }
  for mask in [1, 16, 17] { for cached in [0, 524288] {
    println!("mac:{mask}:{cached} {}", copy_modifier(PlatformDragIntent::AppKit { source_operation_mask: mask }));
  } }
  for keys in [0, 8] { for allowed in [1, 2, 3] {
    println!("windows:{keys}:{allowed} {}", copy_modifier(PlatformDragIntent::Ole { effect: ole_operation(keys, allowed) }));
  } }
}`);
  await execute("rustc", ["--edition=2021", "-Awarnings", source, "-o", binary]);
  results = new Map((await execute(binary, { encoding: "utf8" })).stdout.trim().split("\n").map(line => {
    const [key, value] = line.split(" "); return [key, value === "true"];
  }));
} finally { rmSync(folder, { recursive: true, force: true }); }

export type PlatformDragEvent =
  | { platform: "linux"; selectedAction: number; suggestedAction: number; cachedModifiers: number }
  | { platform: "mac"; sourceOperationMask: number; cachedModifiers: number }
  | { platform: "windows"; keyState: number; allowedEffects: number };
export function platformCopyModifier(event: PlatformDragEvent): boolean {
  const key = event.platform === "linux" ? `linux:${event.selectedAction}:${event.suggestedAction}:${event.cachedModifiers}`
    : event.platform === "mac" ? `mac:${event.sourceOperationMask}:${event.cachedModifiers}`
    : `windows:${event.keyState}:${event.allowedEffects}`;
  const value = results.get(key);
  if (value === undefined) throw new Error(`Unsupported platform fixture: ${key}`);
  return value;
}

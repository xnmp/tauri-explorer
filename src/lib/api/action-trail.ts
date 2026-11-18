import { invoke } from "./common";

/**
 * Record one user action for the report trail (#1688). `kind` must be an
 * identifier (command ID, `view:details`, `nav:up`), never a path, name or
 * typed text; the native side rejects anything else. Fire and forget: the
 * trail never affects the action.
 */
export function recordAction(kind: string): void {
  void invoke<void>("record_action", { kind }).catch(() => undefined);
}

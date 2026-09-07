import { invoke } from "./common";

// One acknowledged native resource generation per JavaScript realm. A renderer
// reload creates a fresh module cache; commands already sent by the old realm
// retain its session ID and cannot acquire resources for the replacement page.
let session: Promise<string> | undefined;

export function getNativeResourceSession(): Promise<string> {
  if (session) return session;

  let acknowledgement: Promise<string>;
  acknowledgement = invoke<string>("native_resource_session").catch((error) => {
    // Only a failed acknowledgement permits retry. A stale rejection from any
    // later resource command must keep using this ID and fail closed.
    if (session === acknowledgement) session = undefined;
    throw error;
  });
  session = acknowledgement;
  return acknowledgement;
}

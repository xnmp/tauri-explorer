/**
 * Wire names (ADR 0031, #1592). A file name that is not valid UTF-8 crosses
 * IPC with each such byte as one reserved character U+EF00+byte
 * (U+EF80–U+EFFF), so `entry.name` and `entry.path` stay exact identities.
 * These pure helpers map that spelling to display text and typed text back.
 */

const ESCAPES = /[-]+/g;

/** Display text: each run of escapes becomes its bytes, decoded lossily
 *  (invalid bytes show as U+FFFD). Never use the result as an identity. */
export function displayName(wire: string): string {
  // Uint8Array stores each code unit modulo 256: U+EF00+byte becomes byte.
  return wire.replace(ESCAPES, (run) =>
    new TextDecoder().decode(Uint8Array.from(run, (c) => c.charCodeAt(0))),
  );
}

/** Wire spelling of typed text: a genuine U+EF80–U+EFFF character is sent as
 *  the escapes of its own UTF-8 bytes, as the backend encodes it. */
export function toWireText(typed: string): string {
  return typed.replace(ESCAPES, (run) =>
    Array.from(new TextEncoder().encode(run), (b) => String.fromCharCode(0xef00 + b)).join(""),
  );
}

/** The wire name to request for a rename of `current` to the trimmed,
 *  non-empty `typed` text, or "" when the user left its display text
 *  unchanged (a no-op). */
export function renameRequest(current: string, typed: string): string {
  return typed === displayName(current) ? "" : toWireText(typed);
}

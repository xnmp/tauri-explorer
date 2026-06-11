/**
 * Type declarations for @chenglou/pretext (canvas-backed text measurement).
 * The package ships no types; this shim declares the subset we use.
 */
declare module "@chenglou/pretext" {
  /** Opaque prepared-text handle produced by prepareWithSegments. */
  export type PreparedText = unknown;

  /** Prepare a string for measurement with the given CSS font shorthand. */
  export function prepareWithSegments(text: string, font: string): PreparedText;

  /** Measure the natural (unwrapped) pixel width of prepared text. */
  export function measureNaturalWidth(prepared: PreparedText): number;
}

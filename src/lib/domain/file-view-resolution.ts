/** Synchronous, reactive eligibility; async work belongs to the provider. */
export type FileViewEligibility = boolean | "pending";

/** Maximum neutral first-paint hold for one directory/view choice. */
export const FILE_VIEW_ELIGIBILITY_WAIT_MS = 400;

export type FileViewResolution =
  | { kind: "builtin" }
  | { kind: "hold" }
  | { kind: "plugin"; id: string };

/** Only the preferred provider can replace or delay the built-in listing.
 * Errors are normalized to false by the registry, outside this pure rule. */
export function resolveFileView(
  providers: readonly { id: string; eligibility: FileViewEligibility }[],
  preference: string | null | undefined,
  elapsedMs: number,
): FileViewResolution {
  if (!preference) return { kind: "builtin" };
  const answer = providers.find((provider) => provider.id === preference)?.eligibility;
  if (answer === true) return { kind: "plugin", id: preference };
  if (answer === "pending" && elapsedMs < FILE_VIEW_ELIGIBILITY_WAIT_MS) return { kind: "hold" };
  return { kind: "builtin" };
}

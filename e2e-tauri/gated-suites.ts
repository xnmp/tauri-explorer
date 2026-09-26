/**
 * Native suites that need an opt-in build feature or fixture directory.
 *
 * Locally, a suite whose prerequisites are missing is skipped. A job that
 * exists to run these suites sets `TAURI_E2E_REQUIRE_GATED=1`, where the same
 * absence fails instead: WDIO counts a skipped spec file as passed, so a
 * missing variable would otherwise report acceptance that never executed
 * (#774).
 */

export type GatedMode = "run" | "skip" | "fail";

/** The first missing prerequisite, or null when the suite can run. */
export function missingPrerequisite(
  requirements: readonly (readonly [satisfied: boolean, description: string])[],
): string | null {
  return requirements.find(([satisfied]) => !satisfied)?.[1] ?? null;
}

export function gatedMode(missing: string | null, requireGated: boolean): GatedMode {
  if (missing === null) return "run";
  return requireGated ? "fail" : "skip";
}

export function requireGatedFromEnvironment(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.TAURI_E2E_REQUIRE_GATED === "1";
}

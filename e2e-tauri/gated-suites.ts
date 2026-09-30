/**
 * Native suites that need an opt-in build feature or fixture directory.
 *
 * Locally, a suite whose prerequisites are missing is skipped. A job that
 * exists to run these suites sets `TAURI_E2E_REQUIRE_GATED=1`, where the same
 * absence fails instead: WDIO counts a skipped spec file as passed, so a
 * missing variable would otherwise report acceptance that never executed
 * (#774). For the same reason an unrecognised value is an error rather than
 * "off" (#873).
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

const REQUIRE_GATED_VALUES: Readonly<Record<string, boolean>> = {
  "": false,
  "0": false,
  false: false,
  "1": true,
  true: true,
};

export function requireGatedFromEnvironment(environment: NodeJS.ProcessEnv = process.env): boolean {
  const value = environment.TAURI_E2E_REQUIRE_GATED ?? "";
  const required = REQUIRE_GATED_VALUES[value];
  if (required === undefined) {
    throw new Error(
      `TAURI_E2E_REQUIRE_GATED must be one of 1, true, 0, false or empty; got ${JSON.stringify(value)}`,
    );
  }
  return required;
}

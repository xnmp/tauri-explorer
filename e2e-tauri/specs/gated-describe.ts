/**
 * Mocha adapter for gated native suites (#774). Kept out of `helpers.ts`,
 * which qualification tests import outside a Mocha type context.
 */
import { gatedMode, missingPrerequisite, requireGatedFromEnvironment } from "../gated-suites";

/**
 * `describe` for a gated suite. In `fail` mode the suite still registers one
 * test, so the missing prerequisite appears as a named failure.
 */
export function gatedDescribe(
  title: string,
  requirements: readonly (readonly [satisfied: boolean, description: string])[],
  body: () => void,
): void {
  const missing = missingPrerequisite(requirements);
  switch (gatedMode(missing, requireGatedFromEnvironment())) {
    case "run":
      describe(title, body);
      return;
    case "skip":
      describe.skip(title, body);
      return;
    case "fail":
      describe(title, () => {
        it("has its prerequisites", () => {
          throw new Error(`${title} cannot run: ${missing}`);
        });
      });
  }
}

/**
 * Thin barrel over `native-qualification/`, split by responsibility (#886):
 * - `types.ts` — shared type/interface declarations and the soak scenario list.
 * - `matrix.ts` — the pairwise qualification matrix and window-state helpers.
 * - `stats.ts` — percentile/duration summary helpers.
 * - `artifacts.ts` — qualification artifact path resolution and I/O.
 * - `soak.ts` — soak configuration and soak artifact path resolution.
 * - `report.ts` — native qualification report assembly and resource-growth checks.
 * - `process.ts` — process sampling, logged process execution, and process
 *   lifecycle (start/stop/fixture cleanup).
 * - `readiness.ts` — macOS startup log marker parsing (the single parser used
 *   by both the readiness predicate and the report, per #696) and the
 *   direct-process readiness wait.
 * - `attribution.ts` — macOS startup report/evidence assembly and half-bounce
 *   qualification.
 * - `startup-progress.ts` — diagnostic summary of streamed
 *   `Startup(webview-progress)` lines; never used to qualify readiness (#936).
 * - `stall-evidence.ts` — bounded macOS process/profile/log/crash-report capture
 *   for a timed-out startup sample (#936).
 *
 * Every existing import of `e2e-tauri/native-qualification` keeps working
 * unchanged; new code may import the sibling modules directly.
 */
export * from "./native-qualification/types";
export * from "./native-qualification/matrix";
export * from "./native-qualification/stats";
export * from "./native-qualification/artifacts";
export * from "./native-qualification/soak";
export * from "./native-qualification/report";
export * from "./native-qualification/process";
export * from "./native-qualification/readiness";
export * from "./native-qualification/attribution";
export * from "./native-qualification/startup-progress";
export * from "./native-qualification/stall-evidence";

import { expect, vi } from "vitest";

const testPath = expect.getState().testPath?.replaceAll("\\", "/");

if (testPath?.endsWith("/tests/native-suite-typecheck.test.ts")) {
  // This suite asserts compiler exit status, not compiler speed. Give only
  // that real command a bounded compilation budget; behavior tests retain
  // their default five-second deadline and perf thresholds stay unchanged.
  vi.setConfig({ testTimeout: 10_000 });
}

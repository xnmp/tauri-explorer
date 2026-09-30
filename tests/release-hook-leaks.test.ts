import { describe, expect, it } from "vitest";
import { findHookLeaks } from "../scripts/release-hook-leaks.mjs";

const cleanManifest = {
  "src/routes/+page.svelte": { file: "_app/nodes/2.js", src: "src/routes/+page.svelte", isEntry: true },
  "src/lib/api/mock-invoke.ts": { file: "_app/chunks/mock.js", src: "src/lib/api/mock-invoke.ts" },
};

describe("release hook-leak guard", () => {
  it("accepts a build with no test-support chunk and no hook markers", () => {
    expect(findHookLeaks(cleanManifest, [
      { file: "_app/nodes/2.js", text: "const e2eish = 1; el.dataset.theme = 'dark'; dispatch('explorer://adopt-tab');" },
    ])).toEqual([]);
  });

  it("reports an orphan chunk built from src/test-support", () => {
    const manifest = {
      ...cleanManifest,
      "src/test-support/e2e-hooks.ts": { file: "_app/chunks/probe.js", src: "src/test-support/e2e-hooks.ts" },
    };
    expect(findHookLeaks(manifest, [])).toEqual([
      "_app/chunks/probe.js is built from test-support module src/test-support/e2e-hooks.ts",
    ]);
  });

  it("uses the manifest key when a record carries no src", () => {
    expect(findHookLeaks({ "src/test-support/dom-rpc.ts": { file: "_app/chunks/rpc.js" } }, []))
      .toHaveLength(1);
  });

  it("reports an inline publisher or request event that escaped the gate", () => {
    expect(findHookLeaks(cleanManifest, [
      { file: "_app/chunks/a.js", text: "t.documentElement.dataset.e2eGitLeases=JSON.stringify(n)" },
      { file: "_app/chunks/b.js", text: 'addEventListener("e2e-navigate",h)' },
    ])).toEqual([
      "_app/chunks/a.js contains hook marker e2eGitLeases",
      "_app/chunks/b.js contains hook marker \"e2e-navigate\"",
    ]);
  });
});

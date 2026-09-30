import { describe, expect, it } from "vitest";
import { findHookLeaks, findTestSupportModules, releaseHookGuard } from "../scripts/release-hook-leaks.mjs";

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

  it.each([
    ["a data-e2e attribute", "el.setAttribute(\"data-e2e-window-label\",n)", "data-e2e-"],
    ["a template receipt key", "localStorage.setItem(`e2e-child-ready:${e}`,\"1\")", "`e2e-child-ready:"],
    ["a concatenated receipt key", "localStorage.getItem(\"e2e-transfer-receipt:\"+e)", "\"e2e-transfer-receipt:"],
    ["a one-letter dataset key", "t.documentElement.dataset.e2eX=\"1\"", "e2eX"],
    ["a hook-only window global", "const a=window.__E2E_WEBVIEW_BROWSER_ARGS__", "__E2E_"],
  ])("reports %s", (_case, text, marker) => {
    expect(findHookLeaks(cleanManifest, [{ file: "_app/chunks/c.js", text }]))
      .toEqual([`_app/chunks/c.js contains hook marker ${marker}`]);
  });

  it("does not mistake ordinary identifiers for hook markers", () => {
    expect(findHookLeaks(cleanManifest, [
      { file: "_app/chunks/d.js", text: "const e2e=1,e2eish=2,E2E=3;x.dataset.e2=4;\"e2e\";`${e2e}:`" },
    ])).toEqual([]);
  });
});

describe("release module-id guard", () => {
  const root = "/repo";

  it("reports a test-support module merged into an ordinary hashed chunk", () => {
    expect(findTestSupportModules([
      { fileName: "_app/immutable/chunks/Bx1.js", moduleIds: [`${root}/src/lib/state/window-session.ts`, `${root}/src/test-support/dom-rpc.ts`] },
    ])).toEqual([
      `_app/immutable/chunks/Bx1.js bundles test-support module ${root}/src/test-support/dom-rpc.ts`,
    ]);
  });

  it("recognises Windows, virtual, and queried module ids", () => {
    expect(findTestSupportModules([
      { fileName: "a.js", moduleIds: ["C:\\repo\\src\\test-support\\e2e-hooks.ts"] },
      { fileName: "b.js", moduleIds: [`\0${root}/src/test-support/dom-rpc.ts?commonjs-proxy`] },
    ])).toHaveLength(2);
  });

  it("accepts chunks built only from application modules", () => {
    expect(findTestSupportModules([
      { fileName: "a.js", moduleIds: [`${root}/src/lib/api/e2e-hooks.ts`, `${root}/src/lib/test-supportive.ts`, `${root}/node_modules/x/src/test-support-lib.js`] },
    ])).toEqual([]);
  });

  function runGuard(hooksEnabled: boolean, moduleIds: string[]) {
    const plugin = releaseHookGuard({ hooksEnabled });
    const errors: string[] = [];
    const context = { error: (message: string) => { errors.push(message); throw new Error(message); } };
    const bundle = {
      "chunk.js": { type: "chunk", fileName: "chunk.js", modules: Object.fromEntries(moduleIds.map((id) => [id, {}])) },
      "style.css": { type: "asset", fileName: "style.css" },
    };
    try {
      (plugin.generateBundle as unknown as (this: typeof context, o: unknown, b: unknown) => void).call(context, {}, bundle);
    } catch {
      // The context's error() throws, as Rollup's does.
    }
    return errors;
  }

  it("fails a build without hooks that bundles test-support code", () => {
    const errors = runGuard(false, [`${root}/src/test-support/dom-rpc.ts`]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("chunk.js bundles test-support module /repo/src/test-support/dom-rpc.ts");
  });

  it("lets a hook build bundle test-support code", () => {
    expect(runGuard(true, [`${root}/src/test-support/dom-rpc.ts`])).toEqual([]);
  });

  it("applies to builds only", () => {
    expect(releaseHookGuard({ hooksEnabled: false }).apply).toBe("build");
  });
});

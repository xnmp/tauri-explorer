import { describe, expect, it } from "vitest";
import { findSiteDemoLeaks } from "../scripts/site-demo-leaks.mjs";

const cleanManifest = {
  "src/routes/+page.svelte": { file: "_app/nodes/2.js", src: "src/routes/+page.svelte", isEntry: true },
  "src/lib/api/mock-invoke.ts": { file: "_app/chunks/mock.js", src: "src/lib/api/mock-invoke.ts" },
  "src/lib/domain/theme-from-palette.ts": { file: "_app/chunks/palette.js", src: "src/lib/domain/theme-from-palette.ts" },
};

describe("site-demo leak guard", () => {
  it("accepts an ordinary build", () => {
    expect(findSiteDemoLeaks(cleanManifest, [
      { file: "_app/nodes/2.js", text: "el.dataset.theme='dark'; const demo = 1; fetch('/demo/site');" },
    ])).toEqual([]);
  });

  it.each([
    "src/lib/state/site-demo-boot.ts",
    "src/lib/state/site-demo-bridge.svelte.ts",
    "src/lib/api/mock-world.ts",
    "src/lib/api/mock-world-media.ts",
    "src/lib/domain/demo-boot.ts",
    "src/lib/domain/demo-fixture.ts",
    "src/lib/domain/demo-shell.ts",
    "src/lib/domain/demo-protocol.ts",
  ])("reports a chunk built from %s", (source) => {
    expect(findSiteDemoLeaks({ ...cleanManifest, [source]: { file: "_app/chunks/x.js", src: source } }, []))
      .toEqual([`_app/chunks/x.js is built from site-demo module ${source}`]);
  });

  it("reports demo code inlined into an ordinary chunk by its markers", () => {
    expect(findSiteDemoLeaks(cleanManifest, [
      { file: "_app/chunks/a.js", text: "document.documentElement.dataset.siteDemo=\"\"" },
      { file: "_app/chunks/b.js", text: 'console.warn("[site-demo] no init")' },
    ])).toEqual([
      "_app/chunks/a.js contains site-demo marker siteDemo",
      "_app/chunks/b.js contains site-demo marker [site-demo]",
    ]);
  });
});

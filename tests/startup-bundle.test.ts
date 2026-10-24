import { describe, expect, it } from "vitest";
import {
  HASH_PLACEHOLDER,
  collectStartupFiles,
  normalizeHashedNames,
  normalizedClientName,
} from "../scripts/startup-bundle.mjs";

describe("startup bundle accounting", () => {
  it("counts shared static chunks once and excludes lazy features", () => {
    expect(collectStartupFiles({
      app: { file: "app.js", isEntry: true, imports: ["shared"], dynamicImports: ["mock"] },
      route: { file: "route.js", isEntry: true, imports: ["alias", "styles"] },
      shared: { file: "shared.js", imports: ["app"] },
      alias: { file: "shared.js" },
      styles: { file: "theme.css" },
      mock: { file: "mock.js", imports: ["extra"] },
      extra: { file: "extra.js" },
    }).sort()).toEqual(["app.js", "route.js", "shared.js"]);
  });

  it("still counts a lazy feature if another startup entry imports it eagerly", () => {
    expect(collectStartupFiles({
      app: { file: "app.js", isEntry: true, imports: ["mock"], dynamicImports: ["mock"] },
      mock: { file: "mock.js" },
    }).sort()).toEqual(["app.js", "mock.js"]);
  });

  it("fails closed on missing entries or broken static dependencies", () => {
    expect(() => collectStartupFiles({})).toThrow("No entry JS");
    expect(() => collectStartupFiles({ app: { file: "app.js", isEntry: true, imports: ["missing"] } }))
      .toThrow("Missing static import");
  });
});

describe("hash-normalized gzip input", () => {
  const H = HASH_PLACEHOLDER;

  it("names each content-hashed SvelteKit output by its placeholder", () => {
    expect(normalizedClientName("_app/immutable/chunks/CgxXZ5FE.js")).toBe(`${H}.js`);
    // Rollup appends a counter when two emitted names collide.
    expect(normalizedClientName("_app/immutable/chunks/BfIQrfYo2.js")).toBe(`${H}.js`);
    expect(normalizedClientName("_app/immutable/nodes/2.D0Sc9vxR.js")).toBe(`2.${H}.js`);
    expect(normalizedClientName("_app/immutable/entry/app.Da0MLIIw.js")).toBe(`app.${H}.js`);
    expect(normalizedClientName("_app/immutable/assets/ConflictDialog.--_E3PnL.css")).toBe(`ConflictDialog.${H}.css`);
    expect(normalizedClientName("_app/immutable/assets/catppuccin-sprite.CgD9Sf8U.svg")).toBe(`catppuccin-sprite.${H}.svg`);
  });

  it("leaves files without a content hash alone", () => {
    expect(normalizedClientName("index.html")).toBeNull();
    expect(normalizedClientName("favicon.png")).toBeNull();
    expect(normalizedClientName(".vite/manifest.json")).toBeNull();
    expect(normalizedClientName("fonts/Inter.Variable.woff2")).toBeNull();
    expect(normalizedClientName("_app/immutable/chunks/short.js")).toBeNull();
  });

  const build = (chunk: string, node: string, css: string) => ({
    files: [`_app/immutable/chunks/${chunk}.js`, `_app/immutable/nodes/2.${node}.js`, `_app/immutable/assets/Dialog.${css}.css`],
    text: `import{a as e}from"./${chunk}.js";const d=["../nodes/2.${node}.js","../assets/Dialog.${css}.css"];` +
      `import("../chunks/${chunk}.js");`,
  });

  it("gives identical output when only content hashes change", () => {
    const before = build("CgxXZ5FE", "D0Sc9vxR", "DSm7e4Un");
    const after = build("Zq9_x-3A2", "AAAAbbbb", "y_y-y_y1");
    expect(normalizeHashedNames(after.text, after.files)).toBe(normalizeHashedNames(before.text, before.files));
    expect(normalizeHashedNames(before.text, before.files)).not.toContain("CgxXZ5FE");
  });

  it("still distinguishes real code changes", () => {
    const before = build("CgxXZ5FE", "D0Sc9vxR", "DSm7e4Un");
    const changed = { ...before, text: before.text.replace("a as e", "b as e") };
    expect(normalizeHashedNames(changed.text, changed.files)).not.toBe(normalizeHashedNames(before.text, before.files));
  });

  it("rewrites only names of emitted files, never longer identifiers containing them", () => {
    const files = ["_app/immutable/chunks/CgxXZ5FE.js"];
    expect(normalizeHashedNames(`"./CgxXZ5FE.js" "./xCgxXZ5FE.js" "./CgxXZ5FE.jsx" "./NotEmitd.js"`, files))
      .toBe(`"./${H}.js" "./xCgxXZ5FE.js" "./CgxXZ5FE.jsx" "./NotEmitd.js"`);
  });

  it("returns text unchanged when nothing hashed was emitted", () => {
    expect(normalizeHashedNames("const a = 1;", ["index.html"])).toBe("const a = 1;");
  });
});

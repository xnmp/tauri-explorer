import { describe, expect, it } from "vitest";
import { collectStartupFiles } from "../scripts/startup-bundle.mjs";

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

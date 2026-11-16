import { describe, expect, it } from "vitest";
import { findLightDarkPolyfill } from "../scripts/css-polyfill-leaks.mjs";

describe("findLightDarkPolyfill", () => {
  it("flags a stylesheet carrying the Lightning CSS light-dark polyfill", () => {
    const css = ".a{color:var(--lightningcss-light,#fff) var(--lightningcss-dark,#000)}";
    expect(findLightDarkPolyfill([{ file: "a.css", text: css }])).toEqual(["a.css"]);
  });

  it("flags a lone dark-variable definition", () => {
    const css = ":root{--lightningcss-dark: initial;--lightningcss-light:}";
    expect(findLightDarkPolyfill([{ file: "b.css", text: css }])).toEqual(["b.css"]);
  });

  it("accepts native light-dark() and unrelated rules", () => {
    const css = ".a{color:light-dark(#fff,#000)}.b{--lightningcssish:1}";
    expect(findLightDarkPolyfill([{ file: "c.css", text: css }])).toEqual([]);
  });

  it("handles no stylesheets and empty text", () => {
    expect(findLightDarkPolyfill([])).toEqual([]);
    expect(findLightDarkPolyfill([{ file: "d.css", text: "" }])).toEqual([]);
  });

  it("reports only the offending files among many", () => {
    const big = "x".repeat(2_000_000);
    const out = findLightDarkPolyfill([
      { file: "ok.css", text: big },
      { file: "bad.css", text: `${big} --lightningcss-light: x; ${big}` },
    ]);
    expect(out).toEqual(["bad.css"]);
  });
});

import { describe, expect, it } from "vitest";
import { tabSlideCss } from "$lib/domain/tab-slide";

const declarations = (css: string) => Object.fromEntries(
  css.split(";").map(part => part.trim()).filter(Boolean).map(part => {
    const at = part.indexOf(":");
    return [part.slice(0, at).trim(), part.slice(at + 1).trim()];
  }),
);

describe("tabSlideCss", () => {
  it("grows the flex basis and width as a fraction of the live tab width", () => {
    const frame = declarations(tabSlideCss(0.25, "var(--tab-width)", 15));
    expect(frame["flex-basis"]).toBe("calc(var(--tab-width) * 0.25)");
    expect(frame.width).toBe("calc(var(--tab-width) * 0.25)");
    expect(frame["min-width"]).toBe("0");
    expect(frame["--tab-slide"]).toBe("0.25");
  });

  it("never clips with overflow, and widens its clip by the fillet flare", () => {
    const frame = declarations(tabSlideCss(0.5, "var(--tab-width)", 15));
    expect(frame.overflow).toBeUndefined();
    expect(frame["clip-path"]).toBe("inset(-4px -15px -4px -15px)");
  });

  it("starts from nothing and ends at the full width", () => {
    expect(declarations(tabSlideCss(0))["flex-basis"]).toBe("calc(var(--tab-width) * 0)");
    expect(declarations(tabSlideCss(1))["flex-basis"]).toBe("calc(var(--tab-width) * 1)");
  });

  it("clamps progress and treats malformed input safely", () => {
    expect(declarations(tabSlideCss(-2))["--tab-slide"]).toBe("0");
    expect(declarations(tabSlideCss(7))["--tab-slide"]).toBe("1");
    expect(declarations(tabSlideCss(Number.NaN))["--tab-slide"]).toBe("1");
    expect(declarations(tabSlideCss(0.5, "120px", Number.NaN))["clip-path"]).toBe("inset(-4px -0px -4px -0px)");
    expect(declarations(tabSlideCss(1 / 3))["--tab-slide"]).toBe("0.3333");
  });
});

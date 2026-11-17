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

  it("can leave sizing to the stylesheet, animating only the progress", () => {
    const frame = declarations(tabSlideCss(0.25, "var(--tab-width)", 15, false));
    expect(frame["--tab-slide"]).toBe("0.25");
    expect(frame.width).toBeUndefined();
    expect(frame["flex-basis"]).toBeUndefined();
  });

  it("fades a closing tab's surface and outline out with its content", () => {
    const at = (t: number) => declarations(tabSlideCss(t));
    expect(at(1)["--tab-content-alpha"]).toBe("1");
    expect(at(1).opacity).toBe("1");
    // Content, surface and outline are one fade, gone by 40% width: no
    // outline lingers around a tab whose content has already gone.
    for (const t of [1, 0.8, 0.6, 0.5, 0.45, 0.4, 0.3, 0.1, 0]) {
      expect(at(t).opacity, `t=${t}`).toBe(at(t)["--tab-content-alpha"]);
    }
    expect(at(0.4).opacity).toBe("0");
    expect(Number(at(0.5).opacity)).toBeGreaterThan(0);
    expect(Number(at(0.5).opacity)).toBeLessThan(1);
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

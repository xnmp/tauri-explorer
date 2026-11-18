import { describe, expect, it } from "vitest";
import { tabSlide } from "$lib/composables/tab-strip-dom";

/** The parts of a tab element `tabSlide` touches. */
function fakeTab({ active, selected }: { active: boolean; selected: string | null }) {
  const classes = new Set(["tab", ...(active ? ["active"] : [])]);
  const attributes = new Map<string, string>(selected === null ? [] : [["aria-selected", selected]]);
  return {
    classList: {
      contains: (name: string) => classes.has(name),
      remove: (name: string) => void classes.delete(name),
      toggle: (name: string, force: boolean) => (force ? classes.add(name) : classes.delete(name), force),
    },
    getAttribute: (name: string) => attributes.get(name) ?? null,
    setAttribute: (name: string, value: string) => void attributes.set(name, value),
    removeAttribute: (name: string) => void attributes.delete(name),
    get selected() { return { active: classes.has("active"), ariaSelected: attributes.get("aria-selected") ?? null }; },
  };
}

type Tab = ReturnType<typeof fakeTab>;
const asElement = (tab: Tab) => tab as unknown as Element;

/** Svelte's sequence: an outro's options are computed once per node and its
 *  deferred config called at the start of each outro; an intro's options are
 *  computed at each intro that follows an outro. */
function outro(tab: Tab) {
  const options = tabSlide(asElement(tab), { duration: 120, sized: true });
  expect(typeof options).toBe("function");
  return () => (options as () => { duration: number })();
}
const intro = (tab: Tab) => tabSlide(asElement(tab), { duration: 120, sized: false });

describe("tabSlide leaving state", () => {
  it("a closing active tab slides out unselected", () => {
    const tab = fakeTab({ active: true, selected: "true" });
    const start = outro(tab);
    // Nothing changes until the outro starts.
    expect(tab.selected).toEqual({ active: true, ariaSelected: "true" });
    expect(start().duration).toBe(120);
    expect(tab.selected).toEqual({ active: false, ariaSelected: "false" });
  });

  it("a tab that returns mid-slide gets back the state Svelte last rendered", () => {
    const tab = fakeTab({ active: true, selected: "true" });
    outro(tab)();
    intro(tab);
    expect(tab.selected).toEqual({ active: true, ariaSelected: "true" });
  });

  it("an inactive tab that returns stays inactive", () => {
    const tab = fakeTab({ active: false, selected: "false" });
    outro(tab)();
    intro(tab);
    expect(tab.selected).toEqual({ active: false, ariaSelected: "false" });
  });

  it("restores a missing aria-selected as missing", () => {
    const tab = fakeTab({ active: false, selected: null });
    outro(tab)();
    expect(tab.selected.ariaSelected).toBe("false");
    intro(tab);
    expect(tab.selected.ariaSelected).toBeNull();
  });

  it("a second outro with reused options leaves unselected again, and a second return restores again", () => {
    const tab = fakeTab({ active: true, selected: "true" });
    const start = outro(tab);
    start();
    intro(tab);
    start();
    expect(tab.selected).toEqual({ active: false, ariaSelected: "false" });
    intro(tab);
    expect(tab.selected).toEqual({ active: true, ariaSelected: "true" });
  });

  it("a repeated outro start keeps the first rendered state", () => {
    const tab = fakeTab({ active: true, selected: "true" });
    const start = outro(tab);
    start();
    start();
    intro(tab);
    expect(tab.selected).toEqual({ active: true, ariaSelected: "true" });
  });

  it("an intro with no outro before it changes nothing", () => {
    const tab = fakeTab({ active: false, selected: "false" });
    intro(tab);
    expect(tab.selected).toEqual({ active: false, ariaSelected: "false" });
  });
});

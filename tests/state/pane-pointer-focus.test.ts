import { expect, it, vi } from "vitest";
import { createPanePointerFocus } from "$lib/state/pane-pointer-focus";

it("returns pointer-induced focus to its owner without cancelling drag acquisition", () => {
  const focus = createPanePointerFocus();
  const restore = vi.fn();
  focus.begin(restore);
  expect(focus.restore()).toBe(true);
  expect(restore).toHaveBeenCalledOnce();
  focus.end();
  expect(focus.restore()).toBe(false);
  expect(restore).toHaveBeenCalledOnce();
});

it("a new ordinary gesture replaces an additive gesture and accepts normal focus", () => {
  const focus = createPanePointerFocus();
  const restore = vi.fn();
  focus.begin(restore);
  focus.begin(null);
  expect(focus.restore()).toBe(false);
  expect(restore).not.toHaveBeenCalled();
});

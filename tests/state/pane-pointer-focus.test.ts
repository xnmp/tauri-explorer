import { expect, it, vi } from "vitest";
import { createPanePointerFocus, focusFirstAccepting, type Focusable } from "$lib/state/pane-pointer-focus";

it("returns pointer-induced focus to its owner on release, once", () => {
  const focus = createPanePointerFocus();
  const restore = vi.fn();
  focus.begin(restore);
  expect(focus.active).toBe(true);
  expect(restore).not.toHaveBeenCalled();
  expect(focus.release()).toBe(true);
  expect(restore).toHaveBeenCalledOnce();
  expect(focus.active).toBe(false);
  expect(focus.release()).toBe(false);
  expect(restore).toHaveBeenCalledOnce();
});

it("ending a gesture discards its restore", () => {
  const focus = createPanePointerFocus();
  const restore = vi.fn();
  focus.begin(restore);
  focus.end();
  expect(focus.release()).toBe(false);
  expect(restore).not.toHaveBeenCalled();
});

it("a new ordinary gesture replaces an additive gesture and accepts normal focus", () => {
  const focus = createPanePointerFocus();
  const restore = vi.fn();
  focus.begin(restore);
  focus.begin(null);
  expect(focus.active).toBe(false);
  expect(focus.release()).toBe(false);
  expect(restore).not.toHaveBeenCalled();
});

/** A focus owner that either accepts focus or silently ignores it, like a DOM node. */
function owner(accepts: boolean, world: { focused: unknown }): Focusable {
  const self: Focusable = { focus: () => { if (accepts) world.focused = self; } };
  return self;
}

it("falls through candidates that cannot take focus, e.g. a detached or unfocusable owner", () => {
  const world = { focused: "body" as unknown };
  const dead = owner(false, world), pane = owner(true, world), never = owner(true, world);
  expect(focusFirstAccepting([null, dead, pane, never], () => world.focused)).toBe(true);
  expect(world.focused).toBe(pane);
});

it("reports failure when nothing accepts focus", () => {
  const world = { focused: "body" as unknown };
  expect(focusFirstAccepting([owner(false, world), undefined], () => world.focused)).toBe(false);
  expect(focusFirstAccepting([], () => world.focused)).toBe(false);
});

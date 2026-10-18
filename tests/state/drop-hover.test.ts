import { expect, it, vi } from "vitest";
import { createDropHover } from "$lib/state/drop-hover";

it("refreshes only the live drag and rejects an obsolete owner's cleanup", () => {
  const hover = createDropHover();
  const first = vi.fn(), second = vi.fn();
  hover.refresh();
  hover.set(first); hover.refresh();
  hover.set(second); hover.clear(first); hover.refresh();
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenCalledTimes(1);
  hover.clear(second); hover.refresh();
  expect(second).toHaveBeenCalledTimes(1);
});

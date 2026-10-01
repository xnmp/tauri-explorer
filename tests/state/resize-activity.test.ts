import { expect, it } from "vitest";
import { createResizeActivity } from "$lib/state/resize-activity.svelte";

it("keeps automatic reveal paused until all owning gestures retire, with idempotent cleanup", () => {
  const activity = createResizeActivity();
  expect(activity.active).toBe(false);
  const first = activity.begin(), second = activity.begin();
  first(); first(); expect(activity.active).toBe(true);
  second(); expect(activity.active).toBe(false);
  const replacement = activity.begin(); second(); expect(activity.active).toBe(true);
  replacement(); expect(activity.active).toBe(false);
});

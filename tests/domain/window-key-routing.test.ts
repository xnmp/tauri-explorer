import { expect, it } from "vitest";
import { chordPrefixFallbackLabel } from "$lib/domain/window-keys";
it.each([
  ["Ctrl+J M", "Jobs Panel"], ["Cmd+J M", "Jobs Panel"],
  ["Ctrl+, M", "Settings"], ["Ctrl+F M", "Filter Current Directory"],
  ["Ctrl+` M", "Toggle Terminal"], ["Ctrl+Shift+~ M", "Toggle Terminal"], ["Ctrl+\\ M", "Toggle Dual Pane"],
  ["Alt+M Ctrl+J", undefined], ["Alt+M M", undefined], ["invalid", undefined],
])("reports only a displaced standalone prefix for %s", (shortcut, label) => {
  expect(chordPrefixFallbackLabel(shortcut)).toBe(label);
});

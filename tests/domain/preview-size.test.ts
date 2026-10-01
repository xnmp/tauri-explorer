import { expect, it } from "vitest";
import { previewResizeSpec } from "$lib/domain/preview-size";
import { clampResizeSize, draggedResizeSize } from "$lib/domain/resize-size";

it("right docking uses the independent width preference and grows leftward", () => {
  const { setting, options } = previewResizeSpec("right");
  expect(setting).toBe("previewPaneWidth"); expect(options.axis).toBe("x");
  expect(clampResizeSize(0, options)).toBe(280);
  expect(draggedResizeSize(280, -60, 1.5, options)).toBe(320);
});
it("vertical docks share height but grow in opposing directions", () => {
  for (const [dock, delta] of [["top", 60], ["bottom", -60]] as const) {
    const { setting, options } = previewResizeSpec(dock);
    expect(setting).toBe("previewPaneHeight"); expect(options.axis).toBe("y");
    expect(clampResizeSize(0, options)).toBe(240);
    expect(draggedResizeSize(240, delta, 1.5, options)).toBe(280);
  }
});

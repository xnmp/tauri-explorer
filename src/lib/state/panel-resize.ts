import { clampResizeSize, type ResizeSizeOptions } from "$lib/domain/resize-size";
import { createScalarResize, type ResizeEffects } from "$lib/state/scalar-resize";

/** A missing manual preference follows the live automatic source until an
 * effective adjustment. Returning to the automatic origin still pins a preference. */
export function createPanelResize(initial: unknown, options: ResizeSizeOptions, deps: Omit<ResizeEffects, "retire"> & {
  retire?(): void;
  persist(value: number): void;
  automaticWidth?(): number;
}) {
  let preferred = typeof initial === "number" && Number.isFinite(initial)
    ? clampResizeSize(initial, options) : deps.automaticWidth ? undefined : clampResizeSize(initial, options);
  return createScalarResize({ ...deps, retire: deps.retire ?? (() => {}), options: () => options,
    sourceChanges: "capture",
    read: () => preferred ?? clampResizeSize(deps.automaticWidth?.(), options),
    commit(value) {
      if (value === preferred) return;
      preferred = value;
      deps.persist(value);
    },
  });
}

/**
 * Plugin items in the Details column-header menu (#1884), shown after the
 * column toggles in plugin order. `api.ts` registers them (owning ids, failure
 * reporting and disposal); `DetailsView.svelte` renders them.
 */
import { createOrderedRegistry } from "$lib/state/ordered-registry";

export interface DetailColumnMenuItem {
  /** `<pluginId>.<name>`. */
  id: string;
  label: string;
  /** Runs after the host closes the menu. */
  run(): void;
  /** Read when the menu opens; a disabled item is shown but cannot run. */
  enabled?(): boolean;
}

export const DETAIL_COLUMN_MENU_LABEL_MAX = 80;

export function createDetailColumnMenuRegistry() {
  const registrations = createOrderedRegistry<DetailColumnMenuItem>();
  let items = $state.raw<readonly DetailColumnMenuItem[]>([]);
  return {
    register(item: DetailColumnMenuItem, order?: number): () => void {
      const dispose = registrations.register(item.id, item, order);
      items = registrations.values();
      return () => { if (dispose()) items = registrations.values(); };
    },
    /** Reactive, in plugin order then registration order. */
    get items(): readonly DetailColumnMenuItem[] { return items; },
  };
}

export const detailColumnMenuItems = createDetailColumnMenuRegistry();

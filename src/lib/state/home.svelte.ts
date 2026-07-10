/**
 * App-wide home directory state.
 *
 * The home directory is fetched from the backend exactly once and cached in
 * reactive state. Components read it synchronously via `homeDirectory.value`,
 * so surfaces mounted after the first fetch (new tabs, new panes) render
 * their final form on first paint instead of flashing the raw path while a
 * per-component fetch is in flight (#233).
 */
import { getHomeDirectory } from "$lib/api/files";

let homeDir = $state<string | null>(null);
let requested = false;

export const homeDirectory = {
  /** Cached home path, or null until the one-time fetch resolves. */
  get value(): string | null {
    if (!requested) {
      requested = true;
      getHomeDirectory().then((result) => {
        if (result.ok) homeDir = result.data;
      });
    }
    return homeDir;
  },
};

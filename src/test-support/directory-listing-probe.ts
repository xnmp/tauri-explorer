/**
 * Native E2E control of real backend directory listings.
 *
 * WebKitWebDriver evaluates injected scripts in an isolated JavaScript world,
 * so replacing `window.__TAURI_INTERNALS__.invoke` there cannot instrument the
 * application's Tauri calls. A spec dispatches `e2e-directory-listing-probe`
 * with `{ targetPath, delays?, writeOperation? }` to time the listings of one
 * path (an empty detail disarms it), and reads call/finish counts back from
 * `data-e2e-directory-listing-probe`.
 */
import { interceptDirectoryListings, writeTextFile } from "$lib/api/files";
import { holdListingForWatcherWrites } from "./watcher-listing-probe";

interface ArmedProbe {
  targetPath: string;
  delays: number[];
  calls: number;
  completed: number;
  starts: number[];
  finishes: number[];
  writeOperation?: string;
  abort: AbortController;
}

interface ProbeRequest {
  targetPath?: string;
  delays?: number[];
  writeOperation?: string;
}

export function startDirectoryListingProbe(signal: AbortSignal): void {
  if (signal.aborted) return;
  const root = document.documentElement;
  let armed: ArmedProbe | null = null;

  const publish = () => {
    if (signal.aborted) return;
    if (armed) {
      root.dataset.e2eDirectoryListingProbe = JSON.stringify({
        calls: armed.calls, completed: armed.completed, starts: armed.starts, finishes: armed.finishes,
      });
    } else {
      delete root.dataset.e2eDirectoryListingProbe;
    }
  };

  const release = interceptDirectoryListings({
    begin(path) {
      const probe = armed?.targetPath === path ? armed : null;
      if (!probe) return null;
      const callIndex = probe.calls;
      probe.calls += 1;
      probe.starts.push(Date.now());
      publish();
      return async () => {
        if (callIndex === 0 && probe.writeOperation) {
          await holdListingForWatcherWrites({
            path,
            operation: probe.writeOperation,
            signal: probe.abort.signal,
            write: async (filePath, content) => {
              const result = await writeTextFile(filePath, content);
              if (!result.ok) throw new Error(result.error);
            },
          });
        }
        const delay = probe.delays[callIndex] ?? 0;
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
        probe.completed += 1;
        probe.finishes.push(Date.now());
        publish();
      };
    },
  });

  window.addEventListener("e2e-directory-listing-probe", ((event: CustomEvent<ProbeRequest | null>) => {
    armed?.abort.abort();
    delete root.dataset.e2eWatcherWriteOperation;
    const detail = event.detail ?? {};
    armed = detail.targetPath
      ? {
          targetPath: detail.targetPath,
          delays: detail.delays ?? [],
          calls: 0,
          completed: 0,
          starts: [],
          finishes: [],
          writeOperation: detail.writeOperation,
          abort: new AbortController(),
        }
      : null;
    publish();
  }) as EventListener, { signal });

  signal.addEventListener("abort", () => {
    armed?.abort.abort();
    armed = null;
    release();
    delete root.dataset.e2eDirectoryListingProbe;
    delete root.dataset.e2eWatcherWriteOperation;
  }, { once: true });
}

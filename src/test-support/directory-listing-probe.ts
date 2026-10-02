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
import { windowTabsManager } from "$lib/state/window-tabs.svelte";

const started = new WeakSet<AbortSignal>();

interface LaunchGate {
  token: string;
  targetPath: string;
  status: "armed" | "started" | "held" | "released" | "cancelled";
  events: Array<{ status: LaunchGate["status"]; at: number }>;
  release?: () => void;
}

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
  if (signal.aborted || started.has(signal)) return;
  started.add(signal);
  const root = document.documentElement;
  let armed: ArmedProbe | null = null;
  const label = windowTabsManager.windowLabel;
  const gateKey = `e2e-launch-listing-gate:${label}`;
  const releaseKey = `e2e-launch-listing-release:${label}`;
  const receiptKey = `e2e-launch-listing-receipt:${label}`;
  let launchGate: LaunchGate | null = null;

  const recordGate = (gate: LaunchGate, status: LaunchGate["status"]) => {
    gate.status = status;
    gate.events.push({ status, at: Date.now() });
    if (signal.aborted && status !== "cancelled") return;
    const receipt = JSON.stringify({ label, token: gate.token, targetPath: gate.targetPath, status, events: gate.events });
    if (!signal.aborted) root.dataset.e2eLaunchListingGate = receipt;
    // A parent can observe an exact parked label without scripting its webview.
    // Teardown publishes cancellation so a persisted held receipt cannot outlive
    // its owner; retired sessions never publish live DOM state.
    localStorage.setItem(receiptKey, receipt);
  };
  const releaseGate = (cancelled = false) => {
    const gate = launchGate;
    if (!gate || gate.status === "released" || gate.status === "cancelled") return;
    recordGate(gate, cancelled ? "cancelled" : "released");
    gate.release?.();
    gate.release = undefined;
  };
  const armLaunchGate = () => {
    const raw = localStorage.getItem(gateKey);
    if (!raw) return;
    localStorage.removeItem(gateKey);
    try {
      if (raw.length > 32_768) return;
      const request: unknown = JSON.parse(raw);
      if (!request || typeof request !== "object") return;
      const { token, targetPath } = request as Record<string, unknown>;
      if (typeof token !== "string" || !token || typeof targetPath !== "string" || !targetPath) return;
      releaseGate(true);
      launchGate = { token, targetPath, status: "armed", events: [] };
      recordGate(launchGate, "armed");
      if (localStorage.getItem(releaseKey) === token) releaseGate();
    } catch {
      // Malformed test control must not prevent the real application starting.
    }
  };
  armLaunchGate();
  window.addEventListener("storage", ((event: StorageEvent) => {
    if (event.key === gateKey) armLaunchGate();
    else if (event.key === releaseKey && event.newValue === launchGate?.token) releaseGate();
  }) as EventListener, { signal });
  window.addEventListener("e2e-launch-listing-release", ((event: CustomEvent<{ token?: string }>) => {
    if (event.detail?.token === launchGate?.token) releaseGate();
  }) as EventListener, { signal });
  window.addEventListener("pagehide", () => releaseGate(true), { signal });

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
      const gate = launchGate?.status === "armed" && launchGate.targetPath === path ? launchGate : null;
      if (gate) {
        recordGate(gate, "started");
        return async () => {
          // The API invokes this continuation only after a real native reply
          // decoded successfully, before publishing that listing to Explorer.
          if (gate.status !== "started" || signal.aborted) return;
          await new Promise<void>((resolve) => {
            gate.release = resolve;
            recordGate(gate, "held");
          });
        };
      }
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
    started.delete(signal);
    releaseGate(true);
    launchGate = null;
    delete root.dataset.e2eLaunchListingGate;
    armed?.abort.abort();
    armed = null;
    release();
    delete root.dataset.e2eDirectoryListingProbe;
    delete root.dataset.e2eWatcherWriteOperation;
  }, { once: true });
}

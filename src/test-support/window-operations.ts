/**
 * `e2e-window-operation` handlers: native multiwindow acceptance dispatches
 * DOM requests across WebDriver's isolated JS world, and each handler invokes
 * the same launch/adoption owners as the real gestures. One handler per op.
 */
import { windowTabsManager } from "../lib/state/window-tabs.svelte";
import { spawnWarmWindow } from "../lib/state/warm-window";
import type { TabSnapshot } from "../lib/state/window-tabs.svelte";

export type WindowOperation =
  | "open-pair" | "tear-off" | "transfer" | "native-close" | "warm-prime" | "warm-open" | "warm-claim" | "warm-ready"
  | "watch-acquire" | "directory-watch-acquire" | "directory-watch-release" | "native-session"
  | "native-destroy" | "target-state" | "target-readiness" | "window-states" | "open-picker"
  | "open-unready" | "arm-transfer-close" | "fresh-open" | "collision-transfer";

export interface WindowOperationRequest {
  token: string;
  op: WindowOperation;
  target?: string;
  /** Omit one actual seed entry to make late backend validation observable. */
  seedOmit?: string;
}

type Handler = (request: WindowOperationRequest) => Promise<unknown>;

export const childReadyKey = (label: string) => `e2e-child-ready:${label}`;
/** Set by a parked warm page once it registered, so tests never script it (#931). */
export const WARM_READY_PREFIX = "e2e-warm-ready:";

async function createFixtureWindow(label: string, url: string, title: string): Promise<void> {
  const [{ WebviewWindow }, { explorerWindowAppearance }] = await Promise.all([
    import("@tauri-apps/api/webviewWindow"),
    import("$lib/state/window-appearance"),
  ]);
  const child = new WebviewWindow(label, { url, width: 900, height: 560, ...explorerWindowAppearance(title) });
  await new Promise<void>((resolve, reject) => {
    void child.once("tauri://created", () => resolve()).catch(reject);
    void child.once("tauri://error", ({ payload }) => reject(new Error(String(payload)))).catch(reject);
  });
}

export function windowOperationHandlers(signal: AbortSignal): Record<WindowOperation, Handler> {
  // Lazy dispatch belongs to this session. Once a domain operation accepts
  // work, its own navigation/transfer/launch lifetime handles completion.
  const whileActive = async <T>(pending: Promise<T>): Promise<T> => {
    const value = await pending;
    signal.throwIfAborted();
    return value;
  };
  const appUrl = (params: URLSearchParams) => `${window.location.origin}${window.location.pathname}?${params}`;

  /** Run `move` on the active tab's transfer, cancelling it unless completed. */
  const withActiveTransfer = async (move: (snapshot: TabSnapshot, complete: () => boolean) => Promise<unknown>) => {
    const id = windowTabsManager.activeTabId;
    const transfer = id ? windowTabsManager.beginTabTransfer(id) : null;
    if (!transfer) throw new Error("No transferable tab");
    try {
      return await move(transfer.snapshot, () => transfer.complete());
    } finally { transfer.cancel(); }
  };

  const tearOff = async () => {
    const { openNewWindow } = await whileActive(import("$lib/state/window-launch"));
    return withActiveTransfer(async (snapshot, complete) => {
      const child = await openNewWindow(snapshot.path, undefined, snapshot);
      return { moved: !!child && complete(), target: child?.label };
    });
  };

  return {
    "native-session": async () => {
      // Reuse the realm's production acknowledgement and summary channel.
      const { getNativeResourceSession } = await whileActive(import("$lib/api/native-resource-session"));
      return getNativeResourceSession();
    },

    "open-picker": async ({ target }) => {
      const pickerToken = crypto.randomUUID();
      const label = `picker-${pickerToken}`;
      // Exercise the actual picker page and native event routing. This fixture
      // does not emulate a desktop portal request or register a portal token.
      const params = new URLSearchParams({ picker: "open", token: pickerToken, folder: target ?? "/" });
      await whileActive(createFixtureWindow(label, appUrl(params), "Select a file"));
      return { label, token: pickerToken };
    },

    "open-unready": async ({ target }) => {
      const label = `explorer-unready-${crypto.randomUUID()}`;
      // A real native webview with no application document gives the handoff
      // transport a deterministic destination with no receiver to adopt it.
      await whileActive(createFixtureWindow(label, "about:blank", "Unready Explorer fixture"));
      return { label, appUrl: appUrl(new URLSearchParams({ path: target ?? "/", focusAddressBar: "1" })) };
    },

    "target-state": async ({ target }) => {
      const { Window } = await whileActive(import("@tauri-apps/api/window"));
      const destination = target ? await Window.getByLabel(target) : null;
      return { exists: destination !== null, visible: destination ? await destination.isVisible() : false };
    },

    "target-readiness": async ({ target }) => {
      const { Window } = await whileActive(import("@tauri-apps/api/window"));
      const destination = target ? await Window.getByLabel(target) : null;
      return {
        exists: destination !== null,
        visible: destination ? await destination.isVisible() : false,
        readyPath: target ? localStorage.getItem(childReadyKey(target)) : null,
      };
    },

    "window-states": async () => {
      const { Window } = await whileActive(import("@tauri-apps/api/window"));
      return Promise.all((await Window.getAll()).map(async (win) => ({
        label: win.label,
        visible: await win.isVisible(),
      })));
    },

    "directory-watch-acquire": async ({ target }) => {
      // Intentionally leave the lease unmanaged by JS so reload acceptance
      // can distinguish native reclamation from ordinary frontend teardown.
      const { watchDirectory } = await whileActive(import("$lib/api/files"));
      return watchDirectory(target ?? "");
    },

    "directory-watch-release": async ({ target }) => {
      // Release one unmanaged lease by the ID its acquisition returned, so
      // identity acceptance can retire one spelling while others hold on.
      const { unwatchDirectory } = await whileActive(import("$lib/api/files"));
      await unwatchDirectory({ id: target ?? "", path: "" });
      return true;
    },

    "watch-acquire": async ({ target }) => {
      const { invoke } = await whileActive(import("@tauri-apps/api/core"));
      // Intentionally no frontend lease owner or cleanup: this fixture checks
      // native reclamation when a renderer disappears with accepted work.
      const { gitWatchRepo } = await whileActive(import("$lib/api/git"));
      const result = await gitWatchRepo(target ?? "");
      if (!result.ok) throw new Error(result.error);
      return { lease: result.data, logDir: await invoke<string>("get_log_dir") };
    },

    "native-destroy": async () => {
      const { getCurrentWindow } = await whileActive(import("@tauri-apps/api/window"));
      await getCurrentWindow().destroy();
      return true;
    },

    "warm-claim": async () => {
      const { warmPoolClaim } = await whileActive(import("$lib/api/warm-pool"));
      return warmPoolClaim();
    },

    "warm-ready": async () => {
      // Labels of registered warm windows that still exist and are hidden.
      const { Window } = await whileActive(import("@tauri-apps/api/window"));
      const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index) ?? "")
        .filter(key => key.startsWith(WARM_READY_PREFIX));
      const parked = await Promise.all(keys.map(async (key) => {
        const window = await Window.getByLabel(key.slice(WARM_READY_PREFIX.length));
        if (!window) localStorage.removeItem(key);
        return window && !await window.isVisible() ? window.label : null;
      }));
      return parked.filter(label => label !== null);
    },

    "warm-prime": async () => {
      await spawnWarmWindow();
      return true;
    },

    "warm-open": async ({ target }) => {
      const { openNewWindow } = await whileActive(import("$lib/state/window-launch"));
      const opened = await openNewWindow(target ?? windowTabsManager.getActiveExplorer()!.currentPath);
      return opened ? { kind: opened.kind, label: opened.label } : null;
    },

    "arm-transfer-close": async ({ token, target }) => {
      const [{ listen }, { TAB_ADOPT_EVENT, normalizeWindowHandoff }, { isRecord }] =
        await whileActive(Promise.all([
          import("@tauri-apps/api/event"),
          import("$lib/state/window-handoff"),
          import("$lib/domain/window-input"),
        ]));
      const receiptKey = `e2e-transfer-receipt:${target ?? token}`;
      let stop: (() => void) | undefined;
      let received = false;
      const release = () => {
        signal.removeEventListener("abort", onAbort);
        const acquired = stop;
        stop = undefined;
        if (acquired) void Promise.resolve(acquired()).catch(() => {});
      };
      const onAbort = () => release();
      stop = await listen<unknown>(TAB_ADOPT_EVENT, ({ payload }) => {
        if (signal.aborted || received) return;
        const handoff = isRecord(payload) ? normalizeWindowHandoff(payload.handoff) : null;
        if (!handoff) return;
        received = true;
        release();
        const receipt = {
          token: target ?? token,
          requestId: handoff.requestId,
          sourceWindow: handoff.sourceWindow,
          targetWindow: windowTabsManager.windowLabel,
          receivedAt: Date.now(),
        };
        localStorage.setItem(receiptKey, JSON.stringify(receipt));
        // Tauri invokes all listeners for one emit synchronously. Production's
        // async receiver yields at its first import, so this real close request
        // revokes transfer admission before that receiver can pass isVisible.
        const closing = windowTabsManager.requestWindowClose();
        localStorage.setItem(receiptKey, JSON.stringify({ ...receipt, closeRequestedAt: Date.now() }));
        void closing;
      }, { target: windowTabsManager.windowLabel });
      if (signal.aborted || received) {
        release();
        signal.throwIfAborted();
      } else signal.addEventListener("abort", onAbort, { once: true });
      return { receiptKey };
    },

    "fresh-open": async ({ token, target, seedOmit }) => {
      const { createWindowLauncher } = await whileActive(import("$lib/state/window-launch"));
      const { normalizeDirectorySeed, directorySeedFitsBudget } = await whileActive(import("$lib/domain/window-input"));
      const opened = await createWindowLauncher({
        warmEnabled: () => false, uuid: () => token,
        ...(seedOmit ? { captureDirectorySeed(path: string) {
          const explorer = windowTabsManager.getActiveExplorer();
          if (!explorer || explorer.currentPath !== path) return null;
          const now = Date.now();
          // Keep an actual directory snapshot but omit one real fixture entry.
          // The unchanged native listing restores it after the held reply;
          // that observable publication is stronger than a settling delay.
          const seed = normalizeDirectorySeed({ currentPath: path,
            entries: explorer.displayEntries.filter(entry => entry.name !== seedOmit),
            sortBy: explorer.sortBy, sortAscending: explorer.sortAscending,
            viewMode: explorer.viewMode, ts: now }, path, now);
          return seed && directorySeedFitsBudget(seed) ? seed : null;
        } } : {}),
      })(
        target ?? windowTabsManager.getActiveExplorer()!.currentPath,
      );
      return opened ? { kind: opened.kind, label: opened.label } : null;
    },

    "native-close": async ({ target }) => {
      const { getCurrentWindow, Window } = await whileActive(import("@tauri-apps/api/window"));
      const closing = target ? await Window.getByLabel(target) : getCurrentWindow();
      if (!closing) throw new Error(`native close target not found: ${target}`);
      await closing.close();
      if (target) localStorage.removeItem(childReadyKey(target));
      return true;
    },

    "open-pair": async () => {
      const { openNewWindow } = await whileActive(import("$lib/state/window-launch"));
      const path = windowTabsManager.getActiveExplorer()?.currentPath;
      if (!path) throw new Error("No active directory");
      const children = await Promise.all([openNewWindow(path), openNewWindow(path)]);
      return children.map((child) => child?.label ?? null);
    },

    "tear-off": tearOff,

    transfer: async ({ target }) => {
      if (!target) return tearOff();
      return withActiveTransfer(async (snapshot, complete) => {
        const { sendTabToWindow } = await whileActive(import("$lib/state/tab-transfer"));
        return { moved: await sendTabToWindow(target, snapshot) && complete(), target };
      });
    },

    "collision-transfer": async ({ target }) => {
      if (!target) return tearOff();
      return withActiveTransfer(async (snapshot, complete) => {
        if (!target.startsWith("explorer-") || target.length === "explorer-".length) {
          throw new Error("Collision target is not an Explorer window label");
        }
        const failures: Array<{ label: string; phase: string; error?: string }> = [];
        const { createWindowLauncher } = await whileActive(import("$lib/state/window-launch"));
        const opened = await createWindowLauncher({
          warmEnabled: () => false,
          uuid: () => target.slice("explorer-".length),
          reportFailure: ({ label, phase, error }) => failures.push({
            label,
            phase,
            ...(error === undefined ? {} : { error: String(error) }),
          }),
        })(snapshot.path, undefined, snapshot);
        return { moved: !!opened && complete(), target, failures };
      });
    },
  };
}

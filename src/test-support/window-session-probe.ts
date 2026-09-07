/** Opt-in native E2E commands; handlers and readiness belong to one page session. */
import { windowTabsManager } from "../lib/state/window-tabs.svelte";
import { spawnWarmWindow } from "../lib/state/warm-window";
import type { FileEntry } from "../lib/domain/file";
import type { ExplorerInstance } from "../lib/state/explorer.svelte";

export function startWindowSessionProbe(signal: AbortSignal, warmReady?: Promise<boolean>): void {
  if (signal.aborted) return;
  // Lazy dispatch belongs to this session. Once a domain operation accepts
  // work, its own navigation/transfer/launch lifetime handles completion.
  const whileActive = async <T>(pending: Promise<T>): Promise<T> => {
    const value = await pending;
    signal.throwIfAborted();
    return value;
  };
  const listen = (name: string, handler: EventListener) => window.addEventListener(name, handler, { signal });
  let capturedDelete: { token: string; explorer: ExplorerInstance; entries: FileEntry[] } | null = null;
  signal.addEventListener("abort", () => {
    capturedDelete = null;
    for (const key of ["e2eHooksReady", "e2eWarmReady", "e2eWindowLabel", "e2eNavigationComplete", "e2eWindowResult", "e2eFileOperationResult"]) {
      delete document.documentElement.dataset[key];
    }
  }, { once: true });
  listen("e2e-navigate", ((
    e: CustomEvent<string | { path: string; token?: string }>,
  ) => {
    const path = typeof e.detail === "string" ? e.detail : e.detail.path;
    const token = typeof e.detail === "string" ? undefined : e.detail.token;
    const navigation = windowTabsManager.getActiveExplorer()?.navigateTo(path);
    if (navigation && token) {
      void navigation.then(() => {
        if (!signal.aborted) document.documentElement.dataset.e2eNavigationComplete = token;
      });
    }
  }) as EventListener);

  // Restore the active pane to its file listing by closing any open commit
  // graph. The per-pane `gitGraph` state persists to localStorage, which is
  // shared across every tauri-driver session (same http://localhost origin),
  // so a spec that leaves the graph open (git-graph-pull) would otherwise
  // relaunch every later spec into graph mode — no `.file-list` ever renders
  // (#447). Specs call this via navigateTo before waiting for the listing.
  listen("e2e-reset-view", (() => {
    for (const paneId of windowTabsManager.activePaneIds) {
      windowTabsManager.setPaneGitGraph(paneId, null);
    }
  }) as EventListener);

  listen("e2e-file-op", ((
    e: CustomEvent<{ op: string; name?: string; path?: string; paths?: string[]; token?: string }>,
  ) => {
    const explorer = windowTabsManager.getActiveExplorer();
    if (!explorer) return;
    const { op, name, path, paths, token } = e.detail;
    const entry = path
      ? explorer.displayEntries.find((en) => en.path === path)
      : undefined;
    let pending: Promise<string | null> | undefined;
    if (op === "capture-delete" && token && paths) {
      const targets = new Set(paths);
      const entries = explorer.displayEntries.filter((entry) => targets.has(entry.path));
      const error = entries.length === targets.size ? null : "Some requested entries are not listed";
      capturedDelete = error ? null : { token, explorer, entries };
      document.documentElement.dataset.e2eFileOperationResult = JSON.stringify({
        token, status: "captured", completedAt: Date.now(), error,
      });
      return;
    } else if (op === "confirm-captured-delete" && capturedDelete && capturedDelete.token === token) {
      const captured = capturedDelete;
      capturedDelete = null;
      pending = captured.explorer.confirmDelete(captured.entries, false);
    } else if (op === "undo" || op === "redo") {
      pending = explorer[op]();
    } else if (op === "cut" && entry) {
      pending = explorer.cutToClipboard([entry]).then(() => null);
    } else if (op === "paste") {
      pending = explorer.paste();
    } else if (op === "new-folder" && name) {
      pending = explorer.createFolder(name);
    } else if (op === "rename" && entry && name) {
      explorer.startRename(entry);
      pending = explorer.rename(name);
    } else if (op === "delete" && entry) {
      pending = explorer.confirmDelete([entry]);
    }
    if (pending && token) {
      const completed = (error: string | null) => {
        if (!signal.aborted) document.documentElement.dataset.e2eFileOperationResult = JSON.stringify({
          token, status: "completed", completedAt: Date.now(), error,
        });
      };
      void pending.then(completed, (error) => completed(String(error)));
    }
  }) as EventListener);

  // Native multiwindow acceptance uses DOM requests across WebDriver's
  // isolated JS world, invoking the same launch/adoption owners as dragging.
  listen("e2e-window-operation", ((e: CustomEvent<{
    token: string; op: "open-pair" | "tear-off" | "transfer" | "native-close" | "warm-prime" | "warm-open" | "warm-claim" | "watch-acquire" | "directory-watch-acquire" | "native-session" | "native-destroy" | "target-state" | "open-picker" | "open-unready" | "arm-transfer-close" | "fresh-open" | "collision-transfer"; target?: string;
  }>) => {
    const { token, op, target } = e.detail;
    void (async () => {
      if (op === "native-session") {
        // Reuse the realm's production acknowledgement and summary channel.
        const { getNativeResourceSession } = await whileActive(import("$lib/api/native-resource-session"));
        return getNativeResourceSession();
      }
      if (op === "open-picker") {
        const [{ WebviewWindow }, { explorerWindowAppearance }] = await whileActive(Promise.all([
          import("@tauri-apps/api/webviewWindow"),
          import("$lib/state/window-appearance"),
        ]));
        const pickerToken = crypto.randomUUID();
        const label = `picker-${pickerToken}`;
        // Exercise the actual picker page and native event routing. This fixture
        // does not emulate a desktop portal request or register a portal token.
        const params = new URLSearchParams({ picker: "open", token: pickerToken, folder: target ?? "/" });
        const child = new WebviewWindow(label, {
          url: `${window.location.origin}${window.location.pathname}?${params}`,
          width: 900, height: 560,
          ...explorerWindowAppearance("Select a file"),
        });
        await new Promise<void>((resolve, reject) => {
          void child.once("tauri://created", () => resolve()).catch(reject);
          void child.once("tauri://error", ({ payload }) => reject(new Error(String(payload)))).catch(reject);
        });
        return { label, token: pickerToken };
      }
      if (op === "open-unready") {
        const [{ WebviewWindow }, { explorerWindowAppearance }] = await whileActive(Promise.all([
          import("@tauri-apps/api/webviewWindow"),
          import("$lib/state/window-appearance"),
        ]));
        const label = `explorer-unready-${crypto.randomUUID()}`;
        const requestedPath = target ?? "/";
        // A real native webview with no application document gives the handoff
        // transport a deterministic destination with no receiver to adopt it.
        const child = new WebviewWindow(label, {
          url: "about:blank",
          width: 900, height: 560,
          ...explorerWindowAppearance("Unready Explorer fixture"),
        });
        await new Promise<void>((resolve, reject) => {
          void child.once("tauri://created", () => resolve()).catch(reject);
          void child.once("tauri://error", ({ payload }) => reject(new Error(String(payload)))).catch(reject);
        });
        const params = new URLSearchParams({ path: requestedPath, focusAddressBar: "1" });
        return {
          label,
          appUrl: `${window.location.origin}${window.location.pathname}?${params}`,
        };
      }
      if (op === "target-state") {
        const { Window } = await whileActive(import("@tauri-apps/api/window"));
        const destination = target ? await Window.getByLabel(target) : null;
        return { exists: destination !== null, visible: destination ? await destination.isVisible() : false };
      }
      if (op === "directory-watch-acquire") {
        // Intentionally leave the lease unmanaged by JS so reload acceptance
        // can distinguish native reclamation from ordinary frontend teardown.
        const { watchDirectory } = await whileActive(import("$lib/api/files"));
        return watchDirectory(target ?? "");
      }
      if (op === "watch-acquire") {
        const { invoke } = await whileActive(import("@tauri-apps/api/core"));
        // Intentionally no frontend lease owner or cleanup: this fixture checks
        // native reclamation when a renderer disappears with accepted work.
        const { gitWatchRepo } = await whileActive(import("$lib/api/git"));
        const result = await gitWatchRepo(target ?? "");
        if (!result.ok) throw new Error(result.error);
        return { lease: result.data, logDir: await invoke<string>("get_log_dir") };
      }
      if (op === "native-destroy") {
        const { getCurrentWindow } = await whileActive(import("@tauri-apps/api/window"));
        await getCurrentWindow().destroy();
        return true;
      }
      if (op === "warm-claim") {
        const { warmPoolClaim } = await whileActive(import("$lib/api/warm-pool"));
        return warmPoolClaim();
      }
      if (op === "warm-prime") { await spawnWarmWindow(); return true; }
      if (op === "warm-open") {
        const { openNewWindow } = await whileActive(import("$lib/state/window-launch"));
        const opened = await openNewWindow(target ?? windowTabsManager.getActiveExplorer()!.currentPath);
        return opened ? { kind: opened.kind, label: opened.label } : null;
      }
      if (op === "arm-transfer-close") {
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
          localStorage.setItem(receiptKey, JSON.stringify({
            ...receipt,
            closeRequestedAt: Date.now(),
          }));
          void closing;
        }, { target: windowTabsManager.windowLabel });
        if (signal.aborted || received) {
          release();
          signal.throwIfAborted();
        } else signal.addEventListener("abort", onAbort, { once: true });
        return { receiptKey };
      }
      if (op === "fresh-open") {
        const { createWindowLauncher } = await whileActive(import("$lib/state/window-launch"));
        const opened = await createWindowLauncher({ warmEnabled: () => false })(
          target ?? windowTabsManager.getActiveExplorer()!.currentPath,
        );
        return opened ? { kind: opened.kind, label: opened.label } : null;
      }
      if (op === "native-close") {
        const { getCurrentWindow } = await whileActive(import("@tauri-apps/api/window"));
        await getCurrentWindow().close();
        return true;
      }
      const { openNewWindow } = await whileActive(import("$lib/state/window-launch"));
      if (op === "open-pair") {
        const path = windowTabsManager.getActiveExplorer()?.currentPath;
        if (!path) throw new Error("No active directory");
        const children = await Promise.all([openNewWindow(path), openNewWindow(path)]);
        return children.map((child) => child?.label ?? null);
      }
      const id = windowTabsManager.activeTabId;
      const transfer = id ? windowTabsManager.beginTabTransfer(id) : null;
      if (!transfer) throw new Error("No transferable tab");
      try {
        const snapshot = transfer.snapshot;
        if (op === "collision-transfer" && target) {
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
          return { moved: !!opened && transfer.complete(), target, failures };
        }
        if (op === "transfer" && target) {
          const { sendTabToWindow } = await whileActive(import("$lib/state/tab-transfer"));
          return { moved: await sendTabToWindow(target, snapshot) && transfer.complete(), target };
        }
        const child = await openNewWindow(snapshot.path, undefined, snapshot);
        return { moved: !!child && transfer.complete(), target: child?.label };
      } finally { transfer.cancel(); }
    })().then((result) => {
      if (!signal.aborted) document.documentElement.dataset.e2eWindowResult = JSON.stringify({ token, result });
    }).catch((error: unknown) => {
      if (!signal.aborted) document.documentElement.dataset.e2eWindowResult = JSON.stringify({ token, error: String(error) });
    });
  }) as EventListener);
  document.documentElement.dataset.e2eWindowLabel = windowTabsManager.windowLabel;
  void warmReady?.then((ready) => {
    if (ready && !signal.aborted) document.documentElement.dataset.e2eWarmReady = "1";
  });

  // WebKitWebDriver can execute injected scripts before these listeners
  // exist. Publish readiness through the DOM (visible across WebKit's
  // isolated JS worlds) so the driver can dispatch each navigation once
  // and wait for its matching completion token. Repeated polling dispatches
  // queue duplicate real listings and contaminate watcher timing probes.
  document.documentElement.dataset.e2eHooksReady = "true";
}

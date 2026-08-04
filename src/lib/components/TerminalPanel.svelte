<!--
  TerminalPanel — embedded terminal at the bottom of the window (issue #139).

  xterm.js frontend over a Rust PTY (portable-pty) running the user's real
  shell ($SHELL / COMSPEC), spawned at the active explorer's directory.
  Follows the app theme by resolving CSS variables into xterm's theme object
  on every theme switch (xterm can't consume CSS vars natively).

  Lifecycle: one shell per window. The panel stays mounted once opened —
  hiding it (Ctrl+`) only hides the DOM, the shell keeps running. The PTY is
  killed backend-side when the window is destroyed. If the shell exits, an
  overlay offers a restart.

  cwd: the shell STARTS in the explorer's directory; navigation does not
  auto-cd (intrusive). The header's folder button explicitly cd's to the
  current folder.
-->
<script lang="ts">
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import "@xterm/xterm/css/xterm.css";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { onMount } from "svelte";
  import { terminalSpawn, terminalReserveId, terminalWrite, terminalResize, terminalKill, terminalStatus } from "$lib/api/terminal";
  import { buildTerminalTheme } from "$lib/domain/terminal-theme";
  import { buildCdSyncSequence, buildPathsInsertion } from "$lib/domain/terminal-command";
  import { defaultShellProfile, fromShellCwd, type ShellProfile } from "$lib/domain/terminal-shell";
  import { decideCdSync, createInjectedCdTracker } from "$lib/domain/terminal-cwd-sync";
  import { isWindows, isMac } from "$lib/domain/platform";
  import { getAlwaysActiveTerminalCommandId, isShellReservedKey, resolveTerminalShortcut, effectiveTerminalShortcuts } from "$lib/domain/terminal-keys";
  import { keybindingsStore } from "$lib/state/keybindings.svelte";
  import { getCommand } from "$lib/state/commands.svelte";
  import { settingsStore } from "$lib/state/settings.svelte";
  import { themeStore } from "$lib/state/theme.svelte";
  import { terminalPanelStore } from "$lib/state/terminal.svelte";
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";
  import { toastStore } from "$lib/state/toast.svelte";

  let panelEl: HTMLDivElement | undefined = $state();
  let termEl: HTMLDivElement | undefined = $state();
  let term: Terminal | undefined;
  let fitAddon: FitAddon | undefined;
  let terminalId: number | null = null;
  // Dialect of the shell the backend actually spawned (#409): a WSL pane gets
  // a POSIX shell even on Windows, and every PTY write/read translates
  // through this profile. Assumed platform default until spawn reports back.
  let shellProfile: ShellProfile = defaultShellProfile(isWindows);
  let spawning = false;
  let exited = $state(false);
  let unlistenOutput: UnlistenFn | undefined;
  let unlistenExit: UnlistenFn | undefined;
  let unlistenCwd: UnlistenFn | undefined;

  // ── cwd sync (issue #149) ──────────────────────────────────────────────────
  // The shell's last-known cwd (from OSC 7). Tracked always so the loop guard
  // works even when explorer-follows-terminal is off. Not $state: only read
  // inside async callbacks, never in the template.
  let lastShellCwd: string | null = null;
  // A cd deferred because the shell was busy; latest target wins.
  let pendingCd: string | null = null;
  let queuePoll: ReturnType<typeof setInterval> | null = null;
  // Re-entrancy guard: terminalStatus is async and can outlive the 500ms tick.
  // Without this, a slow IPC round-trip lets two callbacks overlap, and the
  // second can observe `pendingCd` already nulled by the first — ending in a
  // `writeCd(null)` that types `cd 'null'` into the shell (#154).
  let pollInFlight = false;
  // Whether the "will follow when it finishes" toast is already showing for
  // the current queue episode (so we don't spam it on every navigation).
  let queueToastShown = false;

  const visible = $derived(terminalPanelStore.visible);

  /** Resolve a CSS variable to a computed color, inside the theme cascade. */
  function resolveThemeColor(varName: string): string {
    if (!panelEl) return "";
    const probe = document.createElement("span");
    probe.style.color = `var(${varName})`;
    probe.style.display = "none";
    panelEl.appendChild(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    // An unset variable computes to the inherited color; treat the probe's
    // default sentinel as "unset" by checking the raw variable exists.
    const raw = getComputedStyle(panelEl).getPropertyValue(varName).trim();
    return raw ? color : "";
  }

  async function spawnShell(): Promise<void> {
    if (!term || spawning || terminalId !== null) return;
    spawning = true;
    exited = false;
    try {
      const cwd = windowTabsManager.getActiveExplorer()?.currentPath;
      // Listeners BEFORE spawn: the shell's first output (the prompt) is
      // emitted the instant the PTY starts, and events without a listener
      // are dropped — the terminal would open blank (#201).
      const id = await terminalReserveId();

      unlistenOutput = await listen<string>(`terminal-output-${id}`, (event) => {
        term?.write(event.payload);
      });
      unlistenExit = await listen<number | null>(`terminal-exit-${id}`, () => {
        terminalId = null;
        exited = true;
        stopQueuePoll();
      });
      // Explorer follows terminal: the shell reports its cwd via OSC 7.
      unlistenCwd = await listen<string>(`terminal-cwd-${id}`, (event) => {
        // The shell reports its own dialect's path (a WSL shell reports
        // /home/…); translate to an explorer path before it touches
        // navigation or the loop guards (#418).
        const path = fromShellCwd(event.payload, shellProfile);
        // Always track it — this is the loop guard for the other direction.
        lastShellCwd = path;
        // A cd WE injected echoing back must never drive navigation: during
        // fast tab switches the echo lands while a different tab is active
        // and would overwrite that tab's cwd (#266). Only genuine user cds
        // (typed in the shell) pull the explorer along.
        if (injectedCds.consume(path)) return;
        if (!settingsStore.explorerFollowsTerminal) return;
        const explorer = windowTabsManager.getActiveExplorer();
        if (explorer && explorer.currentPath !== path) {
          explorer.navigateTo(path);
        }
      });

      const info = await terminalSpawn(id, cwd, term.cols, term.rows);
      shellProfile = { kind: info.shellKind, wslDistro: info.wslDistro };
      terminalId = id;
      // Path insertions requested while the shell was still spawning (#265).
      for (const data of pendingInsertions.splice(0)) {
        terminalWrite(id, data);
      }
    } catch (err) {
      term.writeln(`\r\nFailed to start shell: ${err}`);
      exited = true;
    } finally {
      spawning = false;
    }
  }

  async function restartShell(): Promise<void> {
    unlistenOutput?.();
    unlistenExit?.();
    unlistenCwd?.();
    stopQueuePoll();
    pendingCd = null;
    lastShellCwd = null;
    term?.clear();
    await spawnShell();
    term?.focus();
  }

  /**
   * Inject a `cd` to `path`, clearing any half-typed prompt input first —
   * the automatic sync must win regardless of what's on the prompt. The
   * clear byte is shell-family-specific (see buildCdSyncSequence).
   */
  // Insertions typed before the PTY finished spawning; flushed by spawnShell.
  const pendingInsertions: string[] = [];

  /** Type paths into the prompt (space-delimited, shell-quoted, no Enter)
   *  and focus the terminal — drop-onto-terminal and Alt+T (#265). */
  function insertPaths(paths: string[]): void {
    const data = buildPathsInsertion(paths, shellProfile);
    if (terminalId !== null) terminalWrite(terminalId, data);
    else pendingInsertions.push(data);
    term?.focus();
  }

  // Targets of cds we injected whose OSC 7 echo hasn't arrived yet
  // (#266, #364): a counted, path-normalized tracker — see its doc for the
  // fast-tab-switch race a plain Set reintroduced.
  const injectedCds = createInjectedCdTracker();

  function writeCd(path: string): void {
    // Defensive: never inject `cd 'null'` if a caller ever passes a nullish
    // target (see the queue-poll re-entrancy guard, #154).
    if (terminalId === null || path == null) return;
    injectedCds.add(path);
    terminalWrite(terminalId, buildCdSyncSequence(path, shellProfile));
  }

  /** Terminal follows explorer: reconcile the shell's cwd with `path`. */
  async function syncTerminalToPath(path: string): Promise<void> {
    if (terminalId === null) return;
    const status = await terminalStatus(terminalId);
    const statusCwd = status.cwd !== null ? fromShellCwd(status.cwd, shellProfile) : null;
    lastShellCwd = statusCwd ?? lastShellCwd;
    // Fast tab switches: the status round-trip may outlive this sync's tab —
    // a stale cd would drag the shell (and, via its echo, the NEW tab) to
    // the previous tab's directory (#266). Latest target wins; drop the rest.
    if (windowTabsManager.getActiveExplorer()?.currentPath !== path) return;
    switch (decideCdSync(path, statusCwd, status.busy)) {
      case "skip":
        return;
      case "write":
        writeCd(path);
        return;
      case "queue":
        queueCd(path);
        return;
    }
  }

  /** Defer a cd until the running command finishes (latest target wins). */
  function queueCd(path: string): void {
    pendingCd = path;
    if (!queueToastShown) {
      toastStore.show("Terminal is running a command — will follow when it finishes", "info");
      queueToastShown = true;
    }
    startQueuePoll();
  }

  function startQueuePoll(): void {
    if (queuePoll !== null) return;
    queuePoll = setInterval(async () => {
      // Skip this tick if the previous callback's IPC hasn't resolved yet.
      if (pollInFlight) return;
      pollInFlight = true;
      try {
        if (terminalId === null || pendingCd === null) {
          stopQueuePoll();
          return;
        }
        const status = await terminalStatus(terminalId);
        const statusCwd = status.cwd !== null ? fromShellCwd(status.cwd, shellProfile) : null;
        lastShellCwd = statusCwd ?? lastShellCwd;
        if (status.busy) return;
        const target = pendingCd;
        pendingCd = null;
        stopQueuePoll();
        queueToastShown = false;
        // Re-check against the shell's cwd (it may have cd'd itself) AND the
        // active tab (it may have switched while the command ran, #266).
        if (
          target !== null &&
          windowTabsManager.getActiveExplorer()?.currentPath === target &&
          decideCdSync(target, statusCwd, false) === "write"
        ) {
          writeCd(target);
        }
      } catch (err) {
        // terminalStatus rejected — e.g. the terminal died before its exit
        // event landed. Stop polling instead of spinning on the rejection
        // (an unhandled promise every 500ms otherwise).
        console.error("[terminal] cd queue poll failed; stopping poll:", err);
        stopQueuePoll();
      } finally {
        pollInFlight = false;
      }
    }, 500);
  }

  function stopQueuePoll(): void {
    if (queuePoll !== null) {
      clearInterval(queuePoll);
      queuePoll = null;
    }
    queueToastShown = false;
  }

  // App zoom compensation (#419): the app zooms via CSS `zoom` on the root,
  // but xterm's selection hit-testing breaks under ancestor zoom (pointer
  // coords and canvas cell metrics disagree, worst on WebKit). The panel
  // counter-zooms itself back to net 1.0 and scales the FONT instead — same
  // visual size, true-pixel coordinates.
  const BASE_FONT_SIZE = 13;
  const zoomFactor = $derived(settingsStore.zoomLevel / 100);

  onMount(() => {
    term = new Terminal({
      cursorBlink: true,
      fontSize: Math.round(BASE_FONT_SIZE * (settingsStore.zoomLevel / 100)),
      fontFamily: "'JetBrainsMono Nerd Font', 'Cascadia Code', 'SF Mono', Menlo, Consolas, monospace",
      theme: buildTerminalTheme(resolveThemeColor),
      scrollback: 5000,
    });
    fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    // The focused terminal keeps every key except the explicit core-navigation
    // allowlist. Returning false makes xterm ignore one of those keys so the
    // window handler in +page.svelte can run its matching Explorer command.
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      // The platform's primary clipboard modifier: Ctrl, but ⌘ on mac (#403)
      // — Cmd+C/V while the terminal is focused must copy/paste terminal
      // text, never fall through to the explorer's file clipboard.
      const primaryOnly = isMac
        ? event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
        : event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;
      // Ctrl/Cmd+C with a selection copies it (VS Code parity, #374): the
      // user is copying terminal text, not interrupting the shell — and
      // definitely not copying files in the explorer.
      if (primaryOnly && event.key.toLowerCase() === "c" && term?.hasSelection()) {
        const text = term.getSelection();
        term.clearSelection();
        void navigator.clipboard.writeText(text).catch(() => {
          toastStore.error("Could not copy selection");
        });
        event.preventDefault();
        return false;
      }
      // Ctrl/Cmd+V pastes explicitly through xterm (bracketed-paste aware):
      // native paste into xterm's hidden textarea is unreliable in some
      // WebViews (#374), and the explorer's file-paste must never fire here.
      if (primaryOnly && event.key.toLowerCase() === "v") {
        void navigator.clipboard
          .readText()
          .then((text) => {
            if (text) term?.paste(text);
          })
          .catch(() => {
            /* clipboard unavailable — the native paste path may still work */
          });
        event.preventDefault();
        return false;
      }
      // Line-editing shortcuts (#375, #404): inject the mapped readline
      // control byte. Platform defaults (mac Home/End/word-nav) overlaid
      // with the user's bindings from Settings → Terminal.
      const sequence = resolveTerminalShortcut(
        event,
        effectiveTerminalShortcuts(settingsStore.terminalShortcuts, isMac),
      );
      if (sequence !== null) {
        if (terminalId !== null) terminalWrite(terminalId, sequence);
        event.preventDefault();
        return false;
      }
      // Availability-aware: an unavailable core command does not claim the
      // key, so the terminal application still receives it.
      const coreCommandId = getAlwaysActiveTerminalCommandId(event);
      const coreCommandAvailable =
        coreCommandId !== undefined && keybindingsStore.matchesAnyBinding(event, (id) => {
          if (id !== coreCommandId) return false;
          const cmd = getCommand(id);
          return !cmd?.when || cmd.when();
        });
      return isShellReservedKey(event, { coreCommandAvailable });
    });

    term.open(termEl!);
    fitAddon.fit();

    term.onData((data) => {
      if (terminalId !== null) terminalWrite(terminalId, data);
    });
    term.onResize(({ cols, rows }) => {
      if (terminalId !== null) terminalResize(terminalId, cols, rows);
    });

    // Refit when the panel box changes (drag-resize, window resize),
    // coalesced to animation frames.
    let rafId: number | null = null;
    const resizeObserver = new ResizeObserver(() => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        if (terminalPanelStore.visible) fitAddon?.fit();
      });
    });
    resizeObserver.observe(termEl!);

    spawnShell().then(() => term?.focus());

    const unregisterSink = terminalPanelStore.registerPathsSink(insertPaths);

    return () => {
      unregisterSink();
      resizeObserver.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
      unlistenOutput?.();
      unlistenExit?.();
      unlistenCwd?.();
      stopQueuePoll();
      if (terminalId !== null) terminalKill(terminalId);
      term?.dispose();
    };
  });

  // Re-theme xterm when the painted app theme changes. CSS vars cascade on
  // their own, but xterm's colors are plain values that must be pushed
  // imperatively. Keyed on appliedThemeId (not the persisted setting) so the
  // terminal also follows theme-picker live previews and never drifts from
  // the rest of the UI (#251).
  $effect(() => {
    themeStore.appliedThemeId; // dependency: painted theme id
    if (!term || !panelEl) return;
    const built = buildTerminalTheme(resolveThemeColor);
    term.options.theme = built;
    // WebKitGTK (2.46+, Wayland) fails to repaint the terminal's large
    // background regions when their colors change via CSS-var recompute or
    // xterm's generated stylesheet — the region freezes on the old theme
    // while text keeps updating (#261, same family as wry#1524). INLINE
    // style writes DO invalidate the paint, so push the resolved background
    // onto every background-owning element, and force a full text repaint.
    panelEl.style.backgroundColor = built.background;
    for (const sel of [".xterm-viewport", ".xterm-scrollable-element", ".xterm-screen"]) {
      const el = panelEl.querySelector<HTMLElement>(sel);
      if (el) el.style.backgroundColor = built.background;
    }
    term.refresh(0, term.rows - 1);
  });

  // Terminal follows explorer: when the active pane navigates, cd the shell.
  // Runs even while the panel is hidden (the shell is alive), but only after
  // the panel has been opened at least once (terminalId is live). The
  // decideCdSync skip guard makes the reverse-direction navigateTo a no-op,
  // so the two directions don't ping-pong.
  // The settings store replaces its whole state object on ANY update, so this
  // effect also re-runs for unrelated changes — e.g. terminalPanelHeight on
  // every pointermove of a panel drag-resize. Only a genuine path change may
  // inject a cd, or a resize floods the shell with them (#409).
  let lastSyncTarget: string | null = null;
  $effect(() => {
    const path = windowTabsManager.getActiveExplorer()?.currentPath;
    if (!settingsStore.terminalFollowsExplorer) return;
    if (!path || terminalId === null || !terminalPanelStore.everOpened) return;
    if (path === lastSyncTarget) return;
    lastSyncTarget = path;
    void syncTerminalToPath(path).catch((err) => {
      // terminalStatus may reject if the shell died between checks; a rejected
      // sync must not surface as an unhandled promise rejection (#154).
      console.error("[terminal] sync-to-path failed:", err);
    });
  });

  // Keep the counter-zoom + font size in step with the app zoom level (#419).
  $effect(() => {
    const factor = zoomFactor;
    if (!term) return;
    term.options.fontSize = Math.round(BASE_FONT_SIZE * factor);
    requestAnimationFrame(() => {
      if (terminalPanelStore.visible) fitAddon?.fit();
    });
  });

  // Refit + refocus when the panel is re-shown (it keeps running while hidden;
  // display:none gives xterm a 0×0 box it must recover from).
  $effect(() => {
    if (visible && term) {
      requestAnimationFrame(() => {
        fitAddon?.fit();
        term?.focus();
      });
    }
  });

  // ── Drag-resize via the top edge ──────────────────────────────────────────
  function startResize(event: PointerEvent): void {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = settingsStore.terminalPanelHeight;
    const onMove = (e: PointerEvent) => {
      settingsStore.setTerminalPanelHeight(startHeight + (startY - e.clientY));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }
</script>

<!-- Counter-zoom (#419): net zoom 1.0 inside the panel so xterm's pointer
     math is exact; height is pre-multiplied so the panel occupies the same
     visual space as it would zoomed. -->
<div
  class="terminal-panel"
  class:hidden={!visible}
  style:zoom={1 / zoomFactor}
  style:height="{settingsStore.terminalPanelHeight * zoomFactor}px"
  bind:this={panelEl}
>
  <div
    class="resize-handle"
    role="separator"
    aria-orientation="horizontal"
    aria-label="Resize terminal"
    onpointerdown={startResize}
  ></div>
  <div class="terminal-header">
    <span class="terminal-title" role="img" aria-label="Terminal" title="Terminal">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
        <path d="M4 6l2.5 2L4 10" />
        <path d="M8 10.5h4" />
      </svg>
    </span>
    <div class="terminal-actions">
      <button
        class="action-btn"
        title="Hide terminal (Ctrl+`)"
        aria-label="Hide terminal"
        onclick={() => terminalPanelStore.close()}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <path d="M3.5 3.5l9 9m0-9l-9 9"/>
        </svg>
      </button>
    </div>
  </div>
  <div class="terminal-host" bind:this={termEl}></div>
  {#if exited}
    <div class="exited-overlay">
      <span>Shell exited</span>
      <button class="restart-btn" onclick={restartShell}>Restart</button>
    </div>
  {/if}
</div>

<style>
  .terminal-panel {
    position: relative;
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    background: var(--background-solid);
    border-top: 1px solid var(--divider);
  }

  .terminal-panel.hidden {
    display: none;
  }

  /* Drop target (#265): dropping files types their paths into the prompt. */
  .terminal-panel:global(.drop-target) {
    box-shadow: inset 0 0 0 1px var(--accent);
    background: color-mix(in srgb, var(--accent) 8%, var(--background-solid));
  }

  .resize-handle {
    position: absolute;
    top: -3px;
    left: 0;
    right: 0;
    height: 6px;
    cursor: ns-resize;
    z-index: 2;
  }

  .resize-handle:hover {
    background: color-mix(in srgb, var(--accent) 40%, transparent);
  }

  .terminal-header {
    /* Re-apply the app zoom the panel counter-zoomed away (#419): the header
       is plain DOM (no xterm hit-testing), so it should match the rest of
       the app's scale. */
    zoom: var(--app-zoom, 1);
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 2px 8px;
    border-bottom: 1px solid var(--divider);
    flex-shrink: 0;
  }

  .terminal-title {
    display: flex;
    align-items: center;
    color: var(--text-secondary);
  }

  .terminal-actions {
    display: flex;
    gap: 2px;
  }

  .action-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 22px;
    border: none;
    border-radius: var(--radius-sm, 4px);
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
  }

  .action-btn:hover {
    background: var(--subtle-fill-secondary);
    color: var(--text-primary);
  }

  .terminal-host {
    flex: 1;
    min-height: 0;
    padding: 4px 8px 0;
    overflow: hidden;
  }

  /* xterm fills the host */
  .terminal-host :global(.xterm),
  .terminal-host :global(.xterm-viewport),
  .terminal-host :global(.xterm-screen) {
    height: 100%;
  }

  .exited-overlay {
    position: absolute;
    inset: 0;
    top: 27px; /* keep the header interactive */
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    background: color-mix(in srgb, var(--background-solid) 75%, transparent);
    color: var(--text-secondary);
    font-size: 13px;
  }

  .restart-btn {
    padding: 4px 14px;
    border: 1px solid var(--control-stroke);
    border-radius: var(--radius-sm, 4px);
    background: var(--control-fill);
    color: var(--text-primary);
    cursor: pointer;
    font-size: 13px;
  }

  .restart-btn:hover {
    background: var(--control-fill-secondary);
  }
</style>

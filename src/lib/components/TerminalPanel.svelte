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
  import { terminalSpawn, terminalWrite, terminalResize, terminalKill, terminalStatus } from "$lib/api/terminal";
  import { buildTerminalTheme } from "$lib/domain/terminal-theme";
  import { buildCdSyncSequence } from "$lib/domain/terminal-command";
  import { decideCdSync } from "$lib/domain/terminal-cwd-sync";
  import { isWindows } from "$lib/domain/platform";
  import { settingsStore } from "$lib/state/settings.svelte";
  import { terminalPanelStore } from "$lib/state/terminal.svelte";
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";
  import { toastStore } from "$lib/state/toast.svelte";

  let panelEl: HTMLDivElement | undefined = $state();
  let termEl: HTMLDivElement | undefined = $state();
  let term: Terminal | undefined;
  let fitAddon: FitAddon | undefined;
  let terminalId: number | null = null;
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
      const id = await terminalSpawn(cwd, term.cols, term.rows);
      terminalId = id;

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
        const path = event.payload;
        // Always track it — this is the loop guard for the other direction.
        lastShellCwd = path;
        if (!settingsStore.explorerFollowsTerminal) return;
        const explorer = windowTabsManager.getActiveExplorer();
        if (explorer && explorer.currentPath !== path) {
          explorer.navigateTo(path);
        }
      });
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
  function writeCd(path: string): void {
    if (terminalId === null) return;
    terminalWrite(terminalId, buildCdSyncSequence(path, isWindows));
  }

  /** Terminal follows explorer: reconcile the shell's cwd with `path`. */
  async function syncTerminalToPath(path: string): Promise<void> {
    if (terminalId === null) return;
    const status = await terminalStatus(terminalId);
    lastShellCwd = status.cwd ?? lastShellCwd;
    switch (decideCdSync(path, status.cwd, status.busy)) {
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
      if (terminalId === null || pendingCd === null) {
        stopQueuePoll();
        return;
      }
      const status = await terminalStatus(terminalId);
      lastShellCwd = status.cwd ?? lastShellCwd;
      if (status.busy) return;
      const target = pendingCd;
      pendingCd = null;
      stopQueuePoll();
      queueToastShown = false;
      // Re-check against the shell's cwd: it may have cd'd itself meanwhile.
      if (decideCdSync(target, status.cwd, false) === "write") writeCd(target);
    }, 500);
  }

  function stopQueuePoll(): void {
    if (queuePoll !== null) {
      clearInterval(queuePoll);
      queuePoll = null;
    }
    queueToastShown = false;
  }

  onMount(() => {
    term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'JetBrainsMono Nerd Font', 'Cascadia Code', 'SF Mono', Menlo, Consolas, monospace",
      theme: buildTerminalTheme(resolveThemeColor),
      scrollback: 5000,
    });
    fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
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

    return () => {
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

  // Re-theme xterm when the app theme changes. CSS vars cascade on their own,
  // but xterm's colors are plain values that must be pushed imperatively.
  $effect(() => {
    settingsStore.theme; // dependency: theme id
    if (!term || !panelEl) return;
    term.options.theme = buildTerminalTheme(resolveThemeColor);
  });

  // Terminal follows explorer: when the active pane navigates, cd the shell.
  // Runs even while the panel is hidden (the shell is alive), but only after
  // the panel has been opened at least once (terminalId is live). The
  // decideCdSync skip guard makes the reverse-direction navigateTo a no-op,
  // so the two directions don't ping-pong.
  $effect(() => {
    const path = windowTabsManager.getActiveExplorer()?.currentPath;
    if (!settingsStore.terminalFollowsExplorer) return;
    if (!path || terminalId === null || !terminalPanelStore.everOpened) return;
    void syncTerminalToPath(path);
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

<div
  class="terminal-panel"
  class:hidden={!visible}
  style:height="{settingsStore.terminalPanelHeight}px"
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
    <span class="terminal-title">Terminal</span>
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
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 2px 8px;
    border-bottom: 1px solid var(--divider);
    flex-shrink: 0;
  }

  .terminal-title {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
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

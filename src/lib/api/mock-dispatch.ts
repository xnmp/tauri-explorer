/**
 * Raw command dispatch for the browser/e2e mock backend: the merged command
 * table, per-command invocation counting, injected failures and latency.
 * `mock-invoke.ts` installs the table; family modules that re-enter the mock
 * (file-history inverses, preview fallbacks) call `invokeMockCommand` here
 * rather than importing `mock-invoke.ts`, which keeps the module graph acyclic.
 */
import { getMockControl } from "./mock-control";

export type CommandHandler = (args: Record<string, unknown>) => unknown;

type CommandTable = Readonly<Record<string, CommandHandler>>;
/** Wraps the merged table (the site demo routes its fixture repositories through one). */
export type MockCommandLayer = (commands: CommandTable) => CommandTable;

let baseCommands: CommandTable = {};
let commandLayer: MockCommandLayer | null = null;
let mockCommands: CommandTable = {};

/** Install the merged command table (called once by `mock-invoke.ts`). */
export function installMockCommands(commands: CommandTable): void {
  baseCommands = commands;
  mockCommands = commandLayer ? commandLayer(baseCommands) : baseCommands;
}

/**
 * Wrap every command in `layer` (null: none), whether the table is installed
 * yet or later. The demo installs its fixture-repository layer this way, so
 * `mock-invoke.ts` never imports it and ordinary builds do not ship it.
 * Returns the way back to the previous layer.
 */
export function setMockCommandLayer(layer: MockCommandLayer | null): () => void {
  const previous = commandLayer;
  commandLayer = layer;
  mockCommands = layer ? layer(baseCommands) : baseCommands;
  return () => { setMockCommandLayer(previous); };
}

export async function invokeMockCommand<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (typeof window !== "undefined") {
    const control = getMockControl();
    control.invokeCounts ??= {};
    control.invokeCounts[cmd] = (control.invokeCounts[cmd] ?? 0) + 1;
    control.invokeArgs?.[cmd]?.push({ ...args });
  }

  await waitForMockLatency(cmd);

  // Reject the way the real backend does: Tauri serializes AppError as
  // { kind, message } (src-tauri/src/error.rs), not as an Error.
  const failure = getMockControl().failures?.[cmd];
  if (failure) throw { kind: "other", message: failure };

  const handler = mockCommands[cmd];
  if (!handler) {
    throw new Error(`Unknown command: ${cmd}`);
  }

  return handler(args || {}) as T;
}

export async function waitForMockLatency(cmd: string): Promise<void> {
  // Add small delay to simulate async operation.
  await new Promise((resolve) => setTimeout(resolve, 10));

  // Per-command extra latency, settable from E2E tests / the console
  // (window.__mockControl.latency = { git_status: 2000 }) or via URL for
  // fetches that fire during boot (?mockLatency=git_status:2000,foo:500),
  // to make transient loading states observable and assertable (#271).
  const control = getMockControl();
  if (!control.latency && typeof location !== "undefined") {
    control.latency = {};
    const param = new URLSearchParams(location.search).get("mockLatency");
    for (const pair of param?.split(",") ?? []) {
      const [name, ms] = pair.split(":");
      if (name && Number(ms) > 0) control.latency[name] = Number(ms);
    }
  }
  const extraLatency = control.latency?.[cmd];
  if (extraLatency) await new Promise((resolve) => setTimeout(resolve, extraLatency));
}

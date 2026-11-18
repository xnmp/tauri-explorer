/**
 * Mock embedded-terminal backend for the browser fixture (#139's PTY
 * commands). The native backend reports a terminal's output, exit and OSC 7
 * working directory as per-terminal Tauri events; outside Tauri those travel
 * through this module's in-memory channel (`listenMockTerminal`), which
 * `api/terminal.ts` subscribes to instead.
 *
 * A fixture world may install a shell (`setMockTerminalBackend`). Without one
 * the terminal starts but never prints, as the browser suite expects.
 */
import type { CommandHandler } from "./mock-dispatch";

export type MockTerminalChannel = "output" | "exit" | "cwd";

type Listener = (payload: unknown) => void;
const listeners = new Map<string, Set<Listener>>();
const key = (channel: MockTerminalChannel, id: number) => `${channel}:${id}`;

/** Subscribe to one terminal's channel; returns the unsubscribe function. */
export function listenMockTerminal<T>(channel: MockTerminalChannel, id: number, handler: (payload: T) => void): () => void {
  const set = listeners.get(key(channel, id)) ?? new Set<Listener>();
  const listener = handler as Listener;
  set.add(listener);
  listeners.set(key(channel, id), set);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(key(channel, id));
  };
}

/** Deliver a payload to one terminal's channel, as the native event would. */
export function emitMockTerminal(channel: MockTerminalChannel, id: number, payload: unknown): void {
  for (const listener of [...(listeners.get(key(channel, id)) ?? [])]) listener(payload);
}

/** A shell behind the mock PTY. Output goes out through `emitMockTerminal`. */
export interface MockTerminalBackend {
  spawn(id: number, cwd: string | undefined, cols: number, rows: number): void;
  /** Input, in the order the frontend numbered it. */
  write(id: number, data: string): void;
  resize(id: number, cols: number, rows: number): void;
  kill(id: number): void;
  status(id: number): { busy: boolean; cwd: string | null };
}

let backend: MockTerminalBackend | null = null;
let nextId = 1;
/** Per-terminal input admission: the next expected `seq` and early arrivals. */
const inputs = new Map<number, { next: number; early: Map<number, string> }>();

export function setMockTerminalBackend(next: MockTerminalBackend | null): void {
  backend = next;
}

function admit(id: number, seq: number, data: string): void {
  const input = inputs.get(id) ?? { next: 0, early: new Map<number, string>() };
  inputs.set(id, input);
  // Like the native queue (#882): a repeated or stale seq is ignored, and a
  // write that overtook an earlier one waits for it.
  if (seq < input.next || input.early.has(seq)) return;
  input.early.set(seq, data);
  for (let ready = input.early.get(input.next); ready !== undefined; ready = input.early.get(input.next)) {
    input.early.delete(input.next);
    input.next += 1;
    backend?.write(id, ready);
  }
}

export const terminalCommands: Record<string, CommandHandler> = {
  terminal_reserve_id: () => (backend ? nextId++ : 1),
  terminal_spawn: (args) => {
    const id = Number(args.id);
    inputs.delete(id);
    backend?.spawn(id, typeof args.cwd === "string" ? args.cwd : undefined, Number(args.cols), Number(args.rows));
    return { id, shellKind: "posix", wslDistro: null };
  },
  terminal_write: (args) => {
    if (backend) admit(Number(args.id), Number(args.seq), String(args.data ?? ""));
    return { droppedBytes: 0 };
  },
  terminal_resize: (args) => { backend?.resize(Number(args.id), Number(args.cols), Number(args.rows)); },
  terminal_kill: (args) => {
    inputs.delete(Number(args.id));
    backend?.kill(Number(args.id));
  },
  terminal_status: (args) => backend?.status(Number(args.id)) ?? { busy: false, cwd: null },
};

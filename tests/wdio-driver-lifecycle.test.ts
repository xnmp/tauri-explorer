import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const listeners: Record<string, (...args: unknown[]) => void> = {};
  const child = {
    emit(event: string, ...args: unknown[]) {
      listeners[event]?.(...args);
    },
    once: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      listeners[event] = listener;
    }),
    stderr: { on: vi.fn() },
    stdout: { on: vi.fn() },
  } as {
    emit(event: string, ...args: unknown[]): void;
    once: ReturnType<typeof vi.fn>;
    stderr: { on: ReturnType<typeof vi.fn> };
    stdout: { on: ReturnType<typeof vi.fn> };
  };

  return {
    child,
    driverLog: { end: vi.fn(), write: vi.fn() },
    spawn: vi.fn(() => child),
  };
});

vi.mock("node:child_process", () => ({ spawn: harness.spawn }));
vi.mock("node:fs", () => ({
  createWriteStream: vi.fn(() => harness.driverLog),
  mkdirSync: vi.fn(),
}));

const { config } = await import("../e2e-tauri/wdio.conf");

describe("Tauri driver lifecycle", () => {
  beforeEach(() => {
    harness.driverLog.end.mockClear();
    harness.driverLog.write.mockClear();
    harness.spawn.mockClear();
  });

  it("keeps the driver transcript open until its output streams close", () => {
    const beforeSession = config.beforeSession as () => void;
    beforeSession();

    harness.child.emit("exit", 0, null);
    expect(harness.driverLog.end).not.toHaveBeenCalled();

    harness.child.emit("close", 0, null);
    expect(harness.driverLog.end).toHaveBeenCalledWith(
      "[tauri-e2e] driver exited code=0 signal=null\n",
    );
  });
});

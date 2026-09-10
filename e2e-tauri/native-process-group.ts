import type { ChildProcess } from "node:child_process";
import fs from "node:fs";

export interface NativeProcessGroupStopOptions {
  gracefulTimeoutMs: number;
  forceTimeoutMs: number;
  pollIntervalMs?: number;
}

export interface NativeProcessGroup {
  readonly pid: number;
}

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function currentProcessGroupId(): number {
  // Linux makes the process group ID available as field five. The executable
  // name is parenthesized and may contain spaces, so parse after its final ')'.
  const contents = fs.readFileSync("/proc/self/stat", "utf8");
  const suffix = contents.slice(contents.lastIndexOf(")") + 2).split(" ");
  return Number(suffix[2]);
}

function assertSafeProcessGroup(group: NativeProcessGroup): number {
  if (process.platform !== "linux") {
    throw new Error("native process-group cleanup is supported only on Linux");
  }
  const groupId = group.pid;
  if (!Number.isSafeInteger(groupId) || groupId <= 1) {
    throw new Error(`refusing unsafe native process group ${groupId}`);
  }
  if (groupId === process.pid || groupId === currentProcessGroupId()) {
    throw new Error(`refusing current native process group ${groupId}`);
  }
  return groupId;
}

function processGroupExists(groupId: number): boolean {
  try {
    process.kill(-groupId, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

async function waitForProcessGroupExit(
  groupId: number,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(groupId)) {
    if (Date.now() >= deadline) return false;
    await delay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
  }
  return true;
}

function signalProcessGroup(groupId: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-groupId, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

/** Stops every process in a Linux process group created with `detached: true`. */
export async function stopNativeProcessGroup(
  group: NativeProcessGroup,
  label: string,
  options: NativeProcessGroupStopOptions = {
    gracefulTimeoutMs: 5_000,
    forceTimeoutMs: 2_000,
  },
): Promise<void> {
  const groupId = assertSafeProcessGroup(group);
  const pollIntervalMs = options.pollIntervalMs ?? 25;
  if (
    !Number.isFinite(options.gracefulTimeoutMs) ||
    options.gracefulTimeoutMs < 0 ||
    !Number.isFinite(options.forceTimeoutMs) ||
    options.forceTimeoutMs < 0 ||
    !Number.isFinite(pollIntervalMs) ||
    pollIntervalMs <= 0
  ) {
    throw new Error("native process-group stop timeouts must be bounded non-negative values");
  }
  if (!processGroupExists(groupId)) return;

  signalProcessGroup(groupId, "SIGTERM");
  if (
    await waitForProcessGroupExit(
      groupId,
      options.gracefulTimeoutMs,
      pollIntervalMs,
    )
  ) return;

  signalProcessGroup(groupId, "SIGKILL");
  if (
    !(await waitForProcessGroupExit(
      groupId,
      options.forceTimeoutMs,
      pollIntervalMs,
    ))
  ) {
    throw new Error(
      `${label} process group ${groupId} remained alive after SIGKILL for ${options.forceTimeoutMs}ms`,
    );
  }
}

export function nativeProcessGroup(child: ChildProcess): NativeProcessGroup {
  if (child.pid === undefined) {
    throw new Error("native process-group leader has no pid");
  }
  return { pid: child.pid };
}

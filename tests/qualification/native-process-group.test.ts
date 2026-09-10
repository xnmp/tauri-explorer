import { spawn, type ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  nativeProcessGroup,
  stopNativeProcessGroup,
  type NativeProcessGroup,
} from "../../e2e-tauri/native-process-group";

const linuxIt = process.platform === "linux" ? it : it.skip;

function groupExists(group: NativeProcessGroup): boolean {
  try {
    process.kill(-group.pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

function spawnGroup(source: string): ChildProcess {
  return spawn(process.execPath, ["-e", source], {
    detached: true,
    stdio: ["ignore", "pipe", "inherit"],
  });
}

async function waitForLine(child: ChildProcess, timeoutMs = 1_000): Promise<string> {
  let buffered = "";
  child.stdout!.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`process did not publish readiness within ${timeoutMs}ms`));
    }, timeoutMs);
    const onData = (chunk: string) => {
      buffered += chunk;
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      cleanup();
      resolve(buffered.slice(0, newline));
    };
    const onEnd = () => {
      cleanup();
      reject(new Error("stdout ended before process published readiness"));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout!.off("data", onData);
      child.stdout!.off("end", onEnd);
      child.stdout!.off("error", onError);
    };
    child.stdout!.on("data", onData);
    child.stdout!.once("end", onEnd);
    child.stdout!.once("error", onError);
  });
}

async function forceCleanup(group: NativeProcessGroup): Promise<void> {
  if (!groupExists(group)) return;
  try {
    process.kill(-group.pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  for (let attempt = 0; attempt < 100 && groupExists(group); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(groupExists(group), "fixture cleanup must remove its process group").toBe(false);
}

describe("Linux native process-group cleanup", () => {
  linuxIt("rejects an unsafe group instead of masking cleanup failure", async () => {
    await expect(
      stopNativeProcessGroup({ pid: 1 }, "unsafe driver"),
    ).rejects.toThrow("refusing unsafe native process group 1");
  });

  linuxIt("bounds missing readiness and still reaps the failed fixture", async () => {
    const leader = spawnGroup("setInterval(() => {}, 1000)");
    const group = nativeProcessGroup(leader);
    try {
      await expect(waitForLine(leader, 50)).rejects.toThrow(
        "process did not publish readiness within 50ms",
      );
    } finally {
      await forceCleanup(group);
    }
    expect(groupExists(group)).toBe(false);
  });

  linuxIt("reaps a nested application after its driver parent exits", async () => {
    const leader = spawnGroup(`
      const { spawn } = require("node:child_process");
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      require("node:fs").writeSync(1, child.pid + "\\n");
      child.unref();
    `);
    const group = nativeProcessGroup(leader);
    try {
      const descendantPid = Number(await waitForLine(leader));
      await expect.poll(() => leader.exitCode !== null || leader.signalCode !== null,
        { timeout: 1_000 }).toBe(true);
      expect(groupExists(group)).toBe(true);
      process.kill(descendantPid, 0);

      await stopNativeProcessGroup(group, "test driver", {
        gracefulTimeoutMs: 1_000,
        forceTimeoutMs: 1_000,
      });
      expect(groupExists(group)).toBe(false);
    } finally {
      await forceCleanup(group);
    }
  });

  linuxIt("escalates when a nested application ignores SIGTERM", async () => {
    const leader = spawnGroup(`
      const { spawn } = require("node:child_process");
      const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); require('node:fs').writeSync(1, 'ready\\\\n'); setInterval(() => {}, 1000)"], { stdio: ["ignore", "pipe", "ignore"] });
      child.stdout.once("data", () => { require("node:fs").writeSync(1, child.pid + "\\n"); setInterval(() => {}, 1000); });
      process.on("SIGTERM", () => process.exit(0));
    `);
    const group = nativeProcessGroup(leader);
    try {
      await waitForLine(leader);
      const started = Date.now();
      await stopNativeProcessGroup(group, "test driver", {
        gracefulTimeoutMs: 100,
        forceTimeoutMs: 1_000,
        pollIntervalMs: 10,
      });
      expect(Date.now() - started).toBeGreaterThanOrEqual(90);
      expect(groupExists(group)).toBe(false);
    } finally {
      await forceCleanup(group);
    }
  });

  linuxIt("does not signal an unrelated sibling process group", async () => {
    const owned = spawnGroup("require('node:fs').writeSync(1, 'ready\\n'); setInterval(() => {}, 1000)");
    const sibling = spawnGroup("require('node:fs').writeSync(1, 'ready\\n'); setInterval(() => {}, 1000)");
    const ownedGroup = nativeProcessGroup(owned);
    const siblingGroup = nativeProcessGroup(sibling);
    try {
      await Promise.all([waitForLine(owned), waitForLine(sibling)]);
      await stopNativeProcessGroup(ownedGroup, "owned driver", {
        gracefulTimeoutMs: 1_000,
        forceTimeoutMs: 1_000,
      });
      expect(groupExists(ownedGroup)).toBe(false);
      expect(groupExists(siblingGroup)).toBe(true);
      process.kill(sibling.pid!, 0);
    } finally {
      await Promise.all([forceCleanup(ownedGroup), forceCleanup(siblingGroup)]);
    }
  });
});

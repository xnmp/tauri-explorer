/** Exact Linux /proc observations used by native resource-lifetime acceptance. */
import fs from "node:fs";
import { processExecutable, processStartTime } from "./native-process";

export interface NativeProcessIdentity {
  pid: number;
  executable: string;
  startTime: string;
}

export interface NativeFileIdentity {
  device: bigint;
  inode: bigint;
}

export interface InotifyWatch {
  fd: number;
  watchDescriptor: bigint;
  device: bigint;
  inode: bigint;
}

const inotifyLine = /^inotify\s+wd:([0-9a-f]+)\s+ino:([0-9a-f]+)\s+sdev:([0-9a-f]+)(?:\s|$)/i;

function hex(value: string): bigint {
  return BigInt(`0x${value}`);
}

/**
 * `/proc/<pid>/fdinfo` prints the kernel's internal 12:20 `dev_t`, while
 * `stat(2)` exposes the userspace encoding produced by `new_encode_dev`.
 * Convert before comparing device identity; the inode value needs no rewrite.
 *
 * Mirrors Linux `include/linux/kdev_t.h`: MAJOR/MINOR plus new_encode_dev.
 */
function userspaceDeviceNumber(kernelDevice: bigint): bigint {
  const major = kernelDevice >> 20n;
  const minor = kernelDevice & 0xfffffn;
  return (minor & 0xffn) | (major << 8n) | ((minor & ~0xffn) << 12n);
}

function assertSameProcess(identity: NativeProcessIdentity): void {
  const executable = processExecutable(identity.pid);
  const startTime = processStartTime(identity.pid);
  if (executable !== identity.executable || startTime !== identity.startTime) {
    throw new Error(
      `native process identity changed for pid ${identity.pid}: `
      + `expected ${identity.executable}@${identity.startTime}, `
      + `found ${executable ?? "missing"}@${startTime ?? "missing"}`,
    );
  }
}

/** Pin a live process before inspecting any reusable numeric PID. */
export function nativeProcessIdentity(pid: number): NativeProcessIdentity {
  const executable = processExecutable(pid);
  const startTime = processStartTime(pid);
  if (!executable || !startTime) throw new Error(`native process ${pid} is not alive`);
  return { pid, executable, startTime };
}

/** Follow symlinks, matching the inode that inotify registers. */
export function nativeFileIdentity(target: string): NativeFileIdentity {
  const stat = fs.statSync(target, { bigint: true });
  return { device: stat.dev, inode: stat.ino };
}

/**
 * Read every inotify watch descriptor held by one exact process.
 *
 * One inotify file descriptor can own many directory watches, so counting
 * descriptors in /proc/<pid>/fd is insufficient for retention tests.
 */
export function readInotifyWatches(identity: NativeProcessIdentity): InotifyWatch[] {
  if (process.platform !== "linux") throw new Error("inotify resources are Linux-only");
  assertSameProcess(identity);
  const fdInfoDirectory = `/proc/${identity.pid}/fdinfo`;
  const watches: InotifyWatch[] = [];
  for (const name of fs.readdirSync(fdInfoDirectory)) {
    if (!/^\d+$/.test(name)) continue;
    let contents: string;
    try {
      contents = fs.readFileSync(`${fdInfoDirectory}/${name}`, "utf8");
    } catch (error) {
      // File descriptors may close between readdir and read. A complete
      // process identity check below distinguishes that from process exit.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const line of contents.split("\n")) {
      const match = inotifyLine.exec(line);
      if (!match) continue;
      watches.push({
        fd: Number(name),
        watchDescriptor: hex(match[1]),
        inode: hex(match[2]),
        device: userspaceDeviceNumber(hex(match[3])),
      });
    }
  }
  assertSameProcess(identity);
  return watches;
}

export function inotifyWatchesForPath(
  identity: NativeProcessIdentity,
  target: string,
): InotifyWatch[] {
  const expected = nativeFileIdentity(target);
  return readInotifyWatches(identity).filter(
    ({ device, inode }) => device === expected.device && inode === expected.inode,
  );
}

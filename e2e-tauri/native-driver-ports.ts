import fs from "node:fs";
import net from "node:net";
import type { ChildProcess } from "node:child_process";

export interface NativeDriverPorts {
  driver: number;
  backend: number;
}
export function resolveNativeDriverPorts(
  environment: NodeJS.ProcessEnv,
): NativeDriverPorts {
  const read = (key: string, fallback: number) => {
    const value = environment[key];
    if (value === undefined) return fallback;
    const port = Number(value);
    if (
      !/^\d+$/.test(value) ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535
    )
      throw new Error(`${key} must be a TCP port between 1 and 65535`);
    return port;
  };
  const ports = {
    driver: read("TAURI_NATIVE_DRIVER_PORT", 4444),
    backend: read("TAURI_NATIVE_BACKEND_PORT", 4445),
  };
  if (ports.driver === ports.backend)
    throw new Error("Native driver and backend ports must be distinct");
  return ports;
}

/** Probe availability without connecting to or sending requests to an existing listener. */
export async function assertNativePortsAvailable(
  ports: NativeDriverPorts,
): Promise<void> {
  const reservations: net.Server[] = [];
  try {
    for (const port of [ports.driver, ports.backend]) {
      const server = net.createServer();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => resolve());
      });
      reservations.push(server);
    }
  } finally {
    await Promise.all(
      reservations.map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
    );
  }
}

function ownedLinuxListenerPorts(group: number): Set<number> {
  const inodes = new Set<string>();
  for (const pid of fs
    .readdirSync("/proc")
    .filter((value) => /^\d+$/.test(value))) {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(fields[2]) !== group) continue;
      for (const descriptor of fs.readdirSync(`/proc/${pid}/fd`)) {
        try {
          const match = fs
            .readlinkSync(`/proc/${pid}/fd/${descriptor}`)
            .match(/^socket:\[(\d+)\]$/);
          if (match) inodes.add(match[1]);
        } catch {
          /* A descriptor can close while it is sampled. */
        }
      }
    } catch {
      /* A process can exit while it is sampled. */
    }
  }
  const ports = new Set<number>();
  for (const table of ["tcp", "tcp6"]) {
    for (const line of fs
      .readFileSync(`/proc/net/${table}`, "utf8")
      .trim()
      .split("\n")
      .slice(1)) {
      const fields = line.trim().split(/\s+/);
      const [address, port] = fields[1].split(":");
      // WDIO and tauri-driver connect to IPv4 127.0.0.1. A listener on
      // another loopback address with the same port cannot establish ownership
      // of that endpoint. Fail closed on IPv6-only listeners too.
      const servesEndpoint =
        table === "tcp" && (address === "0100007F" || address === "00000000");
      if (servesEndpoint && fields[3] === "0A" && inodes.has(fields[9]))
        ports.add(parseInt(port, 16));
    }
  }
  return ports;
}

/** Linux drivers start in their own process group. Verify both actual listeners
 * belong to that group before WDIO can send a session request; a successful
 * TCP connection alone could identify an unrelated process that won the race. */
export async function waitForOwnedNativePorts(
  child: ChildProcess,
  ports: NativeDriverPorts,
  timeoutMs = 10_000,
): Promise<void> {
  if (!child.pid) throw new Error("Native driver did not start");
  let spawnError: Error | undefined;
  const onError = (error: Error) => {
    spawnError = error;
  };
  child.on("error", onError);
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(
          "Owned native driver exited before its listeners were ready",
        );
      const owned = ownedLinuxListenerPorts(child.pid);
      if (owned.has(ports.driver) && owned.has(ports.backend)) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Owned native driver listeners did not become ready");
  } finally {
    child.off("error", onError);
  }
}

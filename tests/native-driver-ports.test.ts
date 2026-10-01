import { afterEach, describe, expect, it } from "vitest";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import {
  assertNativePortsAvailable,
  resolveNativeDriverPorts,
  waitForOwnedNativePorts,
} from "../e2e-tauri/native-driver-ports";

const children: ChildProcess[] = [];
const servers: net.Server[] = [];
afterEach(async () => {
  await Promise.all(
    children.splice(0).map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null)
            return resolve();
          child.once("exit", () => resolve());
          child.kill();
        }),
    ),
  );
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});
async function listener() {
  const server = net.createServer();
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as net.AddressInfo).port };
}
async function unusedPorts() {
  const a = await listener(),
    b = await listener();
  await Promise.all(
    [a.server, b.server].map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  for (const closed of [a.server, b.server]) {
    const index = servers.indexOf(closed);
    if (index >= 0) servers.splice(index, 1);
  }
  return { driver: a.port, backend: b.port };
}
describe("native driver endpoint ownership", () => {
  it("preserves defaults and rejects invalid or identical endpoints", () => {
    expect(resolveNativeDriverPorts({})).toEqual({
      driver: 4444,
      backend: 4445,
    });
    expect(
      resolveNativeDriverPorts({
        TAURI_NATIVE_DRIVER_PORT: "4520",
        TAURI_NATIVE_BACKEND_PORT: "4521",
      }),
    ).toEqual({ driver: 4520, backend: 4521 });
    for (const value of [
      "",
      "abc",
      "0",
      "-1",
      "1.5",
      "65536",
      "9999999999999999999999",
    ])
      expect(() =>
        resolveNativeDriverPorts({ TAURI_NATIVE_DRIVER_PORT: value }),
      ).toThrow(/TCP port/);
    expect(() =>
      resolveNativeDriverPorts({
        TAURI_NATIVE_DRIVER_PORT: "4520",
        TAURI_NATIVE_BACKEND_PORT: "4520",
      }),
    ).toThrow(/distinct/);
  });
  it("refuses an occupied endpoint without connecting to its owner", async () => {
    const { server, port } = await listener();
    let connections = 0;
    server.on("connection", (socket) => {
      connections++;
      socket.destroy();
    });
    const { backend } = await unusedPorts();
    // unusedPorts closes only the newly allocated reservations; preserve the foreign listener.
    expect(server.listening).toBe(true);
    await expect(
      assertNativePortsAvailable({ driver: port, backend }),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });
    expect(server.listening).toBe(true);
    expect(connections).toBe(0);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  it.skipIf(process.platform !== "linux")(
    "accepts actual listeners belonging to the owned process group",
    async () => {
      const ports = await unusedPorts();
      const script =
        "const net=require('node:net');for(const p of process.argv.slice(1))net.createServer().listen(Number(p),'127.0.0.1');";
      const child = spawn(
        process.execPath,
        ["-e", script, String(ports.driver), String(ports.backend)],
        { detached: true, stdio: "pipe" },
      );
      children.push(child);
      await expect(
        waitForOwnedNativePorts(child, ports, 3000),
      ).resolves.toBeUndefined();
    },
  );
  it.skipIf(process.platform !== "linux")(
    "does not mistake an unrelated listener for a live owned driver",
    async () => {
      const { port } = await listener();
      const child = spawn(
        process.execPath,
        ["-e", "setInterval(()=>{},1000)"],
        { detached: true, stdio: "pipe" },
      );
      children.push(child);
      await expect(
        waitForOwnedNativePorts(child, { driver: port, backend: port }, 75),
      ).rejects.toThrow(/Owned native driver listeners/);
    },
  );
  it.skipIf(process.platform !== "linux")(
    "rejects owned ports on a different loopback address",
    async () => {
      const a = await listener(),
        b = await listener();
      const ports = { driver: a.port, backend: b.port };
      const script =
        "const net=require('node:net');for(const p of process.argv.slice(1))net.createServer().listen(Number(p),'127.0.0.2');";
      const child = spawn(
        process.execPath,
        ["-e", script, String(ports.driver), String(ports.backend)],
        { detached: true, stdio: "pipe" },
      );
      children.push(child);
      await expect(waitForOwnedNativePorts(child, ports, 150)).rejects.toThrow(
        /Owned native driver listeners/,
      );
      expect(a.server.listening).toBe(true);
      expect(b.server.listening).toBe(true);
    },
  );
});

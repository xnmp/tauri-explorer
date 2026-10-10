/** A dialog opened by a command chosen from the command palette must outlive
 * the palette. The palette's Modal releases its surface in an effect cleanup
 * (scheduled, like Svelte's flush, after the state change that closes it). */
import { afterEach, expect, it } from "vitest";
import type { Component } from "svelte";
import { dialogRegistry } from "$lib/plugins/dialog-registry.svelte";
import { modalOwnership } from "$lib/state/modal-ownership.svelte";
import { runAfterClose } from "$lib/state/run-after-close";

const component = (() => {}) as unknown as Component;
afterEach(() => dialogRegistry.clear());

/** A launcher whose surface is released after close(), as Modal's effect does. */
function launcher() {
  const surface = modalOwnership.registerSurface(() => {});
  return { close: () => queueMicrotask(() => surface.release()) };
}

it("a managed dialog opened by the chosen command stays open after the palette closes", async () => {
  dialogRegistry.register({ id: "provider.connections", component });
  const palette = launcher();
  let result: unknown = "pending";
  await runAfterClose(palette.close, async () => {
    void dialogRegistry.openManaged("provider.connections").result.then((value) => { result = value; });
  });
  await Promise.resolve();
  expect(dialogRegistry.isOpen("provider.connections")).toBe(true);
  expect(result).toBe("pending");
  dialogRegistry.close("provider.connections");
  await Promise.resolve();
  expect(result).toEqual({ reason: "closed" });
});

it("runs the command once, after closing", async () => {
  const order: string[] = [];
  await runAfterClose(() => order.push("close"), async () => { order.push("run"); });
  expect(order).toEqual(["close", "run"]);
});

it("propagates a failing command", async () => {
  await expect(runAfterClose(() => {}, () => Promise.reject(new Error("refused")))).rejects.toThrow("refused");
});

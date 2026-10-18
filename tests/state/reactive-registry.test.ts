/**
 * #1270: a reactive reader (the open command palette) must observe entries
 * registered, disposed, deleted or cleared after it first read the list.
 * Compiled for the client because Vitest's SSR transform leaves $state inert.
 */
import { afterEach, beforeAll, expect, it } from "vitest";
import * as client from "svelte/internal/client";
import { compileClient } from "./folder-peek-harness";

let create: <T>() => ReturnType<typeof import("$lib/state/reactive-registry.svelte").createReactiveRegistry<T>>;
beforeAll(async () => {
  create = (await compileClient("reactive-registry.svelte")).createReactiveRegistry as typeof create;
});
const stops: (() => void)[] = [];
afterEach(() => { while (stops.length) stops.pop()!(); });

function observe(read: () => unknown[]) {
  let seen: unknown[] = [];
  stops.push(client.effect_root(() => { client.render_effect(() => { seen = read(); }); }));
  client.flush();
  return () => seen;
}

it("readers see a late registration and its disposal", () => {
  const registry = create<string>();
  const seen = observe(() => registry.values());
  expect(seen()).toEqual([]);
  const dispose = registry.register("a", "A");
  client.flush();
  expect(seen()).toEqual(["A"]);
  expect(dispose()).toBe(true);
  client.flush();
  expect(seen()).toEqual([]);
});

it("readers see replace, delete and clear", () => {
  const registry = create<string>();
  registry.register("a", "A1");
  const seen = observe(() => registry.values());
  registry.register("a", "A2", true);
  client.flush();
  expect(seen()).toEqual(["A2"]);
  registry.delete("a");
  client.flush();
  expect(seen()).toEqual([]);
  registry.register("b", "B");
  client.flush();
  registry.clear();
  client.flush();
  expect(seen()).toEqual([]);
});

it("a stale disposer does not remove or invalidate its replacement", () => {
  const registry = create<string>();
  const stale = registry.register("a", "A1");
  registry.register("a", "A2", true);
  const seen = observe(() => registry.values());
  expect(stale()).toBe(false);
  client.flush();
  expect(seen()).toEqual(["A2"]);
});

it("point lookups do not subscribe the reader to registry changes", () => {
  const registry = create<string>();
  let runs = 0;
  stops.push(client.effect_root(() => { client.render_effect(() => { registry.get("a"); runs++; }); }));
  client.flush();
  registry.register("a", "A");
  registry.delete("a");
  client.flush();
  expect(runs).toBe(1);
});

it("an effect that registers and disposes entries does not re-trigger itself", () => {
  const registry = create<string>();
  let runs = 0;
  stops.push(client.effect_root(() => {
    client.user_effect(() => {
      runs++;
      registry.delete("a");
      const dispose = registry.register("a", "A");
      return () => { dispose(); };
    });
  }));
  client.flush();
  client.flush();
  expect(runs).toBe(1);
});

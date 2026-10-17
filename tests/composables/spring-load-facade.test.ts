import { beforeEach, expect, it, vi } from "vitest";

// The eager spring-load entry point (#1242): free while Folder Peek is off,
// loads the driver on the first eligible hover and replays only what is
// still current once it has loaded.
const { settings, calls } = vi.hoisted(() => ({
  settings: { folderPeek: true },
  calls: [] as string[],
}));
vi.mock("$lib/state/settings.svelte", () => ({ settingsStore: settings }));
vi.mock("$lib/composables/spring-load-driver", () => ({
  createDomSpringLoadDriver: () => ({
    hover: (element: { id: string } | null) => calls.push(`hover:${element?.id ?? "null"}`),
    end: () => calls.push("end"),
    hold: () => { calls.push("hold"); return () => calls.push("release"); },
  }),
}));

const element = (id: string, isConnected = true) => ({ id, isConnected }) as unknown as Element;

beforeEach(() => {
  vi.resetModules();
  settings.folderPeek = true;
  calls.length = 0;
});
const load = () => import("$lib/composables/spring-load");
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

it("Folder Peek off: never hit-tests and never loads the driver", async () => {
  settings.folderPeek = false;
  const { springHover, springEnd, springHold } = await load();
  const locate = vi.fn(() => element("row"));
  springHover(locate);
  springEnd();
  springHold()();
  await settle();
  expect(locate).not.toHaveBeenCalled();
  expect(calls).toEqual([]);
});

it("the first hover loads the driver and is replayed; later hovers go straight through", async () => {
  const { springHover, springEnd, springHold } = await load();
  springHover(() => element("a"));
  springHover(() => element("b"));
  await settle();
  expect(calls).toEqual(["hover:b"]);
  springHover(() => element("c"));
  springEnd();
  springHold()();
  expect(calls).toEqual(["hover:b", "hover:c", "end", "hold", "release"]);
});

it("a drag that ends, leaves or loses its element before the driver loads replays nothing", async () => {
  const first = await load();
  first.springHover(() => element("a"));
  first.springEnd();
  await settle();
  expect(calls).toEqual([]);

  vi.resetModules();
  const second = await load();
  second.springHover(() => element("a"));
  second.springHover(() => null);
  await settle();
  expect(calls).toEqual([]);

  vi.resetModules();
  const third = await load();
  third.springHover(() => element("gone", false));
  await settle();
  expect(calls).toEqual([]);
});

it("turning Folder Peek off mid-drag closes the drag's peeks", async () => {
  const { springHover } = await load();
  springHover(() => element("a"));
  await settle();
  settings.folderPeek = false;
  const locate = vi.fn(() => element("b"));
  springHover(locate);
  expect(locate).not.toHaveBeenCalled();
  expect(calls).toEqual(["hover:a", "hover:null"]);
});

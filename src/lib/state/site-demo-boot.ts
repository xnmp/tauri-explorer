/**
 * Site demo boot (`VITE_SITE_DEMO=1` builds only; `hooks.client.ts` awaits
 * it before SvelteKit loads any route module, so nothing below races the
 * app's first command).
 *
 * 1. Storage becomes per-page memory: the demo shares an origin with the
 *    marketing site, and must neither read a visitor's earlier state nor
 *    leave its own behind.
 * 2. Handshake: post `hello` to the embedding page and wait for its `init`
 *    (fixture, asset base, user, settings, keybindings, start path). With no
 *    embedding page, or no answer in time, the built-in mock fixtures serve.
 * 3. Plan the boot (`domain/demo-boot.ts`, total over any host input), seed
 *    settings/keybindings/bookmarks, install the fixture world into the mock
 *    backend and the in-memory shell behind the terminal, then start the host
 *    bridge. If the fixture cannot be planned or installed, the built-in
 *    fixtures serve and `ready` carries the reason (`boot`).
 *
 * Modules that read storage at import time are imported only after step 3's
 * final seeding, which is why everything stateful below is a dynamic import.
 */
import { planDemoBoot, withoutDemoWorld, type DemoBootPlan, type DemoBootReport } from "$lib/domain/demo-boot";
import { appMessage, parseHostMessage, type DemoInit } from "$lib/domain/demo-protocol";

/** How long an embedding page has to answer `hello` before the built-in fixtures serve. */
const HANDSHAKE_TIMEOUT_MS = 5000;

class MemoryStorage implements Storage {
  #items = new Map<string, string>();
  get length() { return this.#items.size; }
  clear() { this.#items.clear(); }
  getItem(key: string) { return this.#items.get(String(key)) ?? null; }
  key(index: number) { return [...this.#items.keys()][index] ?? null; }
  removeItem(key: string) { this.#items.delete(String(key)); }
  setItem(key: string, value: string) { this.#items.set(String(key), String(value)); }
}

/** Separate memory stores, as a browser keeps them; returns the local one. */
function installMemoryStorage(): Storage {
  const local = new MemoryStorage();
  Object.defineProperty(window, "localStorage", { value: local, configurable: true });
  Object.defineProperty(window, "sessionStorage", { value: new MemoryStorage(), configurable: true });
  return local;
}

/**
 * The embedding window when it can talk to us: a same-origin parent. A
 * cross-origin parent cannot pass the origin check on its messages, so waiting
 * for its `init` would only delay the built-in fixtures.
 */
function sameOriginParent(): Window | null {
  if (window.parent === window) return null;
  try {
    return window.parent.location.origin === location.origin ? window.parent : null;
  } catch {
    return null; // cross-origin access throws
  }
}

/** Wait for the embedding page's `init`; null when it does not answer. */
function receiveInit(host: Window, origin: string): Promise<DemoInit | null> {
  return new Promise((resolve) => {
    const finish = (init: DemoInit | null) => {
      window.removeEventListener("message", onMessage);
      clearTimeout(timer);
      resolve(init);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== host || event.origin !== origin) return;
      const message = parseHostMessage(event.data);
      if (message?.type === "init") finish(message.init);
    };
    window.addEventListener("message", onMessage);
    const timer = setTimeout(() => {
      console.warn("[site-demo] no init from the host page; serving the built-in fixtures");
      finish(null);
    }, HANDSHAKE_TIMEOUT_MS);
    host.postMessage(appMessage("hello", {}), origin);
  });
}

function seed(storage: Storage, plan: DemoBootPlan): void {
  storage.clear();
  for (const [key, value] of Object.entries(plan.storage)) storage.setItem(key, value);
  const launchWindow = window as Window & { __LAUNCH_DATA__?: unknown };
  if (plan.launch) launchWindow.__LAUNCH_DATA__ = { ...plan.launch };
  else delete launchWindow.__LAUNCH_DATA__;
}

/** A hostname for the prompt: the title's first words, at most 20 characters, never cut mid-word. */
function hostSlug(title: string): string {
  const words = title.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  let host = "";
  for (const word of words) {
    const next = host ? `${host}-${word}` : word;
    if (next.length > 20) break;
    host = next;
  }
  return host || words[0]?.slice(0, 20) || "demo";
}

export async function bootSiteDemo(): Promise<void> {
  // Release builds strip this module; the marker lets `check:bundle` prove it.
  document.documentElement.dataset.siteDemo = "";
  const storage = installMemoryStorage();
  const host = sameOriginParent();
  const origin = location.origin;
  const init = host ? await receiveInit(host, origin) : null;

  // Nothing a host sends may blank the app: the plan is total, and if
  // installing it still fails, the built-in fixtures serve and the host is told why.
  let plan = planDemoBoot(init, { now: Date.now(), pageUrl: document.referrer || location.href });
  seed(storage, plan);
  // Importing the mock backend can load stores that read the seed (settings),
  // so a failed install keeps those and drops only what pointed into the world.
  const [{ installMockWorld }, { getMockHomeDirectory }] = await Promise.all([
    import("$lib/api/mock-world"),
    import("$lib/api/mock-system"),
  ]);
  let installed: ReturnType<typeof installMockWorld> | null = null;
  try {
    if (plan.world) installed = installMockWorld(plan.world);
  } catch (error) {
    plan = withoutDemoWorld(plan, `The fixture could not be installed: ${error instanceof Error ? error.message : String(error)}`);
    seed(storage, plan);
  }
  const { installDemoTerminal } = await import("./site-demo-terminal");
  const report: DemoBootReport = plan.report;
  if (report.error) console.error("[site-demo]", report.error);
  if (report.warnings.length) console.warn("[site-demo] fixture warnings:", report.warnings);

  const world = installed ? plan.world : null;
  const identity = world
    ? { user: world.user.id, host: hostSlug(world.title), home: world.user.home }
    : { user: "demo", host: "tauri-explorer", home: getMockHomeDirectory() };
  installDemoTerminal(() => identity);

  if (host) {
    // Not awaited: the bridge waits for the app's own readiness before `ready`.
    void import("./site-demo-bridge.svelte").then(({ startSiteDemoBridge }) =>
      startSiteDemoBridge({ host, origin, media: installed?.media ?? null, boot: report }));
  }
}

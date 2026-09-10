import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { basename } from "$lib/domain/path";
import { jobsStore } from "$lib/state/jobs.svelte";
import { toastStore } from "$lib/state/toast.svelte";
import { windowTabsManager } from "$lib/state/window-tabs.svelte";

export type PluginJobKind = "upscale" | "nano-banana";

type Outcome =
  | { status: "completed"; outputPath: string }
  | { status: "error"; error: string };

interface JobRegistration {
  kind: PluginJobKind;
  id: number;
  label: string;
  detail: string;
}

type StartResult = { ok: true; data: number } | { ok: false; error: string };

interface Dependencies {
  listen<T>(name: string, handler: (payload: T) => void): Promise<UnlistenFn>;
  add(registration: JobRegistration): void;
  complete(id: number, outputPath: string): void;
  fail(id: number, error: string): void;
  success(message: string): void;
  error(message: string): void;
  refresh(): Promise<void>;
}

const keyOf = (kind: PluginJobKind, id: number) => `${kind}:${id}`;

export function createPluginJobsController(deps: Dependencies) {
  const owned = new Map<string, JobRegistration>();
  const pending = new Map<string, Outcome>();
  const settled = new Set<string>();
  type Session = { starting: Promise<void>; unlisteners: UnlistenFn[] };
  let current: Session | null = null;
  let closing: Session | null = null;
  let disposing: Promise<void> | null = null;
  let closed = false;
  const accepting = new Set<Promise<void>>();

  const retainBounded = <T>(collection: Map<string, T> | Set<string>, limit: number) => {
    while (collection.size > limit) {
      const oldest = collection.keys().next().value;
      if (oldest === undefined) return;
      collection.delete(oldest);
    }
  };

  const publish = (kind: PluginJobKind, id: number, outcome: Outcome) => {
    const key = keyOf(kind, id);
    if (settled.has(key)) return;
    const registration = owned.get(key);
    if (!registration) {
      if (!pending.has(key)) pending.set(key, outcome);
      retainBounded(pending, 128);
      return;
    }
    owned.delete(key);
    settled.add(key);
    retainBounded(settled, 1024);
    if (outcome.status === "completed") {
      deps.complete(id, outcome.outputPath);
      const action = kind === "upscale" ? "Upscale" : "Nano Banana";
      deps.success(`${action} complete: ${basename(outcome.outputPath)}`);
      void deps.refresh().catch((error) => console.error("[plugin-jobs] refresh failed:", error));
    } else {
      deps.fail(id, outcome.error);
      const action = kind === "upscale" ? "Upscale" : "Nano Banana";
      deps.error(`${action} failed: ${outcome.error.slice(0, 100)}`);
    }
  };

  const addListeners = async (session: Session) => {
    const results = await Promise.allSettled([
      deps.listen<{ jobId: number; outputPath: string }>("upscale-complete", (payload) =>
        current === session && publish("upscale", payload.jobId, { status: "completed", outputPath: payload.outputPath }),
      ),
      deps.listen<{ jobId: number; error: string }>("upscale-error", (payload) =>
        current === session && publish("upscale", payload.jobId, { status: "error", error: payload.error }),
      ),
      deps.listen<{ jobId: number; outputPath: string }>("nano-banana-complete", (payload) =>
        current === session && publish("nano-banana", payload.jobId, { status: "completed", outputPath: payload.outputPath }),
      ),
      deps.listen<{ jobId: number; error: string }>("nano-banana-error", (payload) =>
        current === session && publish("nano-banana", payload.jobId, { status: "error", error: payload.error }),
      ),
    ]);
    const acquired = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    const rejected = results.find((result) => result.status === "rejected");
    if (current !== session || rejected) acquired.forEach((unlisten) => unlisten());
    else session.unlisteners = acquired;
    if (current !== session) throw new Error("Plugin jobs controller disposed");
    if (rejected?.status === "rejected") throw rejected.reason;
  };

  const ensureSession = (): Session => {
    if (current) return current;
    const session: Session = { starting: Promise.resolve(), unlisteners: [] };
    current = session;
    session.starting = addListeners(session).catch((error) => {
      if (current === session) current = null;
      console.error("[plugin-jobs] failed to listen:", error);
      throw error;
    });
    return session;
  };

  const init = (): Promise<void> => {
    if (closed) return Promise.reject(new Error("Plugin jobs controller disposed"));
    return disposing ? disposing.then(() => init()) : ensureSession().starting;
  };

  const register = (registration: JobRegistration): void => {
    const key = keyOf(registration.kind, registration.id);
    if (settled.has(key) || owned.has(key)) return;
    owned.set(key, registration);
    deps.add(registration);
    const outcome = pending.get(key);
    if (outcome) {
      pending.delete(key);
      publish(registration.kind, registration.id, outcome);
    }
  };

  return {
    init,
    register,
    async accept(
      registration: Omit<JobRegistration, "id">,
      start: () => Promise<StartResult>,
    ): Promise<StartResult> {
      // Listener ownership precedes the backend invocation, so even a job
      // that completes before the command response is buffered and joined.
      try {
        await init();
        const session = current;
        if (!session || closing === session) throw new Error("Plugin jobs controller disposed");
        let release!: () => void;
        const pendingStart = new Promise<void>((resolve) => { release = resolve; });
        accepting.add(pendingStart);
        try {
          const result = await start();
          if (current === session && result.ok) register({ ...registration, id: result.data });
          return result;
        } finally {
          accepting.delete(pendingStart);
          release();
        }
      } catch (error) {
        return { ok: false, error: `Failed to monitor plugin job: ${String(error)}` };
      }
    },
    async dispose(): Promise<void> {
      if (disposing) return disposing;
      const session = current;
      closed = true;
      if (!session) return;
      closing = session;
      let task!: Promise<void>;
      task = (async () => {
        await Promise.allSettled([...accepting]);
        if (current === session) current = null;
        try {
          await session.starting;
        } catch {
          // Acquisition failure/staleness already released every listener.
        }
        const acquired = session.unlisteners;
        session.unlisteners = [];
        acquired.forEach((unlisten) => unlisten());
        owned.clear();
        pending.clear();
        settled.clear();
        if (closing === session) closing = null;
        if (disposing === task) disposing = null;
      })();
      disposing = task;
      return task;
    },
  };
}

export const pluginJobsController = createPluginJobsController({
  listen: <T>(name: string, handler: (payload: T) => void) =>
    listen<T>(name, (event) => handler(event.payload)),
  add: ({ id, label, detail, kind }) => jobsStore.addJob(id, label, detail, kind),
  complete: (id, outputPath) => jobsStore.completeJob(id, outputPath),
  fail: (id, error) => jobsStore.failJob(id, error),
  success: (message) => toastStore.show(message, "success"),
  error: (message) => toastStore.error(message),
  refresh: async () => {
    await Promise.all(windowTabsManager.getAllExplorers().map((explorer) => explorer.refresh({ silent: true })));
  },
});

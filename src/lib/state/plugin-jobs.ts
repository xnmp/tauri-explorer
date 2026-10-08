import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { basename } from "$lib/domain/path";
import { jobsStore, type JobRetry } from "$lib/state/jobs.svelte";
import { toastStore } from "$lib/state/toast.svelte";
import { windowTabsManager } from "$lib/state/window-tabs.svelte";

const JOB_LABELS = { upscale: "Upscale", "nano-banana": "Nano Banana" } as const;
export type PluginJobKind = string;

type Outcome =
  | { status: "completed"; outputPath: string; warning?: string }
  | { status: "error"; error: string };

interface JobRegistration {
  kind: PluginJobKind;
  id: number;
  label: string;
  detail: string;
  presentation?: "image";
  /** Offered as Retry on the failed entry (capability "jobRetry"). */
  retry?: JobRetry;
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
  type Session = { starting: Promise<void>; kinds: Map<string,Promise<void>>; unlisteners: UnlistenFn[] };
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
      const action = JOB_LABELS[kind as keyof typeof JOB_LABELS] ?? registration.label;
      deps.success(`${action} complete: ${basename(outcome.outputPath)}${outcome.warning ? `. ${outcome.warning}` : ""}`);
      void deps.refresh().catch((error) => console.error("[plugin-jobs] refresh failed:", error));
    } else {
      deps.fail(id, outcome.error);
      const action = JOB_LABELS[kind as keyof typeof JOB_LABELS] ?? registration.label;
      deps.error(`${action} failed: ${outcome.error.slice(0, 100)}`);
    }
  };

  const addListeners = (session: Session, kind: string): Promise<void> => {
    const existing=session.kinds.get(kind);
    if(existing)return existing;
    if(!/^[a-z0-9-]{1,99}$/.test(kind))return Promise.reject(new Error("Invalid plugin job kind"));
    const acquisition=(async()=>{
      const results=await Promise.allSettled([
        deps.listen<{jobId:number;outputPath:string;warning?:string}>(`${kind}-complete`,(payload)=>current===session&&publish(kind,payload.jobId,{status:"completed",outputPath:payload.outputPath,warning:payload.warning})),
        deps.listen<{jobId:number;error:string}>(`${kind}-error`,(payload)=>current===session&&publish(kind,payload.jobId,{status:"error",error:payload.error})),
      ]);
      const acquired=results.flatMap((result)=>result.status==="fulfilled"?[result.value]:[]);
      const rejected=results.find((result)=>result.status==="rejected");
      if(current!==session||rejected)acquired.forEach((unlisten)=>unlisten());else session.unlisteners.push(...acquired);
      if(current!==session)throw new Error("Plugin jobs controller disposed");
      if(rejected?.status==="rejected"){session.kinds.delete(kind);throw rejected.reason;}
    })();
    session.kinds.set(kind,acquisition);return acquisition;
  };

  const ensureSession = (): Session => {
    if (current) return current;
    const session: Session = { starting: Promise.resolve(), kinds: new Map(), unlisteners: [] };
    current = session;
    session.starting = Promise.allSettled(Object.keys(JOB_LABELS).map((kind)=>addListeners(session,kind))).then((results)=>{
      const failure=results.find((result)=>result.status==="rejected");
      if(failure?.status==="rejected")throw failure.reason;
    }).catch((error) => {
      session.unlisteners.splice(0).forEach((unlisten)=>unlisten());
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
        await addListeners(session,registration.kind);
        if(current!==session || closing===session)throw new Error("Plugin jobs controller disposed");
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
          await Promise.allSettled(session.kinds.values());
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

/** Where the window's plugin jobs are shown and announced; everything but the
 *  backend event source, so tests can drive the real store with fake events. */
export const windowJobSink: Omit<Dependencies, "listen"> = {
  add: ({ id, label, detail, kind, presentation, retry }) => jobsStore.addJob(id, label, detail, kind, presentation, retry),
  complete: (id, outputPath) => jobsStore.completeJob(id, outputPath),
  fail: (id, error) => jobsStore.failJob(id, error),
  success: (message) => toastStore.show(message, "success"),
  error: (message) => toastStore.error(message),
  refresh: async () => {
    await Promise.all(windowTabsManager.getAllExplorers().map((explorer) => explorer.refresh({ silent: true })));
  },
};

export const pluginJobsController = createPluginJobsController({
  listen: <T>(name: string, handler: (payload: T) => void) =>
    listen<T>(name, (event) => handler(event.payload)),
  ...windowJobSink,
});

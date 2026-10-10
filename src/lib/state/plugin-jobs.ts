import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { basename } from "$lib/domain/path";
import { jobsStore, type JobRetry } from "$lib/state/jobs.svelte";
import { toastStore } from "$lib/state/toast.svelte";
import { windowTabsManager } from "$lib/state/window-tabs.svelte";
import { createNativePluginJobsController } from "./native-plugin-jobs";
import { snapshotPluginJobs, watchPluginJobs, cancelPluginJob, dismissPluginJob, resumePluginJob } from "$lib/api/native-plugin-jobs";
import { isTauri } from "$lib/api/common";
import { nativeJobTerminal, type NativeJobRecord } from "$lib/domain/native-plugin-jobs";
import { installedPackages } from "$lib/plugins/installed";

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
  /** The plugin that accepted the job (set by its scoped `jobs`). */
  owner?: string;
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
  native?: { init(): Promise<void>; dispose(): void; has(kind: string, id: number): boolean };
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

  const actionOf = (registration: Pick<JobRegistration, "kind" | "label">) =>
    JOB_LABELS[registration.kind as keyof typeof JOB_LABELS] ?? registration.label;
  const announceFailure = (registration: Pick<JobRegistration, "kind" | "label">, error: string) =>
    deps.error(`${actionOf(registration)} failed: ${error.slice(0, 100)}`);

  // A retry that cannot start is announced like the job's own failure, even
  // when its entry was dismissed or torn down meanwhile.
  const announcingRetry = (registration: JobRegistration): JobRetry | undefined => {
    const retry = registration.retry;
    if (typeof retry !== "function") return undefined;
    return async () => {
      try {
        const result = await retry();
        if (result?.ok !== true && !deps.native?.has(registration.kind, registration.id)) announceFailure(registration, typeof result?.error === "string" && result.error ? result.error : "Retry failed");
        return result;
      } catch (error) {
        if (!deps.native?.has(registration.kind, registration.id)) announceFailure(registration, error instanceof Error ? error.message : String(error));
        throw error;
      }
    };
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
      deps.success(`${actionOf(registration)} complete: ${basename(outcome.outputPath)}${outcome.warning ? `. ${outcome.warning}` : ""}`);
      void deps.refresh().catch((error) => console.error("[plugin-jobs] refresh failed:", error));
    } else {
      deps.fail(id, outcome.error);
      announceFailure(registration, outcome.error);
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
    session.starting = Promise.allSettled([...Object.keys(JOB_LABELS).map((kind)=>addListeners(session,kind)), ...(deps.native ? [deps.native.init()] : [])]).then((results)=>{
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
    if (deps.native?.has(registration.kind, registration.id)) {
      deps.add({ ...registration, retry: announcingRetry(registration) });
      return;
    }
    if (settled.has(key) || owned.has(key)) return;
    // The entry holds the retry; the reconciliation map never needs it.
    const { retry: _retry, ...tracked } = registration;
    owned.set(key, tracked);
    deps.add({ ...tracked, retry: announcingRetry(registration) });
    const outcome = pending.get(key);
    if (outcome) {
      pending.delete(key);
      publish(registration.kind, registration.id, outcome);
    }
  };

  return {
    init,
    register,
    observeNative(records: readonly NativeJobRecord[]): void {
      for (const record of records) {
        const key = keyOf(record.kind, record.jobId);
        owned.delete(key); pending.delete(key);
        if (nativeJobTerminal(record.state)) settled.add(key);
      }
      retainBounded(settled, 1024);
    },
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
      deps.native?.dispose();
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
  add: ({ id, label, detail, kind, presentation, owner, retry }) => jobsStore.addJob(id, label, detail, kind, presentation, { owner, retry,
    nativeOwner: owner ? installedPackages().find((entry) => entry.manifest.contributions.includes(owner))?.manifest.id : undefined }),
  complete: (id, outputPath) => jobsStore.completeJob(id, outputPath),
  fail: (id, error) => jobsStore.failJob(id, error),
  success: (message) => toastStore.show(message, "success"),
  error: (message) => toastStore.error(message),
  refresh: async () => {
    await Promise.all(windowTabsManager.getAllExplorers().map((explorer) => explorer.refresh({ silent: true })));
  },
};

const nativeJobs = createNativePluginJobsController({
  watch: watchPluginJobs,
  snapshot: snapshotPluginJobs,
  apply: (records) => { jobsStore.applyNative(records); pluginJobsController.observeNative(records); },
  error: (message) => jobsStore.setMonitoringError(message),
  toast: (job) => {
    if (job.state === "completed") { toastStore.show(`${job.label} complete`, "success"); void windowJobSink.refresh().catch(() => {}); }
    else if (job.state === "error") toastStore.error(`${job.label} failed: ${(job.error ?? "Generation failed").slice(0,100)}`);
  },
});
jobsStore.configureNativeControls({
  refresh: () => nativeJobs.refresh(),
  cancel: async (key) => { await cancelPluginJob(key); await nativeJobs.refresh(); },
  dismiss: async (key) => { await dismissPluginJob(key); await nativeJobs.refresh(); },
  resume: async (key) => { await resumePluginJob(key); await nativeJobs.refresh(); },
});
export const pluginJobsController = createPluginJobsController({
  listen: <T>(name: string, handler: (payload: T) => void) =>
    listen<T>(name, (event) => handler(event.payload)),
  ...windowJobSink,
  native: { init: () => isTauri() ? nativeJobs.init() : Promise.resolve(), dispose: () => nativeJobs.dispose(), has: (kind,id) => nativeJobs.has(kind,id) },
});

type Accept = ReturnType<typeof createPluginJobsController>["accept"];

/**
 * One plugin's view of the window's jobs: its registrations record it as the
 * owner, and retiring it (plugin disable/uninstall) drops Retry from its
 * entries, so a retired plugin's code never runs from Background Operations.
 */
export function scopePluginJobs(
  owner: string,
  accept: Accept = (registration, start) => pluginJobsController.accept(registration, start),
  dropRetries: (owner: string) => void = (id) => jobsStore.dropRetries(id),
) {
  let retired = false;
  return {
    jobs: {
      async accept(registration: Omit<JobRegistration, "id" | "owner">, start: () => Promise<StartResult>): Promise<StartResult> {
        const result = await accept({ ...registration, owner, retry: retired ? undefined : registration.retry }, start);
        // Retired while the job was starting: its entry was added after the drop.
        if (retired) dropRetries(owner);
        return result;
      },
    },
    retire(): void {
      retired = true;
      dropRetries(owner);
    },
  };
}

import { isRecord, normalizeWarmActivation, type WarmActivatePayload } from "$lib/domain/window-input";
import { normalizeWindowHandoff, type WindowHandoff } from "./window-handoff";

type Stop = () => void | Promise<void>;

/** One parked webview's activation, independent of component mount lifetime. */
export function createWarmActivation(dependencies: {
  measure: boolean;
  acceptsActivation(): boolean;
  listen(handler: (payload: unknown) => Promise<void>): Promise<Stop>;
  register(): Promise<boolean>;
  refreshSettings(current: () => boolean): Promise<void>;
  navigate(payload: WarmActivatePayload): Promise<void>;
  prepare(payload: WarmActivatePayload, current: () => boolean): Promise<void>;
  show(): Promise<void>;
  focus(current: () => boolean): Promise<void>;
  commit(): Promise<boolean>;
  acknowledge(request: WindowHandoff): Promise<void>;
  retire(): Promise<void>;
  reject(request: WindowHandoff): Promise<void>;
  requestAddressBar(): void;
  shown(): void;
  reportError(error: unknown): void;
}) {
  let disposed = false;
  let started = false;
  let committed = false;
  let unlisten: Stop | undefined;
  const current = () => !disposed && dependencies.acceptsActivation();
  const release = (stop: Stop) => {
    try { void Promise.resolve(stop()).catch(dependencies.reportError); }
    catch (error) { dependencies.reportError(error); }
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (unlisten) release(unlisten);
    unlisten = undefined;
    if (!committed && !dependencies.measure) void dependencies.retire().catch(dependencies.reportError);
  };

  async function activate(raw: unknown): Promise<void> {
    if (started || !current()) return;
    const payload = normalizeWarmActivation(raw);
    const request = isRecord(raw) ? normalizeWindowHandoff(raw.handoff) : null;
    if (!payload || (!request && !dependencies.measure)) return;
    started = true;
    try {
      await dependencies.refreshSettings(current);
      if (!current()) return;
      // Observe rejection immediately while native geometry/reveal runs in
      // parallel. Otherwise a fast navigation failure becomes unhandled.
      const navigation = dependencies.navigate(payload).then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }));
      await dependencies.prepare(payload, current);
      if (!current()) return;
      const result = await navigation;
      if (!current()) return;
      if (!result.ok) throw result.error;
      await dependencies.show();
      if (!current()) return;
      dependencies.shown();
      if (!dependencies.measure && !await dependencies.commit()) throw new Error("Warm activation lease expired");
      if (!current()) return;
      await dependencies.focus(current);
      if (!current()) return;
      dependencies.requestAddressBar();
      if (request) await dependencies.acknowledge(request);
      committed = true;
    } catch (error) {
      if (!disposed) dependencies.reportError(error);
      if (request && !disposed) await dependencies.reject(request).catch(dependencies.reportError);
      dispose();
      // No success acknowledgement: the claimant retires this window and opens fresh.
    }
  }

  const ready = (async () => {
    try {
      const stop = await dependencies.listen(activate);
      if (disposed) { release(stop); return false; }
      unlisten = stop;
      if (!current()) { dispose(); return false; }
      if (!dependencies.measure && !await dependencies.register()) dispose();
      return current();
    } catch (error) {
      dispose();
      dependencies.reportError(error);
      return false;
    }
  })();
  return { ready, dispose, activate };
}

/** The window manager closes admission before native destruction can yield. */
export interface NativeCloseSource {
  destroy(): Promise<void>;
  onCloseRequested(handler: (event: { preventDefault(): void }) => void): Promise<() => void | Promise<void>>;
}

export function createWindowClose(dependencies: {
  source(): NativeCloseSource;
  begin(): (() => void) | null;
  save(): void;
  reportError(error: unknown): void;
}) {
  let disposed = false;
  let closing: Promise<boolean> | null = null;
  let stopObservation: (() => void) | undefined;

  function request(): Promise<boolean> {
    if (disposed) return Promise.resolve(false);
    if (closing) return closing;
    const recover = dependencies.begin();
    if (!recover) return Promise.resolve(false);
    closing = (async () => {
      // Install the single-flight promise before even synchronous failures can
      // recover admission. Admission itself was revoked synchronously above.
      await Promise.resolve();
      if (disposed) return false;
      try {
        dependencies.save();
        await dependencies.source().destroy();
        return true;
      } catch (error) {
        if (!disposed) recover();
        closing = null;
        dependencies.reportError(error);
        return false;
      }
    })();
    return closing;
  }

  function observe(): () => void {
    stopObservation?.();
    if (disposed) return () => {};
    let retired = false;
    let unlisten: (() => void | Promise<void>) | undefined;
    const release = (stop: () => void | Promise<void>) => {
      try { void Promise.resolve(stop()).catch(dependencies.reportError); }
      catch (error) { dependencies.reportError(error); }
    };
    const stop = () => {
      if (retired) return;
      retired = true;
      if (stopObservation === stop) stopObservation = undefined;
      if (unlisten) release(unlisten);
      unlisten = undefined;
    };
    stopObservation = stop;
    void (async () => {
      try {
        const acquired = await dependencies.source().onCloseRequested((event) => {
          // Tauri otherwise destroys automatically after this callback, even
          // when a queued callback belongs to a retired subscription.
          event.preventDefault();
          if (!retired && !disposed) void request();
        });
        if (retired) release(acquired);
        else unlisten = acquired;
      } catch (error) {
        if (!retired) dependencies.reportError(error);
      }
    })();
    return stop;
  }

  return {
    request,
    observe,
    dispose(): void {
      disposed = true;
      stopObservation?.();
    },
  };
}

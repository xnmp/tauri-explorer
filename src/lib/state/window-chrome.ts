/** Native window chrome observation, independent of component lifetime. */
export interface WindowChromeSource {
  isMaximized(): Promise<boolean>;
  onResized(callback: () => void): Promise<() => void | Promise<void>>;
}

export function observeWindowChrome(
  source: WindowChromeSource,
  publish: (maximized: boolean) => void,
  reportError: (error: unknown) => void = (error) => console.error("Window chrome observation failed", error),
): () => void {
  let disposed = false;
  let revision = 0;
  let reading = false;
  let unlisten: (() => void | Promise<void>) | undefined;

  function stopListening(stop: () => void | Promise<void>): void {
    try { void Promise.resolve(stop()).catch(reportError); }
    catch (error) { reportError(error); }
  }

  async function read(): Promise<void> {
    if (disposed) return;
    revision++;
    if (reading) return;
    reading = true;
    try {
      while (!disposed) {
        const requested = revision;
        try {
          const maximized = await source.isMaximized();
          if (!disposed && requested === revision) publish(maximized);
        } catch (error) {
          if (!disposed) reportError(error);
        }
        if (requested === revision) break;
      }
    } finally {
      reading = false;
    }
  }
  const refresh = () => { void read(); };

  void (async () => {
    try {
      // Observe before the first read, so a resize during that read invalidates it.
      const stop = await source.onResized(refresh);
      if (disposed) { stopListening(stop); return; }
      unlisten = stop;
    } catch (error) {
      if (!disposed) reportError(error);
    }
    refresh();
  })();

  return () => {
    if (disposed) return;
    disposed = true;
    if (unlisten) stopListening(unlisten);
    unlisten = undefined;
  };
}

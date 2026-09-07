/** Native E2E only: coordinate real mutations while a real listing is held. */
interface Receipt {
  path: string;
  count: number;
  observedAt: number | null;
}

interface WriteAcknowledgement {
  filename: string;
  startedAt: number;
  receivedAt: number;
  observedAt: number;
  count: number;
}

export async function holdListingForWatcherWrites(options: {
  path: string;
  operation: string;
  signal: AbortSignal;
  write: (path: string, contents: string) => Promise<unknown>;
}): Promise<void> {
  const acknowledgements: WriteAcknowledgement[] = [];
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error("listing probe cancelled"));
  options.signal.addEventListener("abort", cancel, { once: true });
  if (options.signal.aborted) cancel();
  const timeout = setTimeout(() => {
    controller.abort(new Error("watcher writes were not acknowledged within 15 seconds"));
  }, 15_000);
  const publish = (status: string, error?: string) => {
    if (options.signal.aborted) return;
    document.documentElement.dataset.e2eWatcherWriteOperation = JSON.stringify({
      operation: options.operation, status, acknowledgements, error,
    });
  };
  publish("running");
  try {
    for (let index = 0; index < 3; index += 1) {
      controller.signal.throwIfAborted();
      const filename = `${options.operation}-${index}.txt`;
      const startedAt = Date.now();
      let removeListeners = () => {};
      let rejectAbort!: (reason: unknown) => void;
      const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
      const receipt = new Promise<Receipt & { receivedAt: number }>((resolve) => {
        const onReceipt = (event: Event) => {
          const value = (event as CustomEvent<Receipt>).detail;
          if (value.path === options.path && value.observedAt != null &&
              value.observedAt >= startedAt &&
              value.count > (acknowledgements.at(-1)?.count ?? 0)) resolve({ ...value, receivedAt: Date.now() });
        };
        const onAbort = () => rejectAbort(controller.signal.reason);
        window.addEventListener("e2e-directory-watcher-receipt", onReceipt);
        controller.signal.addEventListener("abort", onAbort, { once: true });
        removeListeners = () => {
          window.removeEventListener("e2e-directory-watcher-receipt", onReceipt);
          controller.signal.removeEventListener("abort", onAbort);
        };
      });
      try {
        // Subscribe before the actual IPC write. The abort race also bounds
        // a write whose receipt arrived before its IPC response stalled.
        const [, acknowledgement] = await Promise.race([Promise.all([
          options.write(`${options.path.replace(/[\\/]+$/, "")}/${filename}`, `${index}\n`),
          receipt,
        ]), aborted]);
        controller.signal.throwIfAborted();
        acknowledgements.push({
          filename, startedAt, receivedAt: acknowledgement.receivedAt,
          observedAt: acknowledgement.observedAt!, count: acknowledgement.count,
        });
        publish("running");
      } finally {
        removeListeners();
      }
    }
    publish("completed");
  } catch (error) {
    publish("failed", String(error));
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal.removeEventListener("abort", cancel);
  }
}

import { E2E_HOOKS_ENABLED } from "$lib/domain/e2e-hooks";
import { listen } from "@tauri-apps/api/event";

export interface DirectoryChange {
  path: string;
  observedAt?: number;
}

export interface DirectorySubscription {
  ready(): Promise<void>;
  stop(): void;
}

type Subscriber = {
  callback: (change: DirectoryChange) => void;
  stopped: boolean;
  lastReadyAttachment: Attachment | null;
};

type AttachmentOutcome =
  | { ok: true }
  | { ok: false; error: unknown };

type Attachment = {
  retired: boolean;
  status: "pending" | "ready" | "failed";
  outcome: Promise<AttachmentOutcome>;
  unlisten: (() => void) | null;
};

const STOPPED_ERROR = "Directory subscription has stopped";

function once(callback: () => void): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    callback();
  };
}

export function createDirectoryEvents(
  start: (dispatch: (change: DirectoryChange) => void) => Promise<() => void>,
): {
  subscribe(callback: (change: DirectoryChange) => void): DirectorySubscription;
} {
  const subscribers = new Set<Subscriber>();
  let current: Attachment | null = null;

  function retire(attachment: Attachment): void {
    if (attachment.retired) return;
    attachment.retired = true;
    if (current === attachment) current = null;
    attachment.unlisten?.();
    attachment.unlisten = null;
  }

  function dispatch(attachment: Attachment, change: DirectoryChange): void {
    if (
      attachment.retired
      || attachment.status === "failed"
      || current !== attachment
    ) return;

    const snapshot = [...subscribers];
    for (const subscriber of snapshot) {
      if (subscriber.stopped || !subscribers.has(subscriber)) continue;
      try {
        subscriber.callback(change);
      } catch (error) {
        console.error("Directory event subscriber failed", error);
      }
    }
  }

  function beginAttachment(): Attachment {
    const attachment: Attachment = {
      retired: false,
      status: "pending",
      outcome: Promise.resolve({ ok: true }),
      unlisten: null,
    };
    current = attachment;

    let started: Promise<() => void>;
    try {
      started = Promise.resolve(start((change) => dispatch(attachment, change)));
    } catch (error) {
      started = Promise.reject(error);
    }

    attachment.outcome = started.then<AttachmentOutcome, AttachmentOutcome>(
      (unlisten) => {
        const release = once(unlisten);
        if (
          attachment.retired
          || current !== attachment
          || subscribers.size === 0
        ) {
          release();
        } else {
          attachment.status = "ready";
          attachment.unlisten = release;
        }
        return { ok: true };
      },
      (error) => {
        attachment.status = "failed";
        return { ok: false, error };
      },
    );
    return attachment;
  }

  function ensureAttachment(): Attachment {
    return current ?? beginAttachment();
  }

  function subscribe(
    callback: (change: DirectoryChange) => void,
  ): DirectorySubscription {
    const subscriber: Subscriber = {
      callback,
      stopped: false,
      lastReadyAttachment: null,
    };
    subscribers.add(subscriber);
    ensureAttachment();

    return {
      ready(): Promise<void> {
        if (subscriber.stopped) return Promise.reject(new Error(STOPPED_ERROR));

        let attachment = ensureAttachment();
        if (
          attachment.status === "failed"
          && subscriber.lastReadyAttachment === attachment
        ) {
          retire(attachment);
          attachment = ensureAttachment();
        }
        subscriber.lastReadyAttachment = attachment;

        return attachment.outcome.then((outcome) => {
          if (subscriber.stopped) throw new Error(STOPPED_ERROR);
          if (!outcome.ok) throw outcome.error;
        });
      },
      stop(): void {
        if (subscriber.stopped) return;
        subscriber.stopped = true;
        subscribers.delete(subscriber);
        if (subscribers.size === 0 && current) retire(current);
      },
    };
  }

  return { subscribe };
}

interface NativeDirectoryChange {
  path: string;
  observed_at_ms?: number;
}

interface WatcherReceipt {
  count: number;
  observedAt: number | null;
}

const MAX_WATCHER_RECEIPTS = 256;
const watcherReceipts = new Map<string, WatcherReceipt>();

function publishWatcherListenerReady(): void {
  if (!E2E_HOOKS_ENABLED || typeof document === "undefined") return;
  document.documentElement.dataset.e2eDirectoryWatcherListenerReady = "true";
}

function publishWatcherReceipt(path: string, observedAt: number | undefined): void {
  if (!E2E_HOOKS_ENABLED || typeof document === "undefined") return;
  const previous = watcherReceipts.get(path);
  if (!previous && watcherReceipts.size >= MAX_WATCHER_RECEIPTS) {
    const oldest = watcherReceipts.keys().next().value;
    if (oldest !== undefined) watcherReceipts.delete(oldest);
  }
  watcherReceipts.set(path, {
    count: (previous?.count ?? 0) + 1,
    observedAt: observedAt ?? null,
  });
  document.documentElement.dataset.e2eDirectoryWatcherReceipts = JSON.stringify(
    Object.fromEntries(watcherReceipts),
  );
  window.dispatchEvent(new CustomEvent("e2e-directory-watcher-receipt", {
    detail: { path, ...watcherReceipts.get(path) },
  }));
}

const nativeDirectoryEvents = createDirectoryEvents((dispatch) =>
  listen<NativeDirectoryChange>("directory-changed", (event) => {
    const change: DirectoryChange = {
      path: event.payload.path,
      observedAt: event.payload.observed_at_ms,
    };
    publishWatcherReceipt(change.path, change.observedAt);
    dispatch(change);
  }),
);

export const directoryEvents: {
  subscribe(callback: (change: DirectoryChange) => void): DirectorySubscription;
} = {
  subscribe(callback) {
    const subscription = nativeDirectoryEvents.subscribe(callback);
    return {
      ready: async () => {
        await subscription.ready();
        publishWatcherListenerReady();
      },
      stop: () => subscription.stop(),
    };
  },
};

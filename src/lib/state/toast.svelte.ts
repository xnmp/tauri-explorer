/**
 * Toast notification store.
 * Issue: tauri-89kx
 *
 * Centralized toast state so components don't manage their own
 * timers and visibility flags for temporary notifications.
 */

/**
 * `progress` is for work that is still running and whose outcome arrives as a
 * separate toast later. It exists as its own type because `show` replaces the
 * existing toast of the SAME type: an in-flight indicator sharing "info" with
 * ordinary chatter ("Refreshed", a copy finishing in another window via
 * `broadcast`) gets silently deleted mid-operation, leaving the user with no
 * sign the work is still happening (#596).
 */
export type ToastType = "info" | "success" | "error" | "clipboard" | "progress";

export interface Toast {
  id: number;
  message: string;
  type: ToastType;
  isCut?: boolean; // for clipboard toasts
  link?: { url: string; label: string };
}

const DEFAULT_DURATIONS: Record<ToastType, number> = {
  info: 3000,
  success: 1500,
  error: 3000,
  clipboard: 3000,
  // Retired explicitly when the work finishes; this is only the backstop for
  // an operation that never settles, so it outlasts a slow round-trip.
  progress: 30000,
};

const TOAST_CHANNEL = "explorer-toasts";
let nextId = 0;

function createToastStore() {
  let toasts = $state<Toast[]>([]);
  const timers = new Map<number, ReturnType<typeof setTimeout>>();

  let channel: BroadcastChannel | null = null;
  if (typeof BroadcastChannel !== "undefined") {
    channel = new BroadcastChannel(TOAST_CHANNEL);
    channel.onmessage = (event: MessageEvent<{ message: string; type: ToastType }>) => {
      show(event.data.message, event.data.type);
    };
  }

  function show(message: string, type: ToastType = "info", options?: { isCut?: boolean; duration?: number; link?: { url: string; label: string } }): number {
    const id = nextId++;
    const toast: Toast = { id, message, type, isCut: options?.isCut, link: options?.link };

    // Replace existing toast of the same type (only one clipboard toast at a time, etc.)
    toasts = [...toasts.filter((t) => t.type !== type), toast];

    const duration = options?.duration ?? DEFAULT_DURATIONS[type];
    const timer = setTimeout(() => dismiss(id), duration);
    timers.set(id, timer);

    return id;
  }

  function dismiss(id: number): void {
    const timer = timers.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.delete(id);
    }
    toasts = toasts.filter((t) => t.id !== id);
  }

  function clear(): void {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    toasts = [];
  }

  return {
    get toasts() {
      return toasts;
    },
    show,
    dismiss,
    clear,

    // Convenience methods
    success: (message: string) => show(message, "success"),
    error: (message: string) => show(message, "error"),
    clipboard: (message: string, isCut: boolean) => show(message, "clipboard", { isCut }),

    /** Show a toast in other windows via BroadcastChannel. */
    broadcast: (message: string, type: ToastType = "info") => {
      channel?.postMessage({ message, type });
    },
  };
}

export const toastStore = createToastStore();

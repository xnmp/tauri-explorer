/**
 * Toast notification store.
 * Issue: tauri-89kx
 *
 * Centralized toast state so components don't manage their own
 * timers and visibility flags for temporary notifications.
 */

export type ToastType = "info" | "success" | "error" | "clipboard";

export interface Toast {
  id: number;
  message: string;
  type: ToastType;
  isCut?: boolean; // for clipboard toasts
}

const DEFAULT_DURATIONS: Record<ToastType, number> = {
  info: 3000,
  success: 1500,
  error: 3000,
  clipboard: 3000,
};

let nextId = 0;

function createToastStore() {
  let toasts = $state<Toast[]>([]);
  const timers = new Map<number, ReturnType<typeof setTimeout>>();

  function show(message: string, type: ToastType = "info", options?: { isCut?: boolean; duration?: number }): number {
    const id = nextId++;
    const toast: Toast = { id, message, type, isCut: options?.isCut };

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
  };
}

export const toastStore = createToastStore();

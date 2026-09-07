// Browser-only probe of the actual Svelte effect adapter. A real effect root
// gives the loader the same parent lifetime as a mounted dialog host.
import { flushSync } from "svelte";
import { useLazyDialog } from "../lib/composables/use-lazy-dialog.svelte";

export async function retirePendingDialog(outcome: "resolve" | "reject") {
  let open = $state(false);
  let loads = 0;
  let rollbacks = 0;
  const notifications: string[] = [];
  let resolve!: (value: { default: string }) => void;
  let reject!: (reason: unknown) => void;
  const module = new Promise<{ default: string }>((res, rej) => { resolve = res; reject = rej; });
  let dialog!: ReturnType<typeof useLazyDialog<string>>;
  const destroy = $effect.root(() => {
    dialog = useLazyDialog({
      label: "Lifetime probe", isOpen: () => open,
      load: () => { loads++; return module; },
      onFailure: () => { rollbacks++; },
    }, (message) => { notifications.push(message); });
  });
  flushSync();
  const beforeOpen = loads;
  open = true;
  flushSync();
  await Promise.resolve();
  const afterOpen = loads;
  const pending = dialog.load(); // Observe the effect's existing load.
  destroy();
  if (outcome === "resolve") resolve({ default: "retired constructor" });
  else reject(new Error("retired import"));
  await pending;
  return { beforeOpen, afterOpen, component: dialog.component, rollbacks, notifications };
}

import { FILE_VIEW_ELIGIBILITY_WAIT_MS } from "$lib/domain/file-view-resolution";
import { fileViewRegistry } from "$lib/plugins/file-view-registry.svelte";

/** Owned by an Explorer, independently of pane mounts. Scope changes hold
 * synchronously, before effects run; eligibility updates never restart the
 * deadline. After any first paint (or timeout), a later pending answer cannot blank an already painted view. */
export function createFileViewPresentation(directory: () => string, preference: () => string | null | undefined) {
  const scope = $derived({ directory: directory(), preference: preference() });
  let expired = $state.raw<typeof scope | null>(null);
  let painted = $state.raw<typeof scope | null>(null);
  const resolution = $derived(fileViewRegistry.presentation(scope.preference, scope.directory,
    expired === scope || painted === scope ? FILE_VIEW_ELIGIBILITY_WAIT_MS : 0));

  const dispose = $effect.root(() => {
    $effect(() => {
      const current = scope;
      const timer = setTimeout(() => { expired = current; }, FILE_VIEW_ELIGIBILITY_WAIT_MS);
      return () => clearTimeout(timer);
    });
    $effect(() => {
      if (resolution.kind !== "hold") painted = scope;
    });
  });

  return { dispose, get resolution() { return resolution; } };
}

export type FileViewPresentation = ReturnType<typeof createFileViewPresentation>;

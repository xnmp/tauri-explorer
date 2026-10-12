import { extractError } from "$lib/api/common";
import type { PrAction, PrMutationResult } from "$lib/api/git-log";
import { directoryKey } from "$lib/domain/path";

/** Window-local ownership survives pane teardown; Rust serializes all windows. */
function createOwner() {
  let busy = $state(false);
  let error = $state<string | null>(null);
  let result = $state.raw<PrMutationResult | null>(null);
  let uncertain = $state(false);
  const subscribers = new Set<() => Promise<void>>();
  return {
    get busy() { return busy; },
    get error() { return error; },
    get result() { return result; },
    get uncertain() { return uncertain; },
    get retained() { return busy || uncertain || subscribers.size > 0; },
    subscribe(refresh: () => Promise<void>) {
      subscribers.add(refresh);
      return () => { subscribers.delete(refresh); };
    },
    clear() { if (!busy && !uncertain) { error = null; result = null; } },
    async run(request: PrAction, mutate: (request: PrAction) => Promise<string>, checkedRetry: boolean) {
      if (busy || (uncertain && !checkedRetry)) return;
      busy = true; error = null; result = null; uncertain = false;
      try {
        const output = await mutate(request);
        result = { action: request.action, output, prNumber: "prNumber" in request ? request.prNumber : undefined };
      } catch (failure) {
        error = extractError(failure);
        uncertain = typeof failure === "object" && failure !== null && "kind" in failure && failure.kind === "pr_mutation_uncertain";
      } finally {
        // Only live panes refresh; the native outcome belongs to the owner.
        await Promise.allSettled([...subscribers].map(refresh => refresh()));
        busy = false;
      }
    },
  };
}
const owners = new Map<string, ReturnType<typeof createOwner>>();
export function getPrMutationOwner(repoPath: string) {
  const key = directoryKey(repoPath);
  let owner = owners.get(key);
  if (!owner) {
    // Evict only idle, unobserved, certain outcomes. Pending and uncertain work
    // must survive a remount regardless of the cache's ordinary size budget.
    for (const [oldKey, oldOwner] of owners) {
      if (owners.size < 64) break;
      if (!oldOwner.retained) owners.delete(oldKey);
    }
    owner = createOwner(); owners.set(key, owner);
  }
  return owner;
}

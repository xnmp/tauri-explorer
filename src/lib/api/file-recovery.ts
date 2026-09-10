import { Channel } from "@tauri-apps/api/core";
import { invoke, isTauri } from "./common";
import { getNativeResourceSession } from "./native-resource-session";
import type { FileRecoveryPort, FileRecoverySnapshot } from "$lib/domain/file-recovery";

// The native protocol permits one latest subscription per renderer. Keep its
// monotonic token source and callback fence in the JS realm across module/HMR
// reloads; native session strings alone are not globally unique window IDs.
const subscriptionStateKey = Symbol.for("tauri-explorer.file-recovery-subscriptions");
interface SubscriptionState { next: bigint; current: string | null }
const realm = globalThis as typeof globalThis & { [subscriptionStateKey]?: SubscriptionState };
const subscriptions = realm[subscriptionStateKey] ??= { next: 0n, current: null };

function nextSubscription(): string {
  if (subscriptions.next >= 9223372036854775807n) throw new Error("Recovery subscription tokens exhausted");
  const token = (++subscriptions.next).toString();
  subscriptions.current = token;
  return token;
}

const empty = (): FileRecoverySnapshot => ({ revision: "0", items: [], error: null });

export const fileRecoveryPort: FileRecoveryPort = {
  async subscribe(receive) {
    if (!isTauri()) {
      receive(empty());
      return async () => {};
    }
    const subscriptionId = nextSubscription();
    const sessionId = await getNativeResourceSession();
    let active = true;
    const updates = new Channel<FileRecoverySnapshot>((snapshot) => {
      if (active && subscriptions.current === subscriptionId) receive(snapshot);
    });
    const release = async () => {
      active = false;
      if (subscriptions.current === subscriptionId) subscriptions.current = null;
      await invoke("file_recovery_unsubscribe", { sessionId, subscriptionId });
    };
    try {
      const snapshot = await invoke<FileRecoverySnapshot>("file_recovery_subscribe", { sessionId, subscriptionId, updates });
      if (active && subscriptions.current === subscriptionId) receive(snapshot);
      return release;
    } catch (error) {
      // A lost acknowledgement can leave the native registration alive. Seal
      // delivery now and release its exact token without delaying replacement.
      void release().catch((releaseError) => console.warn("Could not retire failed recovery subscription", releaseError));
      throw error;
    }
  },
  async list() {
    if (!isTauri()) return empty();
    const sessionId = await getNativeResourceSession();
    return invoke<FileRecoverySnapshot>("file_recovery_list", { sessionId });
  },
  async inspect(id) {
    const sessionId = await getNativeResourceSession();
    return invoke<FileRecoverySnapshot>("file_recovery_inspect", { sessionId, id });
  },
  async resolve(id, generation, choice) {
    const sessionId = await getNativeResourceSession();
    return invoke<FileRecoverySnapshot>("file_recovery_resolve", { sessionId, id, generation, choice });
  },
};

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

export const fileRecoveryPort: FileRecoveryPort = {
  async subscribe(receive) {
    const subscriptionId = nextSubscription();
    const sessionId = await getNativeResourceSession();
    let active = true;
    const deliver = (snapshot: FileRecoverySnapshot) => {
      if (active && subscriptions.current === subscriptionId) receive(snapshot);
    };
    // The browser fixture backend has no Channel implementation; it invokes the
    // callback directly, exactly as the native resource session does.
    const updates = isTauri() ? new Channel<FileRecoverySnapshot>(deliver) : deliver;
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
    const sessionId = await getNativeResourceSession();
    return invoke<FileRecoverySnapshot>("file_recovery_list", { sessionId });
  },
  async retireEligible() {
    const sessionId = await getNativeResourceSession();
    return invoke<FileRecoverySnapshot>("file_recovery_retire_eligible", { sessionId });
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

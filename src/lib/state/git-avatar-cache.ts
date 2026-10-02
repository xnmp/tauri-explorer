import { gitAuthorAvatar } from "$lib/api/git-avatar";

const MAX_ENTRIES = 256;
const MAX_ACTIVE = 4;

interface PendingRequest {
  key: string;
  email: string;
  gravatarEnabled: boolean;
  subscribers: number;
  started: boolean;
  promise: Promise<string | null>;
  resolve: (value: string | null) => void;
}

export interface GitAvatarRequest { promise: Promise<string | null>; cancel(): void; }

const resolved = new Map<string, string>();
const pending = new Map<string, PendingRequest>();
const queue: PendingRequest[] = [];
let active = 0;

/** Test seam for retained scheduler work; production callers use request handles. */
export function gitAvatarQueueSizeForTests(): number { return queue.length; }

function drain(): void {
  while (active < MAX_ACTIVE && queue.length > 0) {
    const request = queue.shift()!;
    if (request.subscribers === 0) continue;
    request.started = true;
    active += 1;
    void gitAuthorAvatar(request.email, request.gravatarEnabled)
      .catch(() => null)
      .then((value) => {
        if (value !== null && request.subscribers > 0) {
          if (resolved.size >= MAX_ENTRIES) resolved.delete(resolved.keys().next().value!);
          resolved.set(request.key, value);
        }
        request.resolve(value);
      })
      .finally(() => {
        active -= 1;
        if (pending.get(request.key) === request) pending.delete(request.key);
        drain();
      });
  }
}

/** Bounded, deduplicated request owned by its mounted row subscriber. */
export function requestGitAuthorAvatar(email: string, gravatarEnabled: boolean): GitAvatarRequest {
  const key = `${email.trim().toLocaleLowerCase("en-US")}\0${gravatarEnabled}`;
  const cached = resolved.get(key);
  if (cached) return { promise: Promise.resolve(cached), cancel() {} };

  let request = pending.get(key);
  if (request) request.subscribers += 1;
  else if (pending.size >= MAX_ENTRIES) return { promise: Promise.resolve(null), cancel() {} };
  else {
    let resolve!: (value: string | null) => void;
    const promise = new Promise<string | null>((done) => { resolve = done; });
    request = { key, email, gravatarEnabled, subscribers: 1, started: false, promise, resolve };
    pending.set(key, request);
    queue.push(request);
    drain();
  }

  let owned = true;
  return { promise: request.promise, cancel() {
    if (!owned) return;
    owned = false;
    request!.subscribers -= 1;
    if (request!.subscribers === 0 && !request!.started) {
      if (pending.get(key) === request) pending.delete(key);
      const queued = queue.indexOf(request!);
      if (queued >= 0) queue.splice(queued, 1);
      request!.resolve(null);
    }
  } };
}

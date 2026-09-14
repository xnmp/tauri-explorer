import { gitAuthorAvatar } from "$lib/api/git-avatar";

const MAX_ENTRIES = 256;
const resolved = new Map<string, string | null>();
const pending = new Map<string, Promise<string | null>>();

/** Process-owned bounded cache. Concurrent rows for an author share one lookup. */
export function getGitAuthorAvatar(email: string, gravatarEnabled: boolean): Promise<string | null> {
  const key = `${email.trim().toLocaleLowerCase("en-US")}\0${gravatarEnabled}`;
  if (resolved.has(key)) return Promise.resolve(resolved.get(key) ?? null);
  const existing = pending.get(key);
  if (existing) return existing;
  const request = gitAuthorAvatar(email, gravatarEnabled)
    .catch(() => null)
    .then((value) => {
      if (resolved.size >= MAX_ENTRIES) resolved.delete(resolved.keys().next().value!);
      // Native negative entries already carry a TTL. Keeping null forever in
      // this renderer would turn a transient outage into a session-long miss.
      if (value !== null) resolved.set(key, value);
      return value;
    })
    .finally(() => { if (pending.get(key) === request) pending.delete(key); });
  pending.set(key, request);
  return request;
}

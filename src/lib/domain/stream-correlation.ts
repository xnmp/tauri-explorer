/**
 * Correlating broadcast search-stream events with the run that started them
 * (#1581).
 *
 * Quick Open and content search stream their results as app events, which
 * Tauri delivers to every window. A run learns its own stream id only when its
 * start IPC returns, and the backend worker can emit before that. Until then
 * an event cannot be attributed: it may belong to another window's search, or
 * be the late batch of a search this window just cancelled. Adopting the first
 * event's id therefore lets a run lock onto someone else's stream.
 *
 * Unattributed events are held, keyed by stream id; when the run learns its
 * id it takes only that stream's events, in arrival order, and drops the rest.
 * Holding costs at most the start IPC's round trip: the backend registers the
 * stream id immediately before replying.
 */

/** Events received before their run knew its stream id, keyed by that id. */
export type HeldStreamEvents<E> = ReadonlyMap<number, readonly E[]>;

/**
 * How many events per stream are worth holding:
 * - `latest`: each event is a complete snapshot (Quick Open's ranked top
 *   rows), so only the newest one matters and the hold stays one event per
 *   stream however long the start IPC takes.
 * - `all`: events are increments (content-search batches) and every one is
 *   needed, in order.
 */
export type HeldStreamRetention = "latest" | "all";

export function noHeldStreamEvents<E>(): HeldStreamEvents<E> {
  return new Map();
}

/** Hold `event` until its run can tell whether the stream is its own. */
export function holdStreamEvent<E extends { readonly searchId: number }>(
  held: HeldStreamEvents<E>,
  event: E,
  retention: HeldStreamRetention,
): HeldStreamEvents<E> {
  const next = new Map(held);
  const earlier = retention === "all" ? (held.get(event.searchId) ?? []) : [];
  next.set(event.searchId, [...earlier, event]);
  return next;
}

/** The held events of the run's own stream `searchId`, in arrival order. */
export function heldEventsFor<E>(held: HeldStreamEvents<E>, searchId: number): readonly E[] {
  return held.get(searchId) ?? [];
}

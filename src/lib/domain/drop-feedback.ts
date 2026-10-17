/**
 * Whether a DOM `dragend` may retire the pane's drop feedback. Feedback only:
 * native Drop keeps its own captured provenance. A delayed dragend from an old
 * gesture must not clear a successor's hover, but an ordinary cancelled drag
 * always does, even when its native hover carried no session id.
 */
export interface DragEndContext {
  /** Session named by the ended drag (payload or captured source), if any. */
  readonly endedSession?: string;
  /** Session of the live in-app source, if any. */
  readonly liveSession?: string;
  /** Session that owns the current native hover, if any. */
  readonly hoverSession?: string;
  /** True while a native hover position is being tracked. */
  readonly hovering: boolean;
}

export function shouldRetireOnDragEnd({ endedSession, liveSession, hoverSession, hovering }: DragEndContext): boolean {
  // A newer in-app drag owns the feedback now.
  if (endedSession && liveSession && endedSession !== liveSession) return false;
  // A hover without a session belongs to no known in-app drag (e.g. external).
  // Only an ended drag that is positively not the live gesture is a stale echo.
  if (hovering && !hoverSession && endedSession && endedSession !== liveSession) return false;
  if (hoverSession && ((endedSession && endedSession !== hoverSession) || (!endedSession && liveSession !== hoverSession))) return false;
  return true;
}

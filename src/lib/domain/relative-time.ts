/**
 * Format an elapsed duration as a compact relative-time label.
 *
 * Negative durations (future clock skew) are clamped to the present. Weeks
 * remain visible through 7w; months use 30-day buckets until a full 365-day
 * year has elapsed.
 */
export function compactRelativeTime(elapsedMs: number): string {
  const elapsedSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (elapsedSeconds < 60) return "now";

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `${elapsedMinutes}m`;

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}h`;

  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 7) return `${elapsedDays}d`;

  const elapsedWeeks = Math.floor(elapsedDays / 7);
  if (elapsedWeeks < 8) return `${elapsedWeeks}w`;

  const elapsedMonths = Math.floor(elapsedDays / 30);
  const elapsedYears = Math.floor(elapsedDays / 365);
  if (elapsedYears < 1) return `${elapsedMonths}mo`;

  return `${elapsedYears}y`;
}

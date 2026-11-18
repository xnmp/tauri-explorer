/**
 * Scalar parsing for site-demo fixtures (the marketing site's fictional
 * filesystems, `screenshots/design/website-rehaul/overhaul/content/fs-*.js`).
 * Fixture authors write sizes and dates the way a person would ("5.3 MB",
 * "yesterday", "Oct 18, 11:20"); these turn them into the byte counts and
 * timestamps the app's listing contract carries. Pure and framework-free.
 */

const UNIT_BYTES: Record<string, number> = {
  b: 1, byte: 1, bytes: 1,
  k: 1024, kb: 1024, kib: 1024,
  m: 1024 ** 2, mb: 1024 ** 2, mib: 1024 ** 2,
  g: 1024 ** 3, gb: 1024 ** 3, gib: 1024 ** 3,
  t: 1024 ** 4, tb: 1024 ** 4, tib: 1024 ** 4,
};

/** Bytes for `2048`, `"2 KB"`, `"5.3 MB"`, `"38.2 GB"`; null when unreadable. */
export function parseFixtureSize(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
  if (typeof value !== "string") return null;
  const match = /^\s*(\d+(?:\.\d+)?)\s*([a-z]*)\s*$/i.exec(value);
  if (!match) return null;
  const unit = UNIT_BYTES[(match[2] || "b").toLowerCase()];
  if (unit === undefined) return null;
  const bytes = Math.round(Number(match[1]) * unit);
  return Number.isFinite(bytes) ? bytes : null;
}

/** UTF-8 byte length, the size a text file of this content has on disk. */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) { bytes += 4; i++; }
    else bytes += 3;
  }
  return bytes;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const RELATIVE_UNITS: Record<string, number> = {
  second: 1000, minute: MINUTE, min: MINUTE, hour: HOUR, day: DAY, week: 7 * DAY, month: 30 * DAY, year: 365 * DAY,
};

/**
 * Epoch milliseconds for a fixture date, or null when it cannot be read.
 * Accepts epoch numbers (seconds or milliseconds), ISO dates (a time without
 * an offset is the reader's wall-clock time, so a fiction's "07:04" displays
 * as 07:04 everywhere), "Oct 18, 11:20" / "Oct 11 2026, 07:04" (a missing
 * year is the most recent one not after `now`), and relative phrases such as
 * "2 hours ago", "yesterday" and "just now". A time outside the years
 * 1000–9999 is null too, so callers can always format the result.
 */
export function parseFixtureDate(value: unknown, now: number): number | null {
  return representable(readFixtureDate(value, now));
}

/** Years 1000–9999: every such time has an ordinary ISO string; anything else is unreadable. */
const MIN_TIME = Date.UTC(1000, 0, 1);
const MAX_TIME = Date.UTC(9999, 11, 31, 23, 59, 59, 999);
const representable = (time: number | null): number | null =>
  time !== null && Number.isFinite(time) && time >= MIN_TIME && time <= MAX_TIME ? time : null;

function readFixtureDate(value: unknown, now: number): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return null;
    return value < 1e11 ? value * 1000 : value;
  }
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  return parseIso(text) ?? parseMonthDay(text, now) ?? parseRelative(text.toLowerCase(), now);
}

function parseIso(text: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(text);
  if (!m) return null;
  if (m[7]) {
    const parsed = Date.parse(text.replace(" ", "T"));
    return Number.isNaN(parsed) ? null : parsed;
  }
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0));
  return validDate(date, Number(m[2]) - 1, Number(m[3]));
}

function parseMonthDay(text: string, now: number): number | null {
  const m = /^([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?(?:,?\s+(\d{1,2}):(\d{2}))?$/i.exec(text);
  if (!m) return null;
  const month = MONTHS.indexOf(m[1].toLowerCase());
  if (month < 0) return null;
  const day = Number(m[2]);
  const hour = Number(m[4] ?? 0);
  const minute = Number(m[5] ?? 0);
  if (hour > 23 || minute > 59) return null;
  const build = (year: number) => validDate(new Date(year, month, day, hour, minute), month, day);
  if (m[3]) return build(Number(m[3]));
  const thisYear = new Date(now).getFullYear();
  const candidate = build(thisYear);
  if (candidate === null) return null;
  return candidate > now ? build(thisYear - 1) : candidate;
}

function parseRelative(text: string, now: number): number | null {
  if (text === "just now" || text === "now" || text === "today") return now;
  if (text === "yesterday") return now - DAY;
  const m = /^(\d+|an?|one)\s+([a-z]+?)s?\s+ago$/.exec(text);
  if (!m) return null;
  const unit = RELATIVE_UNITS[m[2]];
  if (unit === undefined) return null;
  const count = /^\d+$/.test(m[1]) ? Number(m[1]) : 1;
  return now - count * unit;
}

/** Rejects rollovers such as Feb 31 becoming Mar 3. */
function validDate(date: Date, month: number, day: number): number | null {
  const time = date.getTime();
  if (Number.isNaN(time) || date.getMonth() !== month || date.getDate() !== day) return null;
  return time;
}

/** Seconds for "4:12" or "1:02:03"; null when unreadable. */
export function parseFixtureDuration(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== "string") return null;
  const m = /^\s*(?:(\d+):)?(\d{1,2}):(\d{2})\s*$/.exec(value);
  if (!m) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/** `{width, height}` for "2880x2880"; null when unreadable. */
export function parseFixturePixels(value: unknown): { width: number; height: number } | null {
  if (typeof value !== "string") return null;
  const m = /^\s*(\d{1,6})\s*[x×]\s*(\d{1,6})\s*$/i.exec(value);
  if (!m) return null;
  const width = Number(m[1]);
  const height = Number(m[2]);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** Resolve a page-relative media URL against the host's base; raw on failure. */
export function resolveFixtureUrl(src: string, base: string | undefined): string {
  if (!base) return src;
  try {
    return new URL(src, base).href;
  } catch {
    return src;
  }
}

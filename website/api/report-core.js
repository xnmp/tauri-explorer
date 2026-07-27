/** @typedef {{ scope: string, key: string, limit: number, windowMs: number }} LimitEntry */
/** @typedef {{ consume(entries: LimitEntry[], now?: number): Promise<string | undefined> }} RateLimitStore */
/** @typedef {{ title: string, body: string, kind: "bug" | "feature", contact: string, version: string, os: string, arch: string }} ValidReport */

const IP_LIMITS = [
  { scope: "burst", limit: 3, windowMs: 60_000 },
  { scope: "hour", limit: 10, windowMs: 60 * 60_000 },
];
const DAILY_LIMIT = { scope: "day", limit: 100, windowMs: 24 * 60 * 60_000 };

export class ReportError extends Error {
  /** @param {string} code @param {string} message @param {number} [status] */
  constructor(code, message, status = 400) {
    super(message);
    this.name = "ReportError";
    this.code = code;
    this.status = status;
  }
}

/** @param {unknown} input @param {string} field @param {number} max */
function requiredString(input, field, max) {
  if (typeof input !== "string") {
    throw new ReportError("malformed_input", `${field} is required`);
  }
  const value = input.trim();
  if (!value || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new ReportError("malformed_input", `${field} is invalid`);
  }
  return value;
}

/** @param {unknown} input @param {string} field @param {number} max */
function optionalString(input, field, max) {
  if (input == null || input === "") return "";
  if (typeof input !== "string") {
    throw new ReportError("malformed_input", `${field} is invalid`);
  }
  const value = input.trim();
  if (value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new ReportError("malformed_input", `${field} is invalid`);
  }
  return value;
}

/** @param {unknown} input @returns {ValidReport} */
export function validateReport(input) {
  if (!input || typeof input !== "object") {
    throw new ReportError("malformed_input", "A report is required");
  }
  const record = /** @type {Record<string, unknown>} */ (input);
  const title = requiredString(record.title, "title", 120);
  const body = requiredString(record.body, "body", 8000);
  if (/^(?:https?:\/\/|www\.)\S+$/iu.test(body)) {
    throw new ReportError("malformed_input", "Description cannot be only a link");
  }
  if (record.kind !== "bug" && record.kind !== "feature") {
    throw new ReportError("malformed_input", "kind must be bug or feature");
  }
  return {
    title: title.replace(/\s*\r?\n\s*/gu, " "),
    body,
    kind: record.kind,
    contact: optionalString(record.contact, "contact", 100),
    version: optionalString(record.version, "version", 100),
    os: optionalString(record.os, "os", 100),
    arch: optionalString(record.arch, "arch", 100),
  };
}

/** @param {ValidReport} report */
export function buildGitHubIssue(report) {
  return {
    title: report.title,
    body: report.body,
    labels: ["user-report", report.kind === "bug" ? "bug" : "enhancement"],
  };
}

/** @returns {RateLimitStore} */
export function createInMemoryRateLimitStore() {
  const counters = new Map();
  return {
    async consume(entries, now = Date.now()) {
      let blocked;
      for (const entry of entries) {
        const current = counters.get(entry.key);
        const counter =
          !current || current.expiresAt <= now
            ? { count: 0, expiresAt: now + entry.windowMs }
            : current;
        counter.count += 1;
        counters.set(entry.key, counter);
        if (counter.count > entry.limit) blocked ??= entry.scope;
      }
      return blocked;
    },
  };
}

/** @param {string} url @param {string} token @returns {RateLimitStore} */
export function createRestRateLimitStore(url, token) {
  const script = `
local blocked = ""
for i, key in ipairs(KEYS) do
  local count = redis.call("INCR", key)
  if count == 1 then redis.call("PEXPIRE", key, ARGV[(i - 1) * 2 + 2]) end
  if count > tonumber(ARGV[(i - 1) * 2 + 1]) and blocked == "" then blocked = ARGV[#KEYS * 2 + i] end
end
return blocked`;
  return {
    async consume(entries) {
      const keys = entries.map((entry) => entry.key);
      /** @type {(string | number)[]} */
      const args = [];
      for (const entry of entries) args.push(entry.limit, entry.windowMs);
      for (const entry of entries) args.push(entry.scope);
      const response = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(["EVAL", script, keys.length, ...keys, ...args]),
      });
      if (!response.ok) throw new ReportError("server_rejected", "Rate limit store unavailable", 503);
      const payload = await response.json();
      if (payload.error) throw new ReportError("server_rejected", "Rate limit store unavailable", 503);
      return payload.result || undefined;
    },
  };
}

/** @param {RateLimitStore} store @param {string} ipKey @param {number} [now] */
export async function enforceReportLimits(store, ipKey, now = Date.now()) {
  const day = new Date(now).toISOString().slice(0, 10);
  const ipEntries = IP_LIMITS.map((limit) => ({
    ...limit,
    key: `reports:${limit.scope}:${ipKey}`,
  }));
  const ipBlocked = await store.consume(ipEntries, now);
  if (ipBlocked) {
    throw new ReportError("rate_limited", "Too many reports; please try later", 429);
  }
  const globalBlocked = await store.consume([{
    ...DAILY_LIMIT,
    key: `reports:global:${day}`,
  }], now);
  if (globalBlocked) {
    throw new ReportError("daily_cap", "Reports are temporarily unavailable", 429);
  }
}

/** @param {unknown} input @param {string} ipKey @param {RateLimitStore} store @param {(issue: ReturnType<typeof buildGitHubIssue>) => Promise<{url: string, number: number}>} createIssue @param {number} [now] @returns {Promise<{accepted: true, honeypot: true} | {url: string, number: number}>} */
export async function processReport(input, ipKey, store, createIssue, now = Date.now()) {
  const website = input && typeof input === "object"
    ? /** @type {Record<string, unknown>} */ (input).website
    : undefined;
  if (typeof website === "string" && website.trim()) {
    return { accepted: true, honeypot: true };
  }
  const report = validateReport(input);
  await enforceReportLimits(store, ipKey, now);
  return createIssue(buildGitHubIssue(report));
}

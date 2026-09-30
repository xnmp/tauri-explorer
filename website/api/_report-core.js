/** @typedef {{ scope: string, key: string, limit: number, windowMs: number }} LimitEntry */
/** @typedef {{ consume(entries: LimitEntry[], now?: number): Promise<string | undefined> }} RateLimitStore */
/** @typedef {{ name: string, mediaType: "image/png" | "image/jpeg" | "image/gif", bytes: Uint8Array }} ValidAttachment */
/** @typedef {{ title: string, body: string, kind: "bug" | "feature", attachments: ValidAttachment[] }} ValidReport */
/** @typedef {{ upload(attachment: ValidAttachment): Promise<string>, remove(urls: string[]): Promise<void> }} AttachmentStore */

const IP_LIMITS = [
  { scope: "burst", limit: 3, windowMs: 60_000 },
  { scope: "hour", limit: 10, windowMs: 60 * 60_000 },
];
const DAILY_LIMIT = { scope: "day", limit: 100, windowMs: 24 * 60 * 60_000 };
/** Limits shared with the app's native boundary (`src-tauri/src/user_report.rs`).
 * Both sides assert them against `tests/contract/fixtures/report_relay.json`. */
export const REPORT_LIMITS = Object.freeze({
  maxAttachments: 3,
  maxAttachmentBytes: 2 * 1024 * 1024,
  maxAttachmentsBytes: 3 * 1024 * 1024,
  maxTitleUnits: 120,
  maxAttachmentNameUnits: 120,
  // The app appends contact and environment details to the description.
  maxRelayBodyUnits: 8500,
});

/** Error codes the app maps to its own error kinds. */
export const REPORT_ERROR_CODES = Object.freeze([
  "malformed_input",
  "rate_limited",
  "daily_cap",
  "server_rejected",
  "submission_uncertain",
]);

/** After GitHub's issue POST starts, a failure cannot prove the issue was not created. */
export function submissionUncertain() {
  return new ReportError(
    "submission_uncertain",
    "GitHub may have created the issue; check recent issues before retrying",
    503,
  );
}

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
function optionalMultilineString(input, field, max) {
  if (typeof input !== "string") {
    throw new ReportError("malformed_input", `${field} is invalid`);
  }
  const value = input.trim();
  if (value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new ReportError("malformed_input", `${field} is invalid`);
  }
  return value;
}

/** @param {string} mediaType @param {Uint8Array} bytes */
function hasImageMagic(mediaType, bytes) {
  /** @param {number[]} signature */
  const startsWith = (signature) =>
    signature.every((value, index) => bytes[index] === value);
  if (mediaType === "image/png") {
    return startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  }
  if (mediaType === "image/jpeg") return startsWith([0xff, 0xd8, 0xff]);
  if (mediaType === "image/gif") {
    return startsWith([0x47, 0x49, 0x46, 0x38, 0x37, 0x61])
      || startsWith([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
  }
  return false;
}

/** @param {unknown} input @returns {ValidAttachment[]} */
function validateAttachments(input) {
  if (input == null) return [];
  if (!Array.isArray(input) || input.length > REPORT_LIMITS.maxAttachments) {
    throw new ReportError("malformed_input", "Attach up to 3 images");
  }
  let total = 0;
  return input.map((value) => {
    if (!value || typeof value !== "object") {
      throw new ReportError("malformed_input", "Attachment is invalid");
    }
    const record = /** @type {Record<string, unknown>} */ (value);
    const name = requiredString(record.name, "attachment name", REPORT_LIMITS.maxAttachmentNameUnits);
    const mediaType = record.mediaType;
    if (!["image/png", "image/jpeg", "image/gif"].includes(
      /** @type {string} */ (mediaType),
    )) {
      throw new ReportError("malformed_input", "Attachment type is invalid");
    }
    if (typeof record.data !== "string"
      || record.data.length === 0
      || record.data.length % 4 !== 0
      || !/^[A-Za-z0-9+/]+={0,2}$/u.test(record.data)) {
      throw new ReportError("malformed_input", "Attachment data is invalid");
    }
    const buffer = Buffer.from(record.data, "base64");
    if (buffer.toString("base64") !== record.data
      || buffer.length === 0
      || buffer.length > REPORT_LIMITS.maxAttachmentBytes
      || !hasImageMagic(/** @type {string} */ (mediaType), buffer)) {
      throw new ReportError("malformed_input", "Attachment data is invalid");
    }
    total += buffer.length;
    if (total > REPORT_LIMITS.maxAttachmentsBytes) {
      throw new ReportError("malformed_input", "Attachments must total 3 MiB or less");
    }
    return {
      name,
      mediaType: /** @type {ValidAttachment["mediaType"]} */ (mediaType),
      bytes: new Uint8Array(buffer),
    };
  });
}

/** @param {unknown} input @returns {ValidReport} */
export function validateReport(input) {
  if (!input || typeof input !== "object") {
    throw new ReportError("malformed_input", "A report is required");
  }
  const record = /** @type {Record<string, unknown>} */ (input);
  const title = requiredString(record.title, "title", REPORT_LIMITS.maxTitleUnits);
  // The app appends contact and environment details to its description before
  // posting; its native tests keep that assembly within maxRelayBodyUnits.
  const body = optionalMultilineString(record.body, "body", REPORT_LIMITS.maxRelayBodyUnits);
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
    attachments: validateAttachments(record.attachments),
  };
}

/** @param {string} value */
function escapeMarkdownAlt(value) {
  return value.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
}

/** @typedef {{ name: string, url: string }} HostedAttachment */

/** @param {ValidReport} report @param {HostedAttachment[]} [hostedAttachments] */
export function buildGitHubIssue(report, hostedAttachments = []) {
  const attachments = hostedAttachments.length === 0
    ? ""
    : `${report.body ? "\n\n" : ""}## Attachments\n\n${hostedAttachments.map(({ name, url }) =>
      `![${escapeMarkdownAlt(name)}](${url})`
    ).join("\n\n")}`;
  return {
    title: report.title,
    body: `${report.body}${attachments}`,
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
      let payload;
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify(["EVAL", script, keys.length, ...keys, ...args]),
        });
        if (!response.ok) throw new Error("Rate limit store unavailable");
        payload = await response.json();
      } catch {
        throw new ReportError("server_rejected", "Rate limit store unavailable", 503);
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)
        || Object.hasOwn(payload, "error")
        || (payload.result !== "" && !entries.some((entry) => entry.scope === payload.result))) {
        throw new ReportError("server_rejected", "Rate limit store unavailable", 503);
      }
      return payload.result === "" ? undefined : payload.result;
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

/** @param {unknown} input @param {string} ipKey @param {RateLimitStore} store @param {(issue: ReturnType<typeof buildGitHubIssue>) => Promise<{url: string, number: number}>} createIssue @param {AttachmentStore} [attachmentStore] @param {number} [now] @returns {Promise<{accepted: true, honeypot: true} | {url: string, number: number}>} */
export async function processReport(
  input,
  ipKey,
  store,
  createIssue,
  attachmentStore,
  now = Date.now(),
) {
  const website = input && typeof input === "object"
    ? /** @type {Record<string, unknown>} */ (input).website
    : undefined;
  if (typeof website === "string" && website.trim()) {
    return { accepted: true, honeypot: true };
  }
  const report = validateReport(input);
  await enforceReportLimits(store, ipKey, now);
  if (report.attachments.length === 0) {
    return createIssue(buildGitHubIssue(report));
  }
  if (!attachmentStore) {
    throw new ReportError("server_rejected", "Image hosting is not configured", 503);
  }
  const hostedAttachments = [];
  let issueAttempted = false;
  try {
    for (const attachment of report.attachments) {
      hostedAttachments.push({
        name: attachment.name,
        url: await attachmentStore.upload(attachment),
      });
    }
    issueAttempted = true;
    return await createIssue(buildGitHubIssue(report, hostedAttachments));
  } catch (error) {
    // After the POST starts, a lost response cannot prove whether GitHub
    // created the issue. Keep its image links valid and stop automatic retry.
    const uncertain = issueAttempted && !(error instanceof ReportError && error.code === "server_rejected");
    if (!uncertain && hostedAttachments.length > 0) {
      const urls = hostedAttachments.map(({ url }) => url);
      try {
        await attachmentStore.remove(urls);
      } catch (cleanupError) {
        console.error("Failed to remove report attachment blobs", cleanupError);
      }
    }
    if (uncertain) {
      throw submissionUncertain();
    }
    throw error;
  }
}

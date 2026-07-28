import { createHash } from "node:crypto";
import { del, put } from "@vercel/blob";
import {
  ReportError,
  createInMemoryRateLimitStore,
  createRestRateLimitStore,
  processReport,
} from "./report-core.js";

/** @typedef {{status(code: number): HttpResponse, setHeader(name: string, value: string): HttpResponse, json(payload: unknown): HttpResponse, end(): HttpResponse}} HttpResponse */
/** @typedef {Record<string, string | string[] | undefined>} RequestHeaders */
const localStore = createInMemoryRateLimitStore();

/** @param {HttpResponse} response @param {number} status @param {unknown} payload */
function json(response, status, payload) {
  response.status(status).setHeader("Cache-Control", "no-store");
  response.json(payload);
}

function rateLimitStore() {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (url && token) return createRestRateLimitStore(url, token);
  if (!process.env.VERCEL) return localStore;
  throw new ReportError("server_rejected", "Report service is not configured", 503);
}

/** @param {{title: string, body: string, labels: string[]}} issue @returns {Promise<{url: string, number: number}>} */
async function createGitHubIssue(issue) {
  const token = process.env.GITHUB_ISSUE_TOKEN;
  if (!token) throw new ReportError("server_rejected", "Report service is not configured", 503);
  const response = await fetch("https://api.github.com/repos/xnmp/tauri-explorer/issues", {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "tauri-explorer-report-relay",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify(issue),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || typeof payload.html_url !== "string") {
    throw new ReportError("server_rejected", "GitHub rejected the report", 502);
  }
  return { url: payload.html_url, number: payload.number };
}

function attachmentStore() {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  return {
    /** @param {{name: string, mediaType: string, bytes: Uint8Array}} attachment */
    async upload(attachment) {
      if (!token) {
        throw new ReportError("server_rejected", "Image hosting is not configured", 503);
      }
      const safeName = attachment.name.replace(/[^A-Za-z0-9._-]+/gu, "-").slice(-80)
        || "screenshot";
      const blob = await put(`user-reports/${safeName}`, Buffer.from(attachment.bytes), {
        access: "public",
        addRandomSuffix: true,
        contentType: attachment.mediaType,
        token,
      });
      return blob.url;
    },
    /** @param {string[]} urls */
    async remove(urls) {
      if (token && urls.length > 0) await del(urls, { token });
    },
  };
}

/** @param {string | string[] | undefined} value */
function forwardedTail(value) {
  const combined = Array.isArray(value) ? value.join(",") : value;
  return combined?.split(",").map((part) => part.trim()).filter(Boolean).at(-1);
}

/** @param {RequestHeaders} headers @param {string} [remoteAddress] */
export function reporterIp(headers, remoteAddress) {
  return forwardedTail(headers["x-vercel-forwarded-for"])
    ?? forwardedTail(headers["x-forwarded-for"])
    ?? remoteAddress
    ?? "unknown";
}

/** @param {{method?: string, headers: RequestHeaders, socket?: {remoteAddress?: string}, body?: unknown}} request @param {HttpResponse} response */
export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return json(response, 405, { error: { code: "method_not_allowed", message: "POST required" } });
  }
  try {
    const ip = reporterIp(request.headers, request.socket?.remoteAddress);
    const ipKey = createHash("sha256").update(ip).digest("hex").slice(0, 24);
    const result = await processReport(
      request.body,
      ipKey,
      rateLimitStore(),
      createGitHubIssue,
      attachmentStore(),
    );
    if ("honeypot" in result) {
      response.status(204).setHeader("Cache-Control", "no-store").end();
      return;
    }
    return json(response, 200, result);
  } catch (error) {
    const typed = error instanceof ReportError
      ? error
      : new ReportError("server_rejected", "Unable to submit report", 500);
    return json(response, typed.status, { error: { code: typed.code, message: typed.message } });
  }
}

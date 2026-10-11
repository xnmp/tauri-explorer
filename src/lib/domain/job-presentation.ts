/** Shared wire validation and exact decimal display; no floating-point money. */
import type { JobCost, JobReveal } from "$lib/plugins/api";
import { isFileViewId } from "./file-view-id";

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, limit: number): value is string => typeof value === "string" && value.length > 0 && new TextEncoder().encode(value).length <= limit && !/\p{Cc}/u.test(value);
export function jobCost(value: unknown): JobCost | undefined {
  if (!object(value) || Object.keys(value).some(key => !["amount", "currency", "estimated", "source"].includes(key))) return;
  if (typeof value.amount !== "string" || !/^[0-9]+(?:\.[0-9]{1,6})?$/.test(value.amount)
    || typeof value.currency !== "string" || !/^[A-Z]{3}$/.test(value.currency) || typeof value.estimated !== "boolean"
    || typeof value.source !== "string" || !value.source || Array.from(value.source).length > 64 || /\p{Cc}/u.test(value.source)) return;
  return { amount: value.amount, currency: value.currency, estimated: value.estimated, source: value.source };
}
export function jobReveal(value: unknown): JobReveal | undefined {
  if (!object(value)) return;
  if (value.kind === "file" && Object.keys(value).every(key => ["kind", "path"].includes(key)) && text(value.path, 4096)) return { kind: "file", path: value.path };
  if (value.kind === "view" && Object.keys(value).every(key => ["kind", "viewId", "directory", "targetId"].includes(key))
    && typeof value.viewId === "string" && isFileViewId(value.viewId) && text(value.directory, 4096) && text(value.targetId, 128))
    return { kind: "view", viewId: value.viewId, directory: value.directory, targetId: value.targetId };
}
export function formatJobCost(value?: JobCost): string {
  const cost = jobCost(value);
  if (!cost) return "";
  const [whole, fraction = ""] = cost.amount.split(".");
  const micros = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  const prefix = cost.estimated ? "≈" : "";
  const currency = cost.currency === "USD" ? "US$" : `${cost.currency} `;
  if (micros > 0n && micros < 10_000n) return `${prefix}<${currency}0.01`;
  const cents = (micros + 5_000n) / 10_000n;
  return `${prefix}${currency}${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
}

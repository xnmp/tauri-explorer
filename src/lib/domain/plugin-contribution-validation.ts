/**
 * Validation for plugin file icons and Details columns (#1523). Pure, and
 * loaded only when a plugin first registers one, so the startup bundle
 * carries just the registries' read paths.
 */
import { MAX_ICON_SVG_BYTES, type FileIconContribution, type ResolvedFileIcon } from "./plugin-file-icon";
import { MAX_PROVIDER_COLUMNS, PLUGIN_COLUMN_SIZE, type DetailColumnSpec, type DetailRowValues, type PluginDetailColumn } from "./plugin-detail-columns";

const MAX_EXTENSIONS = 32;
/** Control and bidirectional-override characters: plugin text must not
 *  reorder what the host shows around it (e.g. spoof "exe" in a type name). */
const CONTROL = /[\p{Cc}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;
const EXTENSION = /^[a-z0-9][a-z0-9_+-]{0,15}$/;

/** Validates a contribution into its extensions and rendered icon; throws a
 *  message naming the first problem. */
export function normalizeFileIcon(input: FileIconContribution): { extensions: string[]; icon: ResolvedFileIcon } {
  const raw: unknown = input?.extensions;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_EXTENSIONS) {
    throw new Error(`File icon ${input?.id} needs 1-${MAX_EXTENSIONS} extensions`);
  }
  const extensions = [...new Set(raw.map((ext) => typeof ext === "string" ? ext.trim().replace(/^\./, "").toLowerCase() : ""))];
  const invalid = extensions.find((ext) => !EXTENSION.test(ext));
  if (invalid !== undefined) throw new Error(`File icon ${input.id} has an invalid extension "${invalid}"`);

  const svg = typeof input.svg === "string" ? input.svg.trim() : "";
  if (!/^<svg[\s>]/i.test(svg) || !/<\/svg>$/i.test(svg)) throw new Error(`File icon ${input.id} must be <svg> markup`);
  if (new TextEncoder().encode(svg).length > MAX_ICON_SVG_BYTES) {
    throw new Error(`File icon ${input.id} exceeds ${MAX_ICON_SVG_BYTES} bytes`);
  }
  // An <img> only renders SVG that declares its namespace.
  const markup = /\sxmlns=/.test(svg.slice(0, svg.indexOf(">"))) ? svg : svg.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');

  const typeName = typeof input.typeName === "string" ? input.typeName.replace(CONTROL, "").trim().slice(0, 64) : "";
  return {
    extensions,
    icon: { src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`, ...(typeName ? { typeName } : {}) },
  };
}

const KEY = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_VALUE_CHARS = 512;

const text = (value: unknown, max: number): string =>
  typeof value === "string" ? value.replace(CONTROL, " ").trim().slice(0, max) : "";

/** Validates a provider's column declarations; throws naming the first problem. */
export function normalizeDetailColumns(providerId: string, specs: unknown): PluginDetailColumn[] {
  if (!Array.isArray(specs) || specs.length === 0 || specs.length > MAX_PROVIDER_COLUMNS) {
    throw new Error(`Detail columns ${providerId} needs 1-${MAX_PROVIDER_COLUMNS} columns`);
  }
  const seen = new Set<string>();
  return specs.map((spec: Partial<DetailColumnSpec> | null) => {
    const key = spec?.key;
    if (typeof key !== "string" || !KEY.test(key) || seen.has(key)) {
      throw new Error(`Detail columns ${providerId} has an invalid or repeated key "${String(key)}"`);
    }
    seen.add(key);
    const label = text(spec?.label, 40);
    if (!label) throw new Error(`Detail column ${providerId}:${key} needs a label`);
    const width = typeof spec?.width === "number" && Number.isFinite(spec.width) ? spec.width : 120;
    return { id: `${providerId}:${key}`, key, label,
      width: Math.round(Math.min(PLUGIN_COLUMN_SIZE.max, Math.max(PLUGIN_COLUMN_SIZE.min, width))) };
  });
}

/** One loaded item, reduced to declared keys and bounded display text. */
export function normalizeDetailRowValues(value: unknown, keys: readonly string[]): DetailRowValues | null {
  if (typeof value !== "object" || value === null) return null;
  const { columns, lengthSeconds } = value as { columns?: unknown; lengthSeconds?: unknown };
  const source = typeof columns === "object" && columns !== null ? columns as Record<string, unknown> : {};
  const entries = keys.flatMap((key) => {
    const display = Object.hasOwn(source, key) ? text(source[key], MAX_VALUE_CHARS) : "";
    return display ? [[key, display] as const] : [];
  });
  const length = typeof lengthSeconds === "number" && Number.isFinite(lengthSeconds) && lengthSeconds >= 0 ? lengthSeconds : undefined;
  return { columns: Object.fromEntries(entries), ...(length === undefined ? {} : { lengthSeconds: length }) };
}

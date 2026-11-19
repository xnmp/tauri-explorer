// Triage metadata for relay issues (#1689): labels and crash signatures
// derived from what the app itself appended to the report body.
//
// The body is `description [+ contact]` followed by the app's environment
// block (`---` rule, then `- Label: value` lines; src-tauri/src/user_report.rs,
// environment.rs) and zero or more reporter-approved `<details>` diagnostic
// sections. The reporter's description precedes all of that, so only an
// environment block that is followed by nothing but app-shaped diagnostic
// sections counts: a block typed into the description is never trailing.
// Everything returned here comes from fixed vocabularies or digits; no
// reporter-controlled text is echoed into a label or title.

const ENV_ANCHOR = "\n---\n- Tauri Explorer: v";
const SECTION =
  /^\n\n<details><summary>(Crash report|Slow folder-load diagnostics)<\/summary>\n\n(`{3,})text\n([\s\S]*?)\n\2\n\n<\/details>/u;
const VERSION = /^v(\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[0-9A-Za-z.]{1,20})?)$/u;

/** @param {string} rest @returns {{ kind: string, text: string }[] | null} */
function parseSections(rest) {
  const sections = [];
  let remaining = rest;
  while (remaining !== "") {
    const match = SECTION.exec(remaining);
    if (!match) return null;
    sections.push({ kind: match[1], text: match[3] });
    remaining = remaining.slice(match[0].length);
  }
  return sections;
}

/**
 * Locate the app-appended environment block and diagnostic sections.
 * @param {string} source
 * @returns {{ fields: Map<string, string>, sections: { kind: string, text: string }[] } | null}
 */
export function parseAppBlock(source) {
  // The block opens the body when the reporter wrote nothing.
  const body = `\n${source}`;
  for (let from = body.length; from >= 0;) {
    const at = body.lastIndexOf(ENV_ANCHOR, from);
    if (at < 0) return null;
    from = at - 1;
    const lines = body.slice(at + "\n---\n".length).split("\n");
    const fields = new Map();
    let used = 0;
    for (const line of lines) {
      const match = /^- ([A-Za-z][A-Za-z ]{0,30}): (.*)$/u.exec(line);
      if (!match) break;
      if (!fields.has(match[1])) fields.set(match[1], match[2]);
      used += line.length + 1;
    }
    // The block ends at end-of-body or at the first diagnostic section (the
    // line break that closed the last block line was already counted).
    const rest = body.slice(at + "\n---\n".length + used);
    const sections = parseSections(rest === "" ? "" : `\n${rest}`);
    if (sections) return { fields, sections };
  }
  return null;
}

/** @param {string} os @returns {string | null} */
function osLabel(os) {
  if (!/\([A-Za-z0-9_]{1,16}\)$/u.test(os)) return null;
  if (/^windows\b/iu.test(os)) return "os:windows";
  if (/^macos\b/iu.test(os)) return "os:macos";
  return "os:linux";
}

/** Labels the relay may add beyond `user-report` and the kind label. @param {string} body @returns {string[]} */
export function environmentLabels(body) {
  const block = parseAppBlock(body);
  if (!block) return [];
  const labels = [];
  const os = block.fields.get("OS");
  const osName = os === undefined ? null : osLabel(os);
  if (osName) labels.push(osName);
  const session = (block.fields.get("Session") ?? "").split(",")[0].trim().toLowerCase();
  if (osName === "os:linux" && (session === "wayland" || session === "x11")) labels.push(session);
  const version = VERSION.exec(block.fields.get("Tauri Explorer") ?? "");
  if (version) labels.push(`v${version[1]}`);
  return labels;
}

/** FNV-1a, 32-bit. Stable and dependency-free; collisions only blur grouping. @param {string} text */
function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Reduce a panic `location:` value to `file.rs:line` — no directories, no column. @param {string} location */
function rustLocation(location) {
  const match = /([A-Za-z0-9_.-]{1,80}):(\d{1,7})(?::\d{1,7})?$/u.exec(location.trim());
  return match ? `${match[1]}:${match[2]}` : null;
}

/** Error type name and innermost named frame of a recorded webview error. @param {string} text */
function webviewShape(text) {
  const message = /^panic: ([A-Za-z]{1,40}Error)\b/mu.exec(text)?.[1] ?? "Error";
  const frame = /^\s*(?:at\s+)?([A-Za-z_$][\w$.]{0,60})(?:@| \()/mu.exec(
    text.slice(text.indexOf("backtrace:")),
  )?.[1] ?? "";
  return `webview:${message}:${frame}`;
}

/**
 * Short duplicate-spotting signature of the crash report in `body`, or null.
 * Rust panics hash the source file name and line; webview errors hash the
 * error type and innermost function name. Panic messages and directories are
 * never part of the input.
 * @param {string} body @returns {string | null}
 */
export function crashSignature(body) {
  const section = parseAppBlock(body)?.sections.find(({ kind }) => kind === "Crash report");
  if (!section || !/^tauri-explorer \S+ crash report\n/u.test(section.text)) return null;
  if (/^source: frontend \(webview\)$/mu.test(section.text)) return fnv1a(webviewShape(section.text));
  const location = /^location: (.+)$/mu.exec(section.text)?.[1];
  const normalized = location === undefined ? null : rustLocation(location);
  return normalized ? fnv1a(`rust:${normalized}`) : null;
}

/** @param {string} title @param {string} body */
export function titleWithSignature(title, body) {
  const signature = crashSignature(body);
  return signature ? `${title} [crash ${signature}]` : title;
}

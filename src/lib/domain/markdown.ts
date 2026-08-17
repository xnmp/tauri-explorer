/**
 * Safe markdown rendering for the preview pane.
 *
 * Pure module (no DOM/framework deps, Node-testable):
 * - raw HTML in the source is escaped and shown as text — markdown
 *   formatting only, so no sanitizer dependency is needed
 * - link URLs are allowlisted (no javascript:/data: schemes); images never
 *   render as <img> — remote ones become link placeholders (CSP img-src
 *   excludes https:, see the image renderer), local/other degrade to alt text
 * - fenced code blocks reuse the highlight.js setup from
 *   syntax-highlight.ts, so previews keep syntax highlighting
 */

import { Marked, type Tokens } from "marked";
import { isMap, isScalar, isSeq, parseDocument } from "yaml";
import { highlightLanguage } from "./syntax-highlight";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Allow http(s), mailto, anchors and relative paths; reject everything
 *  with another explicit scheme (javascript:, data:, vbscript:, ...). */
function safeUrl(href: string): string | null {
  const trimmed = href.trim();
  if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  return null;
}

const marked = new Marked({
  gfm: true,
  renderer: {
    code({ text, lang }: Tokens.Code): string {
      const language = (lang ?? "").split(/\s+/)[0] || undefined;
      return `<pre class="md-code"><code class="hljs">${highlightLanguage(text, language)}</code></pre>\n`;
    },
    html(token: Tokens.HTML | Tokens.Tag): string {
      return escapeHtml(token.text);
    },
    link(token: Tokens.Link): string {
      const inner = this.parser.parseInline(token.tokens);
      const url = safeUrl(token.href);
      if (url === null) return inner;
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : "";
      return `<a href="${escapeHtml(url)}"${title} target="_blank" rel="noopener noreferrer">${inner}</a>`;
    },
    image(token: Tokens.Image): string {
      const trimmed = token.href.trim();
      // Never emit a live <img>. The app CSP's img-src deliberately excludes
      // https: — that strictness is what blunts asset-protocol XSS
      // amplification, and allowing remote origins would open a zero-click
      // network beacon channel from merely previewing a markdown file. Under
      // that CSP a remote <img> renders as a broken image anyway, so show
      // remote images as an explicit link the user can choose to open.
      if (/^https?:/i.test(trimmed)) {
        const label = token.text.trim() || trimmed;
        const title = token.title ? ` title="${escapeHtml(token.title)}"` : "";
        return `<a class="md-image-placeholder" href="${escapeHtml(trimmed)}"${title} target="_blank" rel="noopener noreferrer">${escapeHtml(label)} (image)</a>`;
      }
      // Local paths can't resolve inside the webview and data:/other schemes
      // stay out entirely — degrade to the alt text.
      return `<span class="md-image-placeholder">${escapeHtml(token.text || token.href)}</span>`;
    },
  },
});

type FrontmatterProperty = {
  key: string;
  values: string[];
};

function extractFrontmatter(md: string): { properties: FrontmatterProperty[]; body: string } | null {
  // A frontmatter header belongs only at the very start of the document. This
  // avoids treating thematic breaks later in Markdown content as metadata.
  const match = md.match(/^(?:\uFEFF)?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match) return null;

  try {
    const document = parseDocument(match[1]);
    if (document.errors.length > 0 || !isMap(document.contents) || document.contents.items.length === 0) return null;

    const properties: FrontmatterProperty[] = [];
    for (const item of document.contents.items) {
      if (!isScalar(item.key) || typeof item.key.value !== "string" || item.value === null) return null;

      if (isScalar(item.value)) {
        properties.push({ key: item.key.value, values: [String(item.value.value ?? "")] });
      } else if (isSeq(item.value)) {
        const values: string[] = [];
        for (const value of item.value.items) {
          if (!isScalar(value)) return null;
          values.push(String(value.value ?? ""));
        }
        properties.push({
          key: item.key.value,
          values,
        });
      } else {
        // Nested YAML values do not have a compact properties-panel
        // representation. Leave the source to normal Markdown rendering.
        return null;
      }
    }

    return { properties, body: md.slice(match[0].length) };
  } catch {
    return null;
  }
}

function renderProperties(properties: FrontmatterProperty[]): string {
  const rows = properties
    .map(({ key, values }) => {
      const value = values.length > 1
        ? `<ul class="md-property-values">${values.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
        : escapeHtml(values[0]);
      const valueClass = values.length > 1 ? "" : ' class="md-property-value"';
      return `<div class="md-property"><dt class="md-property-key">${escapeHtml(key)}</dt><dd${valueClass}>${value}</dd></div>`;
    })
    .join("");
  return `<section class="md-properties" aria-label="Properties"><dl>${rows}</dl></section>`;
}

/** Render markdown to HTML safe for {@html} injection. */
export function renderMarkdown(md: string): string {
  const frontmatter = extractFrontmatter(md);
  const body = frontmatter?.body ?? md;
  const renderedBody = marked.parse(body, { async: false });
  return frontmatter ? `${renderProperties(frontmatter.properties)}${renderedBody}` : renderedBody;
}

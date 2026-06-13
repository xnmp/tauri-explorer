/**
 * Safe markdown rendering for the preview pane.
 *
 * Pure module (no DOM/framework deps, Node-testable):
 * - raw HTML in the source is escaped and shown as text — markdown
 *   formatting only, so no sanitizer dependency is needed
 * - link/image URLs are allowlisted (no javascript:/data: schemes)
 * - fenced code blocks reuse the highlight.js setup from
 *   syntax-highlight.ts, so previews keep syntax highlighting
 */

import { Marked, type Tokens } from "marked";
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
      // Remote images only; local paths can't resolve inside the webview
      // and data:/other schemes stay out entirely.
      if (!/^https?:/i.test(trimmed)) {
        return `<span class="md-image-placeholder">${escapeHtml(token.text || token.href)}</span>`;
      }
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : "";
      return `<img src="${escapeHtml(trimmed)}" alt="${escapeHtml(token.text)}"${title} loading="lazy" />`;
    },
  },
});

/** Render markdown to HTML safe for {@html} injection. */
export function renderMarkdown(md: string): string {
  return marked.parse(md, { async: false });
}

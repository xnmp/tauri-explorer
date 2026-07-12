/**
 * Safe markdown rendering (src/lib/domain/markdown.ts): markdown formatting
 * renders, fenced code keeps hljs highlighting, raw HTML and dangerous URLs
 * never reach the output as live markup.
 */

import { describe, it, expect } from "vitest";
import { renderMarkdown } from "../../src/lib/domain/markdown";

describe("renderMarkdown", () => {
  it("renders headings, emphasis and lists", () => {
    const html = renderMarkdown("# Title\n\nSome *emphasis* and **bold**.\n\n- one\n- two\n");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<em>emphasis</em>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toMatch(/<ul>[\s\S]*<li>one<\/li>[\s\S]*<li>two<\/li>[\s\S]*<\/ul>/);
  });

  it("highlights fenced code blocks with hljs", () => {
    const html = renderMarkdown('```ts\nconst x: number = 1;\n```\n');
    expect(html).toContain('<pre class="md-code"><code class="hljs">');
    // hljs emits token spans for known languages.
    expect(html).toContain('<span class="hljs-keyword">const</span>');
  });

  it("escapes fenced code with an unknown language", () => {
    const html = renderMarkdown('```nosuchlang\n<script>alert(1)</script>\n```\n');
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders GFM tables", () => {
    const html = renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |\n");
    expect(html).toContain("<table>");
    expect(html).toContain("<th>a</th>");
    expect(html).toContain("<td>2</td>");
  });

  it("escapes raw HTML blocks and inline tags", () => {
    const html = renderMarkdown('before\n\n<script>alert("xss")</script>\n\nafter <img src=x onerror=alert(1)> end\n');
    expect(html).not.toContain("<script>");
    // The img stays escaped text — no live element with an onerror handler.
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("keeps http(s) links, adds rel=noopener, drops javascript: links", () => {
    const html = renderMarkdown("[ok](https://example.com) [bad](javascript:alert(1))\n");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toContain("javascript:");
    // The dangerous link degrades to its text, which is still shown.
    expect(html).toContain("bad");
  });

  it("renders remote images as link placeholders, never as <img>", () => {
    // CSP img-src excludes https:, so an <img> would both break visually and
    // invite loosening the CSP (a remote-beacon channel). The image degrades
    // to a link the user can open deliberately.
    const html = renderMarkdown("![remote pic](https://example.com/a.png)\n");
    expect(html).not.toContain("<img");
    expect(html).toContain('href="https://example.com/a.png"');
    expect(html).toContain('class="md-image-placeholder"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("remote pic");
  });

  it("falls back to the URL as link text for remote images without alt text", () => {
    const html = renderMarkdown("![](https://example.com/pic.png)\n");
    expect(html).not.toContain("<img");
    expect(html).toContain(">https://example.com/pic.png (image)</a>");
  });

  it("replaces local/data images with their alt text", () => {
    const html = renderMarkdown("![local pic](./a.png)\n\n![evil](data:text/html,x)\n");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("data:text/html");
    expect(html).not.toContain('src="./a.png"');
    expect(html).toContain("local pic");
  });

  it("handles empty and malformed input without throwing", () => {
    expect(renderMarkdown("")).toBe("");
    expect(() => renderMarkdown("[unclosed(")).not.toThrow();
    expect(() => renderMarkdown("```\nunclosed fence")).not.toThrow();
    // Very large input still returns (no pathological blowup).
    const big = "word ".repeat(50_000);
    expect(renderMarkdown(big).length).toBeGreaterThan(0);
  });
});

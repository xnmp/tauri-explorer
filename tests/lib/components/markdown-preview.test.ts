import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../../../src/lib/domain/markdown";

describe("Markdown preview frontmatter", () => {
  it("renders frontmatter as labelled properties above the document body", () => {
    const html = renderMarkdown(`---
title: Release notes
published: true
tags: [tauri, explorer]
authors:
  - Alice
  - Bob
---

# August release
`);

    expect(html).toContain('<section class="md-properties" aria-label="Properties">');
    expect(html).toContain('<dt class="md-property-key">title</dt>');
    expect(html).toContain('<dd class="md-property-value">Release notes</dd>');
    expect(html).toContain('<dt class="md-property-key">published</dt>');
    expect(html).toContain('<dd class="md-property-value">true</dd>');
    expect(html).toMatch(/<dt class="md-property-key">tags<\/dt>[\s\S]*?<li>tauri<\/li>[\s\S]*?<li>explorer<\/li>/);
    expect(html).toMatch(/<dt class="md-property-key">authors<\/dt>[\s\S]*?<li>Alice<\/li>[\s\S]*?<li>Bob<\/li>/);
    expect(html).toContain("<h1>August release</h1>");
    expect(html).not.toContain("<hr>");
    expect(html).not.toContain("title: Release notes");
  });

  it("leaves ordinary Markdown unchanged when it has no frontmatter", () => {
    const html = renderMarkdown("# Notes\n\nRegular document body.\n");

    expect(html).not.toContain("md-properties");
    expect(html).toContain("<h1>Notes</h1>");
    expect(html).toContain("<p>Regular document body.</p>");
  });

  it("falls back to the Markdown body for empty or malformed frontmatter", () => {
    const empty = renderMarkdown("---\n---\n\n# Empty metadata\n");
    const malformed = renderMarkdown("---\ntitle: [unterminated\n---\n\n# Recoverable body\n");

    expect(empty).not.toContain("md-properties");
    expect(empty).toContain("<h1>Empty metadata</h1>");
    expect(malformed).not.toContain("md-properties");
    expect(malformed).toContain("<h1>Recoverable body</h1>");
  });

  it("renders an empty array property without crashing", () => {
    const html = renderMarkdown("---\ntags: []\n---\n\n# Untagged note\n");

    expect(html).toContain('<dt class="md-property-key">tags</dt>');
    expect(html).toContain('<dd><ul class="md-property-values"></ul></dd>');
    expect(html).toContain("<h1>Untagged note</h1>");
  });

  it("renders one-element YAML arrays as property value lists", () => {
    const html = renderMarkdown("---\ntags: [tauri]\n---\n\n# Tagged note\n");

    expect(html).toContain('<dd><ul class="md-property-values"><li>tauri</li></ul></dd>');
    expect(html).not.toContain('<dd class="md-property-value">tauri</dd>');
  });

  it("escapes hostile frontmatter keys and scalar or array values", () => {
    const html = renderMarkdown(`---
'<key>&"': '<img src=x onerror="alert(1)"> & value'
tags: ['<svg onload="alert(1)">', '"quoted" & value']
---

# Safe body
`);

    expect(html).toContain("&lt;key&gt;&amp;&quot;");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; value");
    expect(html).toContain("&lt;svg onload=&quot;alert(1)&quot;&gt;");
    expect(html).toContain("&quot;quoted&quot; &amp; value");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<svg");
    expect(html).not.toContain(' onerror="');
    expect(html).not.toContain(' onload="');
  });
});

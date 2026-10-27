import { describe, expect, it } from "vitest";
import { renderMarkdownWithMath, renderMarkdown } from "../../src/lib/domain/markdown";
import { MAX_TEX_LENGTH } from "../../src/lib/domain/markdown-math";

const render = renderMarkdownWithMath;
const katexCount = (html: string) => (html.match(/class="katex"/g) ?? []).length;

describe("Markdown math (#1393)", () => {
  it("typesets inline $…$ and \\(…\\) as non-display math", async () => {
    const html = await render("Euler $e^{i\\pi}$ and \\(a^2\\) done");
    expect(katexCount(html)).toBe(2);
    expect(html).not.toContain("katex-display");
    expect(html).toContain("Euler ");
    expect(html).toContain(" done");
    expect(html).not.toContain("$e^");
  });

  it("typesets display $$…$$ and \\[…\\] blocks, multi-line and single-line", async () => {
    const multi = await render("before\n\n$$\n\\frac{1}{3}\n$$\n\nafter");
    expect(multi).toContain("katex-display");
    expect(multi).toContain('class="md-math-block"');
    expect(multi).toContain("<p>before</p>");
    expect(multi).toContain("<p>after</p>");
    const bracket = await render("\\[\nx^2\n\\]\n");
    expect(bracket).toContain("katex-display");
    const single = await render("$$x^2$$\n");
    expect(single).toContain("katex-display");
    expect(single).not.toContain("$$");
  });

  it("exposes the TeX source as MathML annotation for accessibility", async () => {
    const html = await render("$\\alpha+\\beta$");
    expect(html).toContain("<math");
    expect(html).toContain("\\alpha+\\beta");
  });

  it("does not treat currency as math", async () => {
    const html = await render("It costs $5 and $10 in total, or $ 5 and 6 $.");
    expect(katexCount(html)).toBe(0);
    expect(html).toContain("$5 and $10");
  });

  it("keeps math inside code spans and fenced code literal", async () => {
    const html = await render("`$x^2$` and\n\n```\n$$ y $$\n$z$\n```\n\n    $$ w $$\n");
    expect(katexCount(html)).toBe(0);
    expect(html).toContain("$x^2$");
    expect(html).toContain("$$ y $$");
  });

  it("keeps escaped dollars literal", async () => {
    const html = await render("cost \\$5 and \\$6 here");
    expect(katexCount(html)).toBe(0);
    expect(html).toContain("$5 and $6");
  });

  it("renders malformed TeX as an error element without throwing", async () => {
    const html = await render("bad $\\frac{1$ then ok $x$");
    expect(html).toContain("katex-error");
    expect(katexCount(html)).toBeGreaterThanOrEqual(1);
    await expect(render("$\\undefinedmacro{$ $$\\begin{foo}$$")).resolves.toEqual(expect.any(String));
  });

  it("leaves empty math delimiters as literal text", async () => {
    const html = await render("a $$ $$ b\n\n$$\n$$\n");
    expect(katexCount(html)).toBe(0);
    expect(html).not.toContain("katex-error");
  });

  it("bounds pathological input", async () => {
    const huge = "x".repeat(MAX_TEX_LENGTH + 1);
    const oversized = await render(`$${huge}$`);
    expect(katexCount(oversized)).toBe(0);
    // Unbounded macro expansion is rejected by KaTeX rather than hanging.
    const bomb = await render("$\\def\\a{\\a\\a}\\a$");
    expect(bomb).toContain("katex-error");
    const manyDollars = "$a ".repeat(60_000);
    const started = Date.now();
    await render(manyDollars);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("does not let TeX inject markup", async () => {
    const html = await render("$\\href{javascript:alert(1)}{x}$ $\\htmlClass{a}{b}$ <script>alert(1)</script>");
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/href=|class="[^"]*\ba\b/);
  });

  it("keeps the synchronous renderer math-free and documents without math unchanged", async () => {
    expect(renderMarkdown("$x^2$")).not.toContain("katex");
    const plain = "# Title\n\nno formulas, just **text**\n";
    expect(await render(plain)).toBe(renderMarkdown(plain));
  });
});

describe("renderMarkdownBlocks (#1418)", () => {
  it("yields top-level blocks that join to the whole document", async () => {
    const { renderMarkdownBlocks } = await import("../../src/lib/domain/markdown");
    const doc = "---\ntitle: Notes\n---\n\n# Heading\n\nInline $e^{i\\pi}$ text.\n\n$$\n\\frac{1}{2}\n$$\n\n- one\n- two\n\n```ts\nconst x = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n[ref]: https://example.com\n\nSee [ref].\n";
    const blocks = [...(await renderMarkdownBlocks(doc)).blocks];
    expect(blocks.length).toBeGreaterThanOrEqual(7);
    expect(blocks.every((block) => block.length > 0)).toBe(true);
    expect(blocks[0]).toContain("md-properties");
    expect(blocks.join("")).toBe(await renderMarkdownWithMath(doc));
    expect(blocks.join("")).toContain('href="https://example.com"');
  });

  it("yields blocks in document order, typesetting math blocks", async () => {
    const { renderMarkdownBlocks } = await import("../../src/lib/domain/markdown");
    const iterator = (await renderMarkdownBlocks("# A\n\n$x$\n\n$y$\n")).blocks[Symbol.iterator]();
    expect(iterator.next().value).toContain("<h1>A</h1>");
    expect(iterator.next().value).toContain("katex");
  });
});

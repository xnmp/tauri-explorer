<!--
  PreviewTextDocument — the preview's reflowing text subjects: rendered
  markdown, highlighted code and plain text (#1039 fullscreen zooms these).
  Markdown/code HTML comes from domain/markdown + syntax-highlight, which
  emit escaped hljs/Marked output — safe {@html} sinks (#227).
-->
<script lang="ts">
  type TextDocument =
    | { readonly kind: "markdown" | "code"; readonly html: string }
    | { readonly kind: "text"; readonly text: string };

  interface Props {
    content: TextDocument;
    /** Active theme is light: picks the hljs palette class. */
    light: boolean;
  }

  const { content, light }: Props = $props();
</script>

{#if content.kind === "markdown"}
  <div class="preview-markdown" class:hljs-light={light} class:hljs-dark={!light}>{@html content.html}</div>
{:else if content.kind === "code"}
  <pre class="preview-text preview-code" class:hljs-light={light} class:hljs-dark={!light}><code class="hljs">{@html content.html}</code></pre>
{:else if content.kind === "text"}
  <pre class="preview-text">{content.text}</pre>
{/if}

<style>
  .preview-text {
    padding: 16px;
    font-family: "Cascadia Code", "Fira Code", "Consolas", monospace;
    font-size: var(--preview-font-size, 12px);
    line-height: 1.6;
    color: var(--text-secondary);
    white-space: pre-wrap;
    word-break: break-all;
    margin: 0;
    flex: 1;
  }

  .preview-code code {
    font-family: inherit;
  }

  .preview-code :global(.hljs) {
    background: transparent;
    padding: 0;
  }

  /* Rendered markdown (Obsidian-style). Content comes from {@html}, so
     descendants need :global. */
  .preview-markdown {
    padding: 16px;
    font-size: var(--preview-font-size, 12px);
    line-height: 1.65;
    color: var(--text-secondary);
    flex: 1;
    overflow-wrap: break-word;
    container: preview-markdown / inline-size;
  }

  .preview-markdown :global(h1),
  .preview-markdown :global(h2),
  .preview-markdown :global(h3),
  .preview-markdown :global(h4),
  .preview-markdown :global(h5),
  .preview-markdown :global(h6) {
    color: var(--accent-light);
    font-weight: 600;
    line-height: 1.3;
    margin: 14px 0 6px;
  }

  .preview-markdown :global(h1) { font-size: 1.416667em; padding-bottom: 4px; border-bottom: 1px solid var(--divider); }
  .preview-markdown :global(h2) { font-size: 1.25em; padding-bottom: 3px; border-bottom: 1px solid var(--divider); }
  .preview-markdown :global(h3) { font-size: 1.083333em; }
  .preview-markdown :global(h4) { font-size: 1em; }

  .preview-markdown :global(h1:first-child),
  .preview-markdown :global(h2:first-child),
  .preview-markdown :global(p:first-child) {
    margin-top: 0;
  }

  .preview-markdown :global(p) {
    margin: 6px 0;
  }

  .preview-markdown :global(.md-properties) {
    margin: 0 0 14px;
    padding: 8px 10px;
    border: 1px solid var(--divider);
    border-radius: var(--radius-sm);
    background: var(--subtle-fill-secondary);
  }

  .preview-markdown :global(.md-properties dl) {
    margin: 0;
  }

  .preview-markdown :global(.md-property) {
    display: grid;
    grid-template-columns: minmax(76px, 0.38fr) minmax(0, 1fr);
    gap: 8px;
    padding: 3px 0;
  }

  /* In a narrow pane the key column would squeeze each value to a few
     characters per line; stack the key above its value instead (#792).
     Side by side needs the properties box's 22px of padding and border, the
     76px key column, the 8px gap and a 96px value: 202px. */
  @container preview-markdown (width < 202px) {
    .preview-markdown :global(.md-property) {
      grid-template-columns: minmax(0, 1fr);
      gap: 0;
    }
  }

  .preview-markdown :global(.md-property + .md-property) {
    border-top: 1px solid var(--divider);
  }

  .preview-markdown :global(.md-property-key) {
    color: var(--text-tertiary);
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .preview-markdown :global(.md-property dd) {
    min-width: 0;
    margin: 0;
    color: var(--text-primary);
    overflow-wrap: anywhere;
  }

  .preview-markdown :global(.md-property-values) {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .preview-markdown :global(.md-property-values li) {
    margin: 0;
    padding: 1px 5px;
    border-radius: 999px;
    background: var(--subtle-fill-tertiary, var(--subtle-fill-secondary));
  }

  .preview-markdown :global(a) {
    color: var(--accent-text, var(--accent));
    text-decoration: none;
  }

  .preview-markdown :global(a:hover) {
    text-decoration: underline;
  }

  .preview-markdown :global(code) {
    font-family: "Cascadia Code", "Fira Code", "Consolas", monospace;
    font-size: 1em;
    background: var(--subtle-fill-secondary);
    padding: 1px 4px;
    border-radius: 3px;
  }

  .preview-markdown :global(pre.md-code) {
    background: var(--subtle-fill-secondary);
    border: 1px solid var(--divider);
    border-radius: var(--radius-sm);
    padding: 10px 12px;
    margin: 8px 0;
    overflow-x: auto;
  }

  .preview-markdown :global(pre.md-code code) {
    background: transparent;
    padding: 0;
    white-space: pre;
  }

  .preview-markdown :global(blockquote) {
    margin: 8px 0;
    padding: 2px 12px;
    border-left: 3px solid var(--accent);
    color: var(--text-tertiary);
  }

  .preview-markdown :global(ul),
  .preview-markdown :global(ol) {
    margin: 6px 0;
    padding-left: 22px;
  }

  .preview-markdown :global(li) {
    margin: 2px 0;
  }

  .preview-markdown :global(li input[type="checkbox"]) {
    margin-right: 6px;
  }

  .preview-markdown :global(hr) {
    border: none;
    border-top: 1px solid var(--divider);
    margin: 12px 0;
  }

  .preview-markdown :global(table) {
    border-collapse: collapse;
    margin: 8px 0;
    font-size: inherit;
    display: block;
    overflow-x: auto;
  }

  .preview-markdown :global(th),
  .preview-markdown :global(td) {
    border: 1px solid var(--divider);
    padding: 4px 8px;
    text-align: left;
  }

  .preview-markdown :global(th) {
    background: var(--subtle-fill-secondary);
    color: var(--text-primary);
    font-weight: 600;
  }

  /* Markdown never emits <img> (CSP img-src excludes https:, see
     domain/markdown.ts) — images degrade to this placeholder, a link for
     remote URLs or plain alt text otherwise. */
  .preview-markdown :global(.md-image-placeholder) {
    color: var(--text-tertiary);
    font-style: italic;
  }

  /* hljs token colors are shared app-wide in themes/syntax.css (#246);
     the .hljs-dark/.hljs-light scheme class lives on <html>. */
</style>

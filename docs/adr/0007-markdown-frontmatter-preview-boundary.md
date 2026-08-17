# ADR 0007: Markdown frontmatter preview boundary

Status: Accepted

Governs: `src/lib/domain/markdown.ts`, `src/lib/components/PreviewPane.svelte`

## Context

Markdown previews insert renderer output through Svelte's `{@html}`. Markdown
source and YAML frontmatter both come from files selected by the user and are
therefore untrusted content. Frontmatter needs a compact properties-panel
presentation without extending that HTML trust boundary.

## Decision

- Recognize frontmatter only when a `---`-delimited header appears at the start
  of the document.
- Render a properties panel only for a non-empty YAML mapping whose keys are
  scalar strings and whose values are scalar values or sequences of scalar
  values. Preserve scalar versus sequence origin so even a one-item sequence
  renders as a list.
- Escape every rendered key and scalar or sequence value before constructing
  the properties-panel HTML. YAML values never become HTML, attributes, URLs,
  or event handlers.
- Empty, malformed, or unsupported nested frontmatter falls back to ordinary
  Markdown rendering and never creates a partial properties panel.

## Consequences

- Frontmatter display supports the common properties shapes while deliberately
  excluding nested YAML structures until they have an explicitly safe UI.
- Tests for this path must cover scalar and one-item sequence rendering plus
  hostile keys and values at the HTML output seam.

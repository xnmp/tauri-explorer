# Markdown preview theme colours

Markdown preview content is inserted with `{@html}`, so styles for its rendered
headings and links need Svelte's `:global(...)` selector. Verify colour changes
at the browser seam with computed styles, resolving CSS variables through an
element, rather than comparing unresolved custom-property strings.

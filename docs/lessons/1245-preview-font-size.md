# Markdown descendants must follow the preview font setting (#1245)

Markdown paragraphs and standalone code already shared `--preview-font-size`, but markdown inline/fenced code and tables hardcoded 11px, and headings hardcoded their own pixel ramp. At an 18px preview setting, the same code was 18px standalone and 11px inside a markdown document.

Markdown code and tables now inherit the configured base size. The existing heading hierarchy uses relative sizes, preserving the default proportions while scaling with the setting. Descendant selectors remain `:global(...)` because markdown is inserted using `{@html}`; heading/link theme colours remain unchanged.

The browser regression failed pre-fix on computed 11px inline code versus the requested 18px. It now checks prose, highlighted standalone/fenced code, inline code and tables at 18px, plus a heading larger than body text. Existing heading/link colour tests also pass.

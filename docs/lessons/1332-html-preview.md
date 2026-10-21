# HTML preview needs a document boundary

HTML previously followed the highlighted source path. Dispatch `.html` and
`.htm` to an HTML content variant, retaining the 512 KiB asynchronous read cap
and existing generation guard. Do not apply the source preview's 200-line cap:
it can remove closing tags or meaningful content at the end of a document.

Render with an empty-sandbox `srcdoc` iframe rather than `{@html}`. This denies
scripts and same-origin access to Explorer/IPC; a CSP preceding file content
blocks remote subresources while permitting inline styles and data images.
Self-contained static documents are supported; external styles/scripts and
relative assets are intentionally outside this preview's scope.

Browser regression tests assert actual headings and computed style inside the
opaque-origin frame, literal non-HTML source, and selection/navigation during a
held HTML read. State tests cover bounded transport and stale completion.

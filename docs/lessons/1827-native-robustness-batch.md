# #1827 native robustness batch (from #1597, #1638)

- Small JSON `ureq` calls (update manifest, GitHub PR lookups) use
  `http_timeouts::bounded_agent()` (10 s connect, 30 s overall). The report
  relay deliberately sets no timeouts (send-phase uncertainty classification),
  so leave it alone.
- Crash folder: `.seen` reports and `.claim` markers are pruned at startup by
  age (30 d) and count (50); an identity with an unseen `crash-N.txt` is never
  touched.
- `log_startup_timing` accepts at most 64 summaries per process, 2048 chars each.
- `routing_plugin` failure no longer panics startup; the process just is not
  single-instance.
- `json!` over a native `PathBuf` panics on non-UTF-8: send wire paths
  (`wire_path::encode_path`) to providers.
- `\` is a path separator only on Windows; do not `replace('\\', "/")` on Unix
  names (`git.rs::slash_separators`).
- The AI rename hint shows `displaySuggestionFor` (display text); the store
  still holds, and the model still sees, the wire form.

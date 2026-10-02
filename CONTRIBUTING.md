# Contributing

Thanks for your interest! Bug reports, feature requests, and pull requests are all welcome.

## Reporting bugs

The fastest route is from inside the app: **Command Palette → "Report Issue"**. The form includes your OS and app version when you submit it, and can include images you select. The resulting GitHub issue and images are public; local logs are not attached automatically. If in-app submission fails, the app saves your draft and opens GitHub's issue form when possible. You can also [open an issue directly](https://github.com/xnmp/tauri-explorer/issues/new/choose).

## Development setup

Requires [Rust](https://rustup.rs/), [Bun](https://bun.sh/), and the [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform.

```bash
bun install
bun run start       # full Tauri app (dev)
bun run dev         # frontend only, in a browser with mocked backend
bun run check       # type check
bun run test        # unit tests (vitest) + perf tests
bun run test:e2e    # browser E2E (Playwright against the mocked backend)
cd src-tauri && cargo test   # Rust tests
```

Before opening a PR, please make sure `bun run check`, `bun run test`, and `cargo fmt --check` + `cargo clippy --all-targets -- -D warnings` (run inside `src-tauri/`) pass — CI enforces all of them.

## Pull requests

- Development happens on the `dev` branch; `main` tracks releases. Target PRs at `dev`.
- Keep diffs small and focused; one concern per PR. This applies to release preparation too: a release-prep PR bumps versions and the changelog, and nothing else — do not bundle it with unrelated fixes or features.
- New business logic should come with unit tests; user-visible changes should update or add a Playwright spec asserting the actual outcome (not just that a component renders).
- The frontend has three view modes (Details, List, Tiles) — UI changes to file display need to work in all three (`ALL_VIEW_MODES=1 npx playwright test`).

## Diagnostic scaffolding: `Retire-when`

Code and tests added only to investigate an open issue — an extra sampler, a failure artifact, a negative-control spec — are temporary. Tag every such file (or block, if it lives inside a longer-lived file) with a line naming the issue that justifies it:

```ts
/**
 * Process-only evidence for native WebDriver session loss.
 *
 * Retire-when: #781 closed
 */
```

- Put native-suite scaffolding in `e2e-tauri/diagnostics/` and persist artifacts through its shared writer (`diagnostics/artifact.ts`), which names files without trusting caller strings and never lets a failed write replace the error being documented.
- When you close an issue, run `grep -rn "Retire-when: #NNN closed" .` for its number. Delete what it tags, or promote it: if a piece now guards a real product or harness contract, remove the tag and keep at most one regression test for that contract. Record what the investigation learnt in `docs/lessons/<issue>-<slug>.md`.
- If the scaffolding still serves another open issue, retag it with that issue rather than leaving the closed one.

## Architecture

Start at [docs/code-map/](docs/code-map/) — `map-feature.md` for how a feature threads through the layers, `map-folder.md` for a per-file index. The short version: `src/lib/domain/` is pure logic, `src/lib/state/` is Svelte 5 rune stores, `src/lib/api/` bridges to the Rust backend via Tauri IPC (with a browser mock for tests), and `src-tauri/src/` is the Rust side. All Tauri commands are `async fn`.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).

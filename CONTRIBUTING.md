# Contributing

Thanks for your interest! Bug reports, feature requests, and pull requests are all welcome.

## Reporting bugs

The fastest route is from inside the app: **Command Palette → "Report a Bug"** — it pre-fills a GitHub issue with your OS, app version, and a recent local log excerpt (nothing is sent automatically; you see everything before submitting). Otherwise, [open an issue](https://github.com/xnmp/tauri-explorer/issues/new/choose).

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
- Keep diffs small and focused; one concern per PR.
- New business logic should come with unit tests; user-visible changes should update or add a Playwright spec asserting the actual outcome (not just that a component renders).
- The frontend has three view modes (Details, List, Tiles) — UI changes to file display need to work in all three (`ALL_VIEW_MODES=1 npx playwright test`).

## Architecture

Start at [docs/code-map/](docs/code-map/) — `map-feature.md` for how a feature threads through the layers, `map-folder.md` for a per-file index. The short version: `src/lib/domain/` is pure logic, `src/lib/state/` is Svelte 5 rune stores, `src/lib/api/` bridges to the Rust backend via Tauri IPC (with a browser mock for tests), and `src-tauri/src/` is the Rust side. All Tauri commands are `async fn`.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).

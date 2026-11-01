# Dependabot npm/cargo updates failed every week (#1479)

- Dependabot's `npm` ecosystem refuses a repository whose only lockfile is
  `bun.lock` ("Bun is misconfigured"). Use `package-ecosystem: "bun"`.
- Dependabot copies only `Cargo.toml`/`Cargo.lock` files for path
  dependencies. A vendored crate with `links = ...` and an auto-detected
  `build.rs` then fails to parse ("links ... but does not have a custom build
  script"). Declare `build = "build.rs"` explicitly in any vendored manifest
  that uses `links`; `tests/repo-hygiene.test.ts` checks this.
- To reproduce, copy only the manifests into a temp dir (plus empty
  `src/lib.rs` stubs) and run `cargo update -p <crate> --dry-run`.

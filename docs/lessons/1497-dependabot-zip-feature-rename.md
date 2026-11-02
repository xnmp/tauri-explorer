# Dependabot renames zip's `bzip2` feature on a major bump (#1497)

Bumping `zip = { version = "2", features = [..., "bzip2", ...] }` to 9.x,
Dependabot's cargo updater rewrote the feature list as well as the version,
producing `bzip9`. Cargo then rejects the manifest, and the whole weekly cargo
job reports failure even though the other grouped crates updated.

`.github/dependabot.yml` ignores `zip` semver-major updates; a zip major
upgrade changes its archive API and is migrated by hand (update the version and
the features together). `tests/repo-hygiene.test.ts` guards the ignore rule.
Diagnose Dependabot failures from the `dynamic` workflow run logs: search for
`Handled error whilst updating`.

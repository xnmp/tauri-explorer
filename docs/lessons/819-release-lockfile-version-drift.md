# #819 — Release builds must keep the cross-platform Bun lockfile

The first v1.11.0 `main` release workflow on `a1fff931` failed in both Linux and macOS `Build Tauri app` steps. Its install step deleted `bun.lock` and regenerated dependencies from `package.json`. The `^2.10.1` range then resolved `@tauri-apps/api` to 2.12.0, while `src-tauri/Cargo.lock` retained Rust `tauri` 2.11.2. `cargo tauri build` rejected the minor-version mismatch before compiling. The [failed workflow](https://github.com/xnmp/tauri-explorer/actions/runs/36503381494) is the pre-fix reproduction; the failed run did not create a release tag.

The deletion assumed a Linux-generated lockfile omitted other platforms' optional binaries. The tracked text `bun.lock` actually records the platform-specific Tauri CLI packages for macOS, Windows and Linux. Bun selects the applicable optional package on each runner. Other platform workflows already install it with `bun install --frozen-lockfile`.

Release builds should retain that lockfile and use `bun install --frozen-lockfile`. This keeps the frontend Tauri API at the locked 2.11.0 minor version alongside Rust `tauri` 2.11.2, while allowing each runner to install its own optional binary. Do not delete the lockfile to repair an optional-package problem without first checking its platform entries and the installed package versions.

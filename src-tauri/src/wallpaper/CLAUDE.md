# Wallpaper platform checks

Modules enabled by `cfg(any(target_os = "macos", test))` also compile in Windows
library tests. A helper used only by macOS production code and Unix-only tests
is dead code on Windows under `clippy --all-targets -- -D warnings`. Validate
that target when reintroducing platform helpers; Linux tests alone missed
#1752. See `docs/lessons/1752-windows-wallpaper-lint.md`.

# 1179: Windows smoke failed on a Unix-only test module import

The Windows smoke job runs Clippy with all targets and warnings denied. The
child environment test used `/bin/sh`, so its test and helper were Unix-only,
but its `use super::*` still compiled on Windows. The helper-only fix in #1178
therefore exposed an unused-import error instead of restoring the workflow.

Gate the entire test module with `cfg(all(test, unix))`, keeping its test,
imports, and helper together. The Unix child-process environment assertion is
retained unchanged; no production behavior or lint policy changes.

`tests/child-env-compile.test.ts` imports the actual production module and
compiles its test configuration with warnings denied. Its PTY dependency is
replaced with `std::process::Command`, which supplies the same `env_remove`
method used by this module. The test defaults to the host target. For a
linker-free Windows reproduction from Linux, install the Windows Rust standard
library and run:

```sh
CHILD_ENV_TEST_TARGET=x86_64-pc-windows-msvc bunx vitest run tests/child-env-compile.test.ts
```

This fails on the original code with the exact unused import reported by CI.
The existing Windows smoke Clippy step remains the full-crate Windows check.

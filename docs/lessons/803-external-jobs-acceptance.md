# 803 — Qualify external-job timeout through the real worker and UI

The external-job ledger previously counted every unit test in `plugin_job`,
`fal` and `nano_banana` as acceptance evidence. Most of those tests cover input
validation. The default Rust suite now has one direct contract for each
lifecycle claim:

- `src-tauri/src/plugin_job.rs:246` holds a complete staging file, cancels its
  owner, and observes both absent publication and staging cleanup.
- `src-tauri/src/plugin_job.rs:265` races cancel against commit repeatedly and
  requires exactly one serialized winner.
- `src-tauri/src/plugin_job.rs:350` times out a real blocking worker, drains it,
  and observes no late output or staging residue before returning.
- `src-tauri/src/fal.rs:213` sends a real localhost HTTP request to a stalled
  peer through the production agent builder and observes its global bound.
- `src-tauri/src/nano_banana.rs:355` cancels the real child-process path on
  Unix and Windows and requires the child handle to report a waited process.
  Unix additionally requires `ESRCH` for the reaped PID.

`e2e-tauri/specs/external-job-timeout.spec.ts` puts a fake long-running
`gemini` executable first on the application process's `PATH`. It starts Nano
through the page-owned plugin-jobs controller, lets the production timeout
cancel and drain the child, then checks that the child PID is gone, the chosen
output was never published, and the Jobs panel reports `timed out`. The short
deadline override is available only in binaries built with the `e2e-hooks`
Cargo feature (#884; formerly debug builds with `VITE_E2E_HOOKS=1`); builds
without it never read the variable and retain ten minutes.

The issue plan described a user cancel action, but the product has no plugin-job
cancel command or Jobs-panel cancel control. This acceptance covers the existing
production timeout cancellation path. Adding explicit user cancellation needs a
separate product change with a backend job registry and UI ownership contract.

Local Linux evidence: the five focused Rust contracts pass, the Tauri debug
binary builds with embedded E2E hooks, and the native outcome passes with one
real fake CLI process. Linux, Windows and macOS default-suite CI evidence must
come from this branch's hosted runs; the native outcome is Linux-only because
the fake executable and PID probe use the Unix process contract.

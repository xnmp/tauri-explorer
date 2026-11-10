# Windows warm-pool lint failure

The audit batch in PR #1602 extracted `PoolState::withdraw_ready` from
`retire_parked`. The caller is Linux/macOS-only, but the new private method was
unconditional. Windows builds therefore reported dead code, and the native smoke
workflow's `cargo clippy --all-targets --features e2e-hooks,e2e-webview2-attach -- -D warnings`
failed before the workflow could be green.

The immediately preceding native smoke run passed on both platforms. Reverting
the single intervening audit-batch PR restores that tested baseline. This also
rolls back the batch's other refactors and behavior fixes; they can be reintroduced
with Windows lint coverage. The native smoke workflow and its strict lint gate
remain unchanged.

When extracting a helper from platform-gated code, preserve its compilation
scope or verify every target where the helper will now exist. A Linux Clippy
pass cannot prove that Windows has a production caller.

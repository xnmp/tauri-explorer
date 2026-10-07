# Picker source navigation — checkpoint 2026-10-07

Worktree `.worktrees/picker-source-navigation`, branch `feat/picker-source-navigation`,
PR #1008, issue #1003. Integrated origin/dev3122da50 at6ad5f778. Main checkout and
its unrelated user/agent work remain untouched. Squash into dev only after final
verification; close issue manually. User authorized merge conditional on testing.
Latest clarification: system picker selection must remain OS opt-in. README and
portal descriptor enforce that; app/installer do not write portals.conf.

## Local setup

- Picker binary: ~/.local/lib/tauri-explorer-picker/tauri-explorer.
- ~/.local/share/dbus-1/services/org.freedesktop.impl.portal.desktop.tauri_explorer.service selects that executable.
- User explicitly requested local enablement; ~/.config/xdg-desktop-portal/portals.conf selects FileChooser=tauri-explorer.
- Hyprland live config and chezmoi template float picker windows and omit monitor center.
- Future normal Explorer launches now use same build through ~/.local/bin/tauri-explorer and user desktop override.
- Installed/current portal hashaf44afab79e671c3d71ac971e4f131ee4ba1e4f54eb1a1495707d35264794d7a, PID406722 at checkpoint.
- Restart normal user windows manually when convenient to activate shared DB writers; never automate desktop input/window moves/closing.
- Original activation backup /tmp/picker-activation-backup-5rdxaqn8; latest binary/launcher backup /tmp/picker-final-install-backup.

## Implementation

Portal retains exported parent, realizes hidden GTK surface, attaches before mapping.
Type-ahead selects/scolls a row; Enter opens folders/accepts files. Ctrl+F filters
active column; Ctrl+P immediate local history plus debounced fuzzy search,20-row cap.
Modal focus restoration completes before folder navigation. Async selection intent
prevents delayed validation overriding newer selection, navigation or cancellation.
Open selections validate current kind via metadata (follow valid symlinks), failing closed.

Native history is SQLite at platform data_local_dir/tauri-explorer/history.sqlite.
Granular IMMEDIATE transactions, seed imported once; per-renderer FIFO flush before
terminal picker completion. Optional history errors cannot block uploads. Backend
opaque revisions protect pruning; frontend publication occurs inside epoch guard.
Canonical/local refreshes preserve immutable identities using semantic field tuples;
prune removes the Set of inspected missing objects, protecting new uses and duplicate
legacy records. Independent review found localStorage cross-process caching, unsafe
JSON value equality, property-order mismatch, and duplicate-map bugs; all fixed with
real reproductions. Keep state immutable or causal pruning breaks.

## Verification to checkpoint

- Latest complete351 Vitest files pass3336 tests(+3 skipped),29 performance tests.
-20 pruning/canonical/reuse/channel regressions pass; type/arch/maps clean625/625.
- Native portal6 contracts, SQLite5 contracts(+ignored child exercised by real
  separate writers), metadata-kind/symlink1 contract pass.
- Independent46 picker browser tests pass23 Chromium+23 WebKit before final pruning adjustment.
- All-view1387 sweep:1319 pass,68 fail after build/HMR/load disruption. Every failed
  spec passed fresh isolated reruns282+30+16 with no product fixes for those failures.
- Exact production release af44afab passes actual private D-Bus OpenFile with source
  GTK process: source[20,40,950,650], picker[45,85,900,560], centers[495,365], correct
  WM_TRANSIENT_FOR. Native history commands roundtrip; warm renderer Ctrl+P sees
  a separate process writing through exact production Rust store. Actual UI selection
  returns successful fileURI; SQLite recent/frequency durable before reply.
- Native proof /tmp/picker-production-native-fvprUF/proof: report, D-Bus response,
  geometry, images, process isolation, verified scoped cleanup. New screenshots copied
  into feature folder; native flows unchanged by final prune adjustment.
- Native smoke used private Xvfb/Openbox, private bus/profile BEFORE bus startup,
  GDK_BACKEND=x11, no Wayland/Hypr variables. No test processes remain,4607/4608 free.
- Private Hyprland cannot render NVIDIA linear GBM, so visual Wayland acceptance is
  unclaimed. Hyprland0.56.2 parent-placement implementation supports transient approach;
  backend-mismatched parent handles fall back.

## Outstanding at checkpoint

Final pruning adjustments and8 canonical store tests await commit/push, independent
reviewer /root/premerge_review finishing. Current old6ad5f778 frontend CI failed2
prune contracts; final whole local suite is green. Push correction to start fresh CI.
Rebuild final frontend/native once source frozen (last superseded release compile was
stopped), rerun picker/full-view outcomes on a stable server, repeat bounded production
portal smoke with reviewer, install/activate final binary only after native acceptance.
Retire idle custom portal only after argv/exe and zero Hyprland clients are verified.

Required GitHub checks include frontend,rust,webkit,smoke(ubuntu-latest),launch-smoke,
code-maps; protection also lists1 approving review (admins not enforced). Do not bypass
failed checks. Existing independent reviews are local; GitHub reviews empty at checkpoint.

Temporary test configs were removed from worktree and saved under /tmp; recreate from
/tmp/{vite,playwright}.picker.config.ts for port1442, or .picker.rerun.config.ts1453.
Do not commit configs. Source edits/build/svelte-kit sync during browser sweep can
cause duplicated dynamic module state/HMR failures; freeze them first. Broader tests
rewrite tracked evidence/screenshots; restore only those generated files outside
screenshots/feat/picker-source-navigation before committing. Current source changes
are task-owned, worktree had been clean before latest prune fix. Root target reused
at /home/chong/Repos/tauri-explorer/src-tauri/target; cargo builds need CARGO_TARGET_DIR.

# Arch Linux graphical Trash qualification: #723 and #733

The production fix already landed through #844/#845. This branch adds real-native acceptance evidence against dev 78f11845; it changes no production behavior.

## Setup and outcome

Arch Linux x86_64, private Xvfb 1600×1000 and Openbox, GTK/Thunar, Explorer Details at 100%. Each scenario uses disposable XDG config/data/cache/state, X11 only, a separate D-Bus session and accessibility bus. `inode/directory` and `x-scheme-handler/trash` default to the affected Kitty terminal desktop entry. No test input or clipboard access reaches the user's desktop.

A private user/mount namespace retains UID 1000 and masks unrelated mount Trash locations because GIO aggregates mounted-volume Trash independently of XDG_DATA_HOME. The helper validates every returned trash target belongs to the disposable profile. An empty files directory alone would not prove empty graphical Trash.

The tests move `acceptance-723-733-disposable.txt` through the real Rust deletion command, discover its collision-safe saved name, and assert its bytes remain unchanged. The actual graphical window's accessibility tree must contain it; process environments, native window identity, current Explorer path and absence of a Kitty window are checked. The empty case requires a newly opened graphical window, zero native GIO Trash children and zero saved files. Task-owned fixture and metadata are removed afterward.

| Scenario | Actual route and proof | Result |
| --- | --- | --- |
| Native service | FileManager1 opens `trash:///` in Thunar, despite Kitty directory association; known file and empty Trash | 2 passed |
| No native service, graphical fallback installed | GIO desktop-entry dispatch opens the profile's `Trash/files` in Thunar; after Thunar registers FileManager1 the second action opens native empty Trash | 2 passed |
| Terminal-only installed handlers | Explorer reports no graphical file manager; no terminal opens, payload unchanged | 1 passed, empty case intentionally skipped |
| Admitted graphical desktop entry with nonexistent working directory | Explicit failure in Explorer; no terminal or false success, payload unchanged | 1 passed, empty case intentionally skipped |

The fallback screenshot caption refers to the actual first folder window. The empty fallback screenshot shows the later native Trash window; it does not claim both clicks used the same route.

## Reproduction

Build with `VITE_E2E_HOOKS=1 bun run tauri build --debug --no-bundle`. Run the opt-in `e2e-tauri/specs/linux-trash-opener.spec.ts` with `TAURI_NATIVE_TRASH_SCENARIO=native|fallback|missing|failed` under the isolated setup above; ordinary test runs skip this external-application suite. The profile's MIME associations, installed desktop entries and D-Bus services must match the chosen scenario. Non-native scenarios omit `org.freedesktop.FileManager1` and `org.xfce.Thunar` activation services (the separate `org.xfce.FileManager` service remains) and restrict application discovery to the profile, while retaining GTK themes/icons/MIME data. Run the driver on task-owned ports instead of a user's existing driver.

`e2e-tauri/fixtures/trash-accessibility.py` checks actual AT-SPI window content and the native GIO target count. Screenshots were visually inspected after all four final scenarios passed. Browser mocks and launcher argv assertions are not used as evidence of external dispatch. Native TypeScript validation also passed.

## Evidence

All six inspected PNGs are under `screenshots/test/trash-broken-in-arch/`: native and fallback disposable/empty windows, missing opener and failed executable feedback. Representative copies are under `evidence/723-733/`. Existing production launcher contracts and the original terminal-handler reproduction are documented in `docs/lessons/757-linux-trash-directory-terminal-handler.md`.

Other platforms were not executed in this qualification; their production code is unchanged.

### Detailed private desktop recipe

Install Xvfb, Openbox, Thunar/GVFS, Kitty, AT-SPI, Python GI, xprop, ffmpeg and the native WebDriver tools. Copy the actual Kitty desktop entry into each task profile and actual Thunar entry into native/fallback profiles. The failed profile uses the actual `/usr/bin/thunar` executable and `Path=/nonexistent/acceptance-working-directory`; GIO admits this entry, then attempted spawn fails to change directory, with the desktop ID and detail in Explorer.

Copy session D-Bus service files into the profile, omitting entries whose service Name is `org.freedesktop.FileManager1` or `org.xfce.Thunar` for non-native cases. Use a private bus.conf with only that servicedir, `unix:tmpdir=/tmp`, EXTERNAL authentication and a session policy allowing destinations/ownership. Retain GVFS and Xfconf services. Never include the host session configuration.

Non-native `XDG_DATA_DIRS` contains resource symlinks to system themes, icons, MIME data and glycin loaders, without system applications. Export the system GSettings schema path. A separate accessibility daemon from `/usr/share/defaults/at-spi2/accessibility.conf` supplies `AT_SPI_BUS_ADDRESS`; update only the private session activation environment with that variable and start the accessibility registry. Trap cleanup for exactly those recorded daemon PIDs. This ensures D-Bus-activated Thunar joins the same isolated accessibility bus.

Mask unrelated mounted-volume roots only inside a private mount namespace. Example for invoking UID/GID 1000 (adapt to `id -u`/`id -g`), with task-owned empty mask and a mount root containing non-profile Trash:

```sh
unshare --user --map-root-user --mount bash -c '
  mount --make-rprivate / &&
  mount --bind "$1" "$2" &&
  exec unshare --user --map-users=0,1000,1 --map-groups=0,1000,1 bash "$3" "$4"
' trash-check "$TASK_EMPTY_MASK" "$TASK_MOUNT_ROOT" "$TASK_PRIVATE_RUNNER" "$SCENARIO"
```

The runner sets the private XDG homes and short 0700 runtime directory, forces X11, unsets WAYLAND_DISPLAY, then runs `xvfb-run -a --server-args="-screen 0 1600x1000x24" dbus-run-session --config-file="$PROFILE/bus.conf" -- bash "$ACCESSIBILITY_RUNNER"`. The accessibility runner invokes `e2e-tauri/with-window-manager.sh` and WDIO on the single Trash spec. Native process and external file-manager environments must match before accepting evidence. The target guard fails if GIO enumerates a Trash item outside the profile; the namespace never changes host mounts or host Trash.

The corrected failed-profile run asserts `thunar.desktop:` and its actual failed working-directory launch detail. The first nonexistent-executable fixture was rejected at catalogue construction and is excluded from completion evidence. Final failure screenshot and evidence copy were regenerated after this correction.

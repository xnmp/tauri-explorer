# #1057 — Disabling WebKitGTK compositing made scroll, marquee and menus CPU-bound

**Symptom:** On Linux (Arch/Hyprland, NVIDIA RTX 3070, WebKitGTK 2.54.1),
scrolling, marquee selection and opening the context menu were laggy and got
worse with window size. Measured at 2560×1440: scroll 44–68 ms median frames,
marquee 53–89 ms, context menu 170–290 ms to open. Idle frames stayed at 16 ms.

**Root cause:** `lib.rs` set `WEBKIT_DISABLE_DMABUF_RENDERER=1` and
`WEBKIT_DISABLE_COMPOSITING_MODE=1` on every Linux machine (5d590688, the
NVIDIA/Wayland `Error 71 (Protocol error)` crash workaround). On WebKitGTK
2.44+ that leaves the webview non-composited: each frame CPU-paints its whole
dirty region and ships it to the UI process, so a near-full-window scroll is a
near-full-window CPU raster. (On 2.42/2.43 disabling DMABuf alone still fell
back to a composited backing store; `DISABLE_COMPOSITING_MODE` disables
compositing on every version.) The archived notes in `lessons_learnt.md` are
wrong on two points: the DMABuf variable does affect rendering, and
`WEBKIT_DISABLE_COMPOSITING_MODE` was **not** removed in 2.46 — 2.54 still
reads it.

**Fix:** `webkit_renderer.rs` decides at process start:
- NVIDIA proprietary driver (`/sys/module/nvidia`) on WebKitGTK ≥2.44:
  `WEBKIT_DMABUF_RENDERER_FORCE_SHM=1` keeps the composited renderer but hands
  frames over in shared memory, so the crashing GPU-buffer path is never used.
  `WEBKIT_FORCE_DMABUF_RENDERER=1` defeats the Debian/Ubuntu/Gentoo patch that
  otherwise disables DMABuf (and with it compositing) on NVIDIA.
- NVIDIA on older WebKitGTK: the legacy variables (FORCE_SHM is first read in 2.44).
- Software GL — no accessible non-`vgem` render node (`/dev/dri/renderD*`;
  VMs, CI runners, containers), or Mesa forced to software by
  `LIBGL_ALWAYS_SOFTWARE`/`GALLIUM_DRIVER=llvmpipe|softpipe`: the legacy
  variables, i.e. exactly what these hosts ran before #1057. Skia CPU painting
  (`TAURI_EXPLORER_WEBKIT_RENDERER=cpu`) was tried first and reverted in #1071:
  smooth for keyboard selection locally, but on the Linux CI runner the native
  preview-resize drag still missed the mid-drag frame on dev. The render node
  is a likely, not certain, signal: VMs whose virtual GPU lacks 3D keep a node
  and stay on WebKit defaults, and WSLg's d3d12 GL needs no DRM node. The probe
  uses `access(2)`, never `open(2)` (a driver's open hook can wake a sleeping
  laptop dGPU), and runs only when no override, user variable or NVIDIA driver
  has decided.
- Every other GPU: WebKit's defaults, which every other WebKitGTK app ships with.
- Any user-set WebKit renderer variable — even empty or "0", since WebKit
  treats presence as a choice — leaves the environment untouched.
  `TAURI_EXPLORER_WEBKIT_RENDERER=shm|cpu|legacy|native` forces a mode for one
  launch and clears conflicting variables. The decision is logged first in
  setup as `Renderer(webkit)`.

Measured on the NVIDIA machine with FORCE_SHM: scroll 17 ms, marquee 21 ms,
context menu 57–95 ms.

**GPU-less hosts (found by Linux CI):** WebKit's defaults composite and paint
through software GL (llvmpipe) there. On the PR the CI resize specs saw one
coalesced pointer move across a 150 ms pause (`[240, 240]`), and the whole
native suite ran ~23% slower. Locally, forcing Mesa llvmpipe
(`__EGL_VENDOR_LIBRARY_FILENAMES=…/50_mesa.json LIBGL_ALWAYS_SOFTWARE=1`)
and stepping the selection 12 times in a tiled 68-wallpaper folder measured:

| mode | changed frames | max gap |
|---|---|---|
| native (llvmpipe) | 1 | — |
| shm | 10 | 617 ms |
| legacy | 57 | 66 ms |
| Skia CPU | 59 | 84 ms |

Skia CPU was chosen first because it stays composited, but on CI it still
failed the preview-resize drag on dev (it had passed once on the PR), so
software-GL hosts use legacy (#1071). Under Mesa llvmpipe on 2.54, legacy also
painted Ctrl+N windows correctly; the white secondary windows were only seen
with NVIDIA.

**Gotchas:**
- Removing both variables with no replacement reproduces `Error 71` on NVIDIA.
- Shared memory still rasterises with GPU Skia and reads back the full frame;
  field reports show FORCE_SHM regressions on some stacks (runaway
  WebKitWebProcess CPU/RSS on NVIDIA, white windows on old Intel/X11). Soak the
  web process on NVIDIA before trusting it, and keep the per-launch override.
- Frontend-created Linux windows are transparent (`window-appearance.ts`).
  Transparent webviews in composited mode are the wry#1524 stale-frame case, so
  verify Ctrl+N and warm-pool windows, not just the main window.
- The mock-invoke / Chromium perf suites cannot see paint-mode cost. Measure on
  the real binary (headless Hyprland output, rAF-gap sampling) — see #1054.

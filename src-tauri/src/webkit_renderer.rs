//! Linux WebKitGTK renderer selection (#1057).
//!
//! WebKitGTK's DMABuf renderer shares GPU buffers with the compositor. With
//! NVIDIA's proprietary driver on Wayland that path crashes with `Error 71
//! (Protocol error)`. The old workaround set `WEBKIT_DISABLE_DMABUF_RENDERER`
//! and `WEBKIT_DISABLE_COMPOSITING_MODE` for every Linux machine, which on
//! WebKitGTK 2.44+ leaves the webview non-composited: each visual change
//! CPU-paints its whole dirty region, measured at 40–90 ms per frame for a
//! scroll in a 2560×1440 window (#1057).
//!
//! WebKitGTK 2.44 added `WEBKIT_DMABUF_RENDERER_FORCE_SHM`: the renderer stays
//! composited but hands frames over in shared memory instead of GPU buffers,
//! avoiding the crashing path. If the EGL platform it needs is missing, WebKit
//! itself falls back to the non-composited path. Several distributions patch
//! WebKitGTK to disable DMABuf entirely on NVIDIA unless
//! `WEBKIT_FORCE_DMABUF_RENDERER` is set; forcing it is safe here because
//! shared memory never uses the hardware buffer path.
//!
//! Hosts with software GL (no GPU render node: VMs, CI runners, containers)
//! keep the non-composited path they had before #1057. Composited through
//! llvmpipe, a 12-step selection walk repainted 1 frame and drag input stalled
//! for 150–450 ms. Skia CPU painting (`cpu`) was as smooth as non-composited for
//! selection locally, but on the 4-vCPU Linux CI runner a pointer drag still
//! skipped the frame between two moves (the native preview-resize spec failed
//! on dev with it), while non-composited passed every run (#1071).
//!
//! NVIDIA's proprietary driver and GPU-less hosts are the only cases known to
//! need any of this, so other GPUs keep WebKit's own defaults — the
//! configuration every other WebKitGTK app ships with. Variables a user sets
//! themselves always win, and `TAURI_EXPLORER_WEBKIT_RENDERER` selects a mode
//! for one launch.
//!
//! The decision is a pure function of the WebKitGTK runtime version, the GPU
//! driver, whether a GPU render node is usable, and the environment; only `apply` touches the process environment,
//! and it must run before GTK/WebKit start.

/// Per-launch override: `shm`, `cpu`, `legacy` or `native`.
pub(crate) const OVERRIDE_VAR: &str = "TAURI_EXPLORER_WEBKIT_RENDERER";

/// WebKit renderer variables a user may already have chosen. WebKit treats any
/// present value other than "0" — including an empty one — as a choice, and
/// "0" is a choice too, so presence alone counts.
const USER_RENDERER_VARS: &[&str] = &[
    "WEBKIT_DISABLE_DMABUF_RENDERER",
    "WEBKIT_DISABLE_COMPOSITING_MODE",
    "WEBKIT_FORCE_COMPOSITING_MODE",
    "WEBKIT_DMABUF_RENDERER_FORCE_SHM",
    "WEBKIT_DMABUF_RENDERER_DISABLE_GBM",
    "WEBKIT_DMABUF_RENDERER_BUFFER_FORMAT",
    "WEBKIT_FORCE_DMABUF_RENDERER",
    "WEBKIT_SKIA_ENABLE_CPU_RENDERING",
];

/// First WebKitGTK release that reads `WEBKIT_DMABUF_RENDERER_FORCE_SHM`.
const FORCE_SHM_MIN_VERSION: (u32, u32) = (2, 44);

/// First WebKitGTK release that paints with Skia (and so reads
/// `WEBKIT_SKIA_ENABLE_CPU_RENDERING`).
const SKIA_CPU_MIN_VERSION: (u32, u32) = (2, 46);

const SHARED_MEMORY_ENV: &[(&str, &str)] = &[
    ("WEBKIT_DMABUF_RENDERER_FORCE_SHM", "1"),
    ("WEBKIT_FORCE_DMABUF_RENDERER", "1"),
];
const CPU_PAINTING_ENV: &[(&str, &str)] = &[("WEBKIT_SKIA_ENABLE_CPU_RENDERING", "1")];
const LEGACY_ENV: &[(&str, &str)] = &[
    ("WEBKIT_DISABLE_COMPOSITING_MODE", "1"),
    ("WEBKIT_DISABLE_DMABUF_RENDERER", "1"),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RendererMode {
    /// Composited DMABuf renderer over shared-memory buffers.
    SharedMemory,
    /// Composited, with Skia painting tiles on the CPU instead of through GL.
    /// Only chosen by the `cpu` override (see the module docs, #1071).
    CpuPainting,
    /// DMABuf renderer and compositing disabled (non-composited painting).
    Legacy,
    /// WebKit's own defaults; the environment is left untouched.
    Native,
}

/// The facts the policy depends on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Host {
    /// WebKitGTK runtime `(major, minor)`.
    pub webkit: (u32, u32),
    /// NVIDIA's proprietary kernel driver is loaded.
    pub nvidia_proprietary: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RendererPlan {
    pub mode: RendererMode,
    pub reason: String,
    /// Variables to set.
    pub set: &'static [(&'static str, &'static str)],
    /// Variables to remove so an explicit override is not contradicted.
    pub unset: Vec<&'static str>,
}

impl RendererPlan {
    fn chosen(mode: RendererMode, reason: String) -> Self {
        let set = match mode {
            RendererMode::SharedMemory => SHARED_MEMORY_ENV,
            RendererMode::CpuPainting => CPU_PAINTING_ENV,
            RendererMode::Legacy => LEGACY_ENV,
            RendererMode::Native => &[],
        };
        Self {
            mode,
            reason,
            set,
            unset: Vec::new(),
        }
    }

    /// An explicit override: also clear every other renderer variable so the
    /// effective mode is exactly the requested one.
    fn overridden(mode: RendererMode, reason: String) -> Self {
        let mut plan = Self::chosen(mode, reason);
        plan.unset = USER_RENDERER_VARS
            .iter()
            .copied()
            .filter(|var| !plan.set.iter().any(|(name, _)| name == var))
            .collect();
        plan
    }
}

/// Choose the renderer for `host`, reading the environment through `get`.
/// `gpu_render_node` reports whether a hardware render node is accessible; it
/// is only called when no override, user variable or NVIDIA driver has already
/// decided, so the probe never runs where its answer is irrelevant.
pub(crate) fn plan(
    host: Host,
    get: impl Fn(&str) -> Option<String>,
    gpu_render_node: impl FnOnce() -> bool,
) -> RendererPlan {
    let version = format!("WebKitGTK {}.{}", host.webkit.0, host.webkit.1);
    let supports_shm = host.webkit >= FORCE_SHM_MIN_VERSION;

    let requested = get(OVERRIDE_VAR).map(|value| value.trim().to_ascii_lowercase());
    let mut ignored = String::new();
    match requested.as_deref() {
        Some("shm") => {
            let caveat = if supports_shm {
                ""
            } else {
                " (this WebKitGTK ignores FORCE_SHM and will use hardware DMABuf)"
            };
            return RendererPlan::overridden(
                RendererMode::SharedMemory,
                format!("{OVERRIDE_VAR}=shm on {version}{caveat}"),
            );
        }
        Some("cpu") => {
            let caveat = if host.webkit >= SKIA_CPU_MIN_VERSION {
                ""
            } else {
                " (this WebKitGTK predates Skia and ignores it)"
            };
            return RendererPlan::overridden(
                RendererMode::CpuPainting,
                format!("{OVERRIDE_VAR}=cpu on {version}{caveat}"),
            );
        }
        Some("legacy") => {
            return RendererPlan::overridden(
                RendererMode::Legacy,
                format!("{OVERRIDE_VAR}=legacy on {version}"),
            )
        }
        Some("native") => {
            return RendererPlan::overridden(
                RendererMode::Native,
                format!("{OVERRIDE_VAR}=native on {version}"),
            )
        }
        Some(other) if !other.is_empty() => {
            ignored = format!(" (ignored unrecognised {OVERRIDE_VAR}={other:?})");
        }
        _ => {}
    }

    if let Some(var) = USER_RENDERER_VARS.iter().find(|var| get(var).is_some()) {
        return RendererPlan::chosen(
            RendererMode::Native,
            format!("{var} set by the user on {version}{ignored}"),
        );
    }
    if host.nvidia_proprietary {
        let (mode, why) = if supports_shm {
            (RendererMode::SharedMemory, "NVIDIA proprietary driver")
        } else {
            (
                RendererMode::Legacy,
                "NVIDIA proprietary driver, WebKitGTK predates FORCE_SHM",
            )
        };
        return RendererPlan::chosen(mode, format!("{why} on {version}{ignored}"));
    }
    let software_gl = forced_software_gl(&get)
        .or_else(|| (!gpu_render_node()).then_some("no accessible GPU render node"));
    let (mode, why) = match software_gl {
        Some(cause) => (RendererMode::Legacy, format!("{cause} (software GL)")),
        None => (
            RendererMode::Native,
            "GPU without NVIDIA proprietary driver".to_string(),
        ),
    };
    RendererPlan::chosen(mode, format!("{why} on {version}{ignored}"))
}

/// Mesa variables that force software rendering regardless of the hardware.
/// Mesa reads `LIBGL_ALWAYS_SOFTWARE` as a boolean that is false only for
/// "0", "n", "no", "f" or "false".
fn forced_software_gl(get: &impl Fn(&str) -> Option<String>) -> Option<&'static str> {
    let always_software = get("LIBGL_ALWAYS_SOFTWARE").is_some_and(|value| {
        let value = value.trim().to_ascii_lowercase();
        !value.is_empty() && !matches!(value.as_str(), "0" | "n" | "no" | "f" | "false")
    });
    if always_software {
        return Some("LIBGL_ALWAYS_SOFTWARE set");
    }
    let gallium = get("GALLIUM_DRIVER").map(|value| value.trim().to_ascii_lowercase());
    matches!(gallium.as_deref(), Some("llvmpipe" | "softpipe"))
        .then_some("GALLIUM_DRIVER selects a software rasteriser")
}

/// Whether this process has read/write access to a hardware DRM render node —
/// a likely, not certain, sign that GL is hardware-backed. Known misses: VMs
/// whose virtual GPU lacks 3D (node present, llvmpipe anyway → WebKit
/// defaults, as before) and WSLg, whose d3d12 GL uses `/dev/dxg` rather than a
/// DRM node (may get CPU painting while compositing stays on the GPU).
///
/// Uses `access(2)`, never `open(2)`: opening a node runs the driver's open
/// hook, which can runtime-resume a sleeping laptop dGPU. `access` honours
/// mode bits and uaccess ACLs; sandbox denials surface later in Mesa itself.
/// `vgem` (a buffer-sharing driver WSL kernels ship) has a render node but no
/// rendering, so it is skipped.
fn has_usable_render_node() -> bool {
    let Ok(entries) = std::fs::read_dir("/dev/dri") else {
        return false;
    };
    entries.flatten().any(|entry| {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with("renderD") {
            return false;
        }
        let driver = std::fs::read_link(format!("/sys/class/drm/{name}/device/driver"));
        if driver.is_ok_and(|link| link.file_name().is_some_and(|base| base == "vgem")) {
            return false;
        }
        let Ok(path) = std::ffi::CString::new(entry.path().into_os_string().into_encoded_bytes())
        else {
            return false;
        };
        // SAFETY: `path` is a valid NUL-terminated string; access(2) only
        // checks permissions.
        unsafe { libc::access(path.as_ptr(), libc::R_OK | libc::W_OK) == 0 }
    })
}

/// The linked WebKitGTK runtime's `(major, minor)`.
pub(crate) fn runtime_version() -> (u32, u32) {
    // SAFETY: these return the runtime's version constants and need no
    // initialisation.
    unsafe {
        (
            webkit2gtk::ffi::webkit_get_major_version(),
            webkit2gtk::ffi::webkit_get_minor_version(),
        )
    }
}

/// Apply the renderer plan to this process. Must run before GTK or WebKit is
/// initialised and while the process is still single-threaded.
pub(crate) fn apply() -> RendererPlan {
    let host = Host {
        webkit: runtime_version(),
        nvidia_proprietary: std::path::Path::new("/sys/module/nvidia").exists(),
    };
    // A self-restarted process inherits the variables its predecessor applied;
    // those are the app's choice, not the user's (#1079).
    let inherited = applied_marker(
        std::env::var(crate::child_env::APPLIED_MARKER_VAR)
            .ok()
            .as_deref(),
    );
    let get = |name: &str| {
        (!inherited.contains(&name))
            .then(|| std::env::var_os(name).map(|value| value.to_string_lossy().into_owned()))
            .flatten()
    };
    let plan = plan(host, get, has_usable_render_node);
    let app_set = app_set_names(&plan, get);
    // Inherited choices that this run no longer makes must not linger.
    for name in &inherited {
        if !plan.set.iter().any(|(var, _)| var == name) {
            std::env::remove_var(name);
        }
    }
    for name in &plan.unset {
        std::env::remove_var(name);
    }
    for (name, value) in plan.set {
        std::env::set_var(name, value);
    }
    if app_set.is_empty() {
        std::env::remove_var(crate::child_env::APPLIED_MARKER_VAR);
    } else {
        std::env::set_var(crate::child_env::APPLIED_MARKER_VAR, app_set.join(","));
    }
    crate::child_env::record_app_set(app_set);
    plan
}

/// Variables the plan sets that the user had not already set: exactly the ones
/// children must not inherit. `get` reads the user's environment (with any
/// restart-inherited app choices already hidden).
pub(crate) fn app_set_names(
    plan: &RendererPlan,
    get: impl Fn(&str) -> Option<String>,
) -> Vec<&'static str> {
    plan.set
        .iter()
        .map(|(name, _)| *name)
        .filter(|name| get(name).is_none())
        .collect()
}

/// Known renderer variables named by the restart marker.
fn applied_marker(marker: Option<&str>) -> Vec<&'static str> {
    let listed: Vec<&str> = marker.into_iter().flat_map(|m| m.split(',')).collect();
    USER_RENDERER_VARS
        .iter()
        .copied()
        .filter(|var| listed.contains(var))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    const NVIDIA: Host = Host {
        webkit: (2, 54),
        nvidia_proprietary: true,
    };
    const MESA: Host = Host {
        webkit: (2, 54),
        nvidia_proprietary: false,
    };
    /// VM / CI runner / container: probed with no usable render node.
    const NO_GPU: Host = Host {
        webkit: (2, 52),
        nvidia_proprietary: false,
    };

    /// A host with an accessible render node.
    fn with_gpu(host: Host, get: impl Fn(&str) -> Option<String>) -> RendererPlan {
        plan(host, get, || true)
    }
    /// A host without one.
    fn without_gpu(host: Host, get: impl Fn(&str) -> Option<String>) -> RendererPlan {
        plan(host, get, || false)
    }

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |name| map.get(name).cloned()
    }

    fn sets(plan: &RendererPlan, name: &str) -> bool {
        plan.set.iter().any(|(var, _)| *var == name)
    }

    #[test]
    fn app_set_names_include_applied_and_exclude_user_set() {
        let names = |plan: &RendererPlan, pairs: &[(&str, &str)]| app_set_names(plan, env(pairs));
        // NVIDIA.
        let nv = with_gpu(NVIDIA, env(&[]));
        assert_eq!(
            names(&nv, &[]),
            [
                "WEBKIT_DMABUF_RENDERER_FORCE_SHM",
                "WEBKIT_FORCE_DMABUF_RENDERER"
            ]
        );
        // Software GL.
        let sw = without_gpu(NO_GPU, env(&[]));
        assert_eq!(
            names(&sw, &[]),
            [
                "WEBKIT_DISABLE_COMPOSITING_MODE",
                "WEBKIT_DISABLE_DMABUF_RENDERER"
            ]
        );
        // Old WebKitGTK on NVIDIA.
        let old = with_gpu(
            Host {
                webkit: (2, 42),
                ..NVIDIA
            },
            env(&[]),
        );
        assert_eq!(names(&old, &[]).len(), 2);
        // cpu override: user already set the variable the override applies.
        let cpu = with_gpu(MESA, env(&[(OVERRIDE_VAR, "cpu")]));
        assert_eq!(names(&cpu, &[]), ["WEBKIT_SKIA_ENABLE_CPU_RENDERING"]);
        assert!(names(&cpu, &[("WEBKIT_SKIA_ENABLE_CPU_RENDERING", "1")]).is_empty());
        // Native / user-variable plans set nothing.
        assert!(names(&with_gpu(MESA, env(&[])), &[]).is_empty());
        let user = with_gpu(NVIDIA, env(&[("WEBKIT_DISABLE_COMPOSITING_MODE", "1")]));
        assert!(names(&user, &[("WEBKIT_DISABLE_COMPOSITING_MODE", "1")]).is_empty());
    }

    #[test]
    fn restart_marker_hides_inherited_app_choices_from_the_user_check() {
        let inherited = applied_marker(Some(
            "WEBKIT_DMABUF_RENDERER_FORCE_SHM,WEBKIT_FORCE_DMABUF_RENDERER,BOGUS",
        ));
        assert_eq!(inherited.len(), 2);
        let raw = env(&[
            ("WEBKIT_DMABUF_RENDERER_FORCE_SHM", "1"),
            ("WEBKIT_FORCE_DMABUF_RENDERER", "1"),
        ]);
        let get = |name: &str| (!inherited.contains(&name)).then(|| raw(name)).flatten();
        let plan = with_gpu(NVIDIA, get);
        assert_eq!(plan.mode, RendererMode::SharedMemory);
        assert!(!plan.reason.contains("set by the user"), "{}", plan.reason);
        // Without the marker the same environment reads as the user's.
        assert!(with_gpu(NVIDIA, &raw).reason.contains("set by the user"));
        assert!(applied_marker(None).is_empty());
    }

    #[test]
    fn nvidia_keeps_compositing_without_hardware_buffers() {
        let plan = with_gpu(NVIDIA, env(&[]));
        assert_eq!(plan.mode, RendererMode::SharedMemory);
        assert!(sets(&plan, "WEBKIT_DMABUF_RENDERER_FORCE_SHM"));
        // Distribution patches disable DMABuf on NVIDIA unless forced.
        assert!(sets(&plan, "WEBKIT_FORCE_DMABUF_RENDERER"));
        assert!(!sets(&plan, "WEBKIT_DISABLE_DMABUF_RENDERER"));
        assert!(!sets(&plan, "WEBKIT_DISABLE_COMPOSITING_MODE"));
    }

    #[test]
    fn other_gpus_keep_webkit_defaults() {
        let plan = with_gpu(MESA, env(&[]));
        assert_eq!(plan.mode, RendererMode::Native);
        assert!(plan.set.is_empty() && plan.unset.is_empty());
    }

    #[test]
    fn hosts_without_a_gpu_keep_the_non_composited_path() {
        for webkit in [(2, 54), (2, 46), (2, 44), (2, 40)] {
            let plan = without_gpu(Host { webkit, ..NO_GPU }, env(&[]));
            assert_eq!(plan.mode, RendererMode::Legacy, "{webkit:?}");
            assert!(sets(&plan, "WEBKIT_DISABLE_COMPOSITING_MODE"));
            assert!(sets(&plan, "WEBKIT_DISABLE_DMABUF_RENDERER"));
            assert!(
                plan.reason.contains("no accessible GPU render node"),
                "{}",
                plan.reason
            );
        }
    }

    #[test]
    fn the_render_node_probe_runs_only_when_it_decides_the_mode() {
        let probe = || -> bool { panic!("render-node probe ran") };
        assert_eq!(
            plan(NVIDIA, env(&[]), probe).mode,
            RendererMode::SharedMemory
        );
        assert_eq!(
            plan(MESA, env(&[(OVERRIDE_VAR, "native")]), probe).mode,
            RendererMode::Native
        );
        assert_eq!(
            plan(MESA, env(&[("WEBKIT_DISABLE_COMPOSITING_MODE", "")]), probe).mode,
            RendererMode::Native
        );
        assert_eq!(
            plan(MESA, env(&[("LIBGL_ALWAYS_SOFTWARE", "1")]), probe).mode,
            RendererMode::Legacy
        );
    }

    #[test]
    fn forced_software_gl_counts_as_no_gpu() {
        for (var, value) in [
            ("LIBGL_ALWAYS_SOFTWARE", "1"),
            ("LIBGL_ALWAYS_SOFTWARE", "true"),
            ("GALLIUM_DRIVER", "llvmpipe"),
            ("GALLIUM_DRIVER", " Softpipe "),
        ] {
            let plan = with_gpu(MESA, env(&[(var, value)]));
            assert_eq!(plan.mode, RendererMode::Legacy, "{var}={value:?}");
            assert!(plan.reason.contains(var), "{}", plan.reason);
        }
        for (var, value) in [
            ("LIBGL_ALWAYS_SOFTWARE", "0"),
            ("LIBGL_ALWAYS_SOFTWARE", "false"),
            ("LIBGL_ALWAYS_SOFTWARE", ""),
            ("GALLIUM_DRIVER", "radeonsi"),
        ] {
            let plan = with_gpu(MESA, env(&[(var, value)]));
            assert_eq!(plan.mode, RendererMode::Native, "{var}={value:?}");
        }
    }

    #[test]
    fn user_variables_and_overrides_win_on_hosts_without_a_gpu() {
        let user = without_gpu(NO_GPU, env(&[("WEBKIT_DISABLE_COMPOSITING_MODE", "1")]));
        assert_eq!(user.mode, RendererMode::Native);
        assert!(user.set.is_empty() && user.unset.is_empty());

        let native = without_gpu(NO_GPU, env(&[(OVERRIDE_VAR, "native")]));
        assert_eq!(native.mode, RendererMode::Native);
        assert!(native.set.is_empty());

        let cpu = with_gpu(
            MESA,
            env(&[
                (OVERRIDE_VAR, "cpu"),
                ("WEBKIT_DISABLE_COMPOSITING_MODE", "1"),
            ]),
        );
        assert_eq!(cpu.mode, RendererMode::CpuPainting);
        assert!(cpu.unset.contains(&"WEBKIT_DISABLE_COMPOSITING_MODE"));
        assert!(!cpu.unset.contains(&"WEBKIT_SKIA_ENABLE_CPU_RENDERING"));
    }

    #[test]
    fn nvidia_on_webkit_without_force_shm_uses_the_legacy_workaround() {
        for webkit in [(2, 43), (2, 42), (2, 40)] {
            let plan = with_gpu(Host { webkit, ..NVIDIA }, env(&[]));
            assert_eq!(plan.mode, RendererMode::Legacy, "{webkit:?}");
            assert!(sets(&plan, "WEBKIT_DISABLE_DMABUF_RENDERER"));
            assert!(sets(&plan, "WEBKIT_DISABLE_COMPOSITING_MODE"));
        }
        assert_eq!(
            with_gpu(
                Host {
                    webkit: (2, 44),
                    ..NVIDIA
                },
                env(&[])
            )
            .mode,
            RendererMode::SharedMemory
        );
        assert_eq!(
            with_gpu(
                Host {
                    webkit: (3, 0),
                    ..NVIDIA
                },
                env(&[])
            )
            .mode,
            RendererMode::SharedMemory
        );
    }

    #[test]
    fn any_user_renderer_variable_wins_even_when_empty_or_zero() {
        for var in USER_RENDERER_VARS {
            for value in ["1", "0", ""] {
                let plan = with_gpu(NVIDIA, env(&[(var, value)]));
                assert_eq!(plan.mode, RendererMode::Native, "{var}={value:?}");
                assert!(plan.set.is_empty() && plan.unset.is_empty(), "{var}");
            }
        }
    }

    #[test]
    fn override_selects_the_mode_and_clears_conflicting_variables() {
        let user = ("WEBKIT_DISABLE_DMABUF_RENDERER", "1");

        let shm = with_gpu(MESA, env(&[(OVERRIDE_VAR, "SHM"), user]));
        assert_eq!(shm.mode, RendererMode::SharedMemory);
        assert!(shm.unset.contains(&"WEBKIT_DISABLE_DMABUF_RENDERER"));
        assert!(!shm.unset.contains(&"WEBKIT_DMABUF_RENDERER_FORCE_SHM"));

        let legacy = with_gpu(NVIDIA, env(&[(OVERRIDE_VAR, " legacy ")]));
        assert_eq!(legacy.mode, RendererMode::Legacy);
        assert!(!legacy.unset.contains(&"WEBKIT_DISABLE_DMABUF_RENDERER"));
        assert!(legacy.unset.contains(&"WEBKIT_DMABUF_RENDERER_FORCE_SHM"));

        let native = with_gpu(NVIDIA, env(&[(OVERRIDE_VAR, "native"), user]));
        assert_eq!(native.mode, RendererMode::Native);
        assert!(native.set.is_empty());
        assert!(native.unset.contains(&"WEBKIT_DISABLE_DMABUF_RENDERER"));
    }

    #[test]
    fn shm_override_on_old_webkit_warns_that_it_has_no_effect() {
        let old = Host {
            webkit: (2, 42),
            ..NVIDIA
        };
        let plan = with_gpu(old, env(&[(OVERRIDE_VAR, "shm")]));
        assert_eq!(plan.mode, RendererMode::SharedMemory);
        assert!(plan.reason.contains("ignores FORCE_SHM"), "{}", plan.reason);
    }

    #[test]
    fn unrecognised_override_falls_through_and_is_reported() {
        let plan = with_gpu(NVIDIA, env(&[(OVERRIDE_VAR, "gpu")]));
        assert_eq!(plan.mode, RendererMode::SharedMemory);
        assert!(plan.reason.contains("\"gpu\""), "{}", plan.reason);
        assert_eq!(
            with_gpu(NVIDIA, env(&[(OVERRIDE_VAR, "  ")])).mode,
            RendererMode::SharedMemory
        );
    }
}

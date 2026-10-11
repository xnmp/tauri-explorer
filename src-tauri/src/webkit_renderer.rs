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
//! Only NVIDIA's proprietary driver is known to need any of this, so other GPUs
//! keep WebKit's own defaults — the configuration every other WebKitGTK app
//! ships with. Variables a user sets themselves always win, and
//! `TAURI_EXPLORER_WEBKIT_RENDERER` selects a mode for one launch.
//!
//! The decision is a pure function of the WebKitGTK runtime version, the GPU
//! driver and the environment; only `apply` touches the process environment,
//! and it must run before GTK/WebKit start.

/// Per-launch override: `shm`, `legacy` or `native`.
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

const SHARED_MEMORY_ENV: &[(&str, &str)] = &[
    ("WEBKIT_DMABUF_RENDERER_FORCE_SHM", "1"),
    ("WEBKIT_FORCE_DMABUF_RENDERER", "1"),
];
const LEGACY_ENV: &[(&str, &str)] = &[
    ("WEBKIT_DISABLE_COMPOSITING_MODE", "1"),
    ("WEBKIT_DISABLE_DMABUF_RENDERER", "1"),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RendererMode {
    /// Composited DMABuf renderer over shared-memory buffers.
    SharedMemory,
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
pub(crate) fn plan(host: Host, get: impl Fn(&str) -> Option<String>) -> RendererPlan {
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
    let (mode, why) = match (host.nvidia_proprietary, supports_shm) {
        (false, _) => (RendererMode::Native, "no NVIDIA proprietary driver"),
        (true, true) => (RendererMode::SharedMemory, "NVIDIA proprietary driver"),
        (true, false) => (
            RendererMode::Legacy,
            "NVIDIA proprietary driver, WebKitGTK predates FORCE_SHM",
        ),
    };
    RendererPlan::chosen(mode, format!("{why} on {version}{ignored}"))
}

/// Apply the renderer plan to this process. Must run before GTK or WebKit is
/// initialised and while the process is still single-threaded.
pub(crate) fn apply() -> RendererPlan {
    // SAFETY: these return the linked WebKitGTK runtime's version constants and
    // need no initialisation.
    let webkit = unsafe {
        (
            webkit2gtk::ffi::webkit_get_major_version(),
            webkit2gtk::ffi::webkit_get_minor_version(),
        )
    };
    let host = Host {
        webkit,
        nvidia_proprietary: std::path::Path::new("/sys/module/nvidia").exists(),
    };
    let plan = plan(host, |name| {
        std::env::var_os(name).map(|value| value.to_string_lossy().into_owned())
    });
    for name in &plan.unset {
        std::env::remove_var(name);
    }
    for (name, value) in plan.set {
        std::env::set_var(name, value);
    }
    plan
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
    fn nvidia_keeps_compositing_without_hardware_buffers() {
        let plan = plan(NVIDIA, env(&[]));
        assert_eq!(plan.mode, RendererMode::SharedMemory);
        assert!(sets(&plan, "WEBKIT_DMABUF_RENDERER_FORCE_SHM"));
        // Distribution patches disable DMABuf on NVIDIA unless forced.
        assert!(sets(&plan, "WEBKIT_FORCE_DMABUF_RENDERER"));
        assert!(!sets(&plan, "WEBKIT_DISABLE_DMABUF_RENDERER"));
        assert!(!sets(&plan, "WEBKIT_DISABLE_COMPOSITING_MODE"));
    }

    #[test]
    fn other_gpus_keep_webkit_defaults() {
        let plan = plan(MESA, env(&[]));
        assert_eq!(plan.mode, RendererMode::Native);
        assert!(plan.set.is_empty() && plan.unset.is_empty());
    }

    #[test]
    fn nvidia_on_webkit_without_force_shm_uses_the_legacy_workaround() {
        for webkit in [(2, 43), (2, 42), (2, 40)] {
            let plan = plan(Host { webkit, ..NVIDIA }, env(&[]));
            assert_eq!(plan.mode, RendererMode::Legacy, "{webkit:?}");
            assert!(sets(&plan, "WEBKIT_DISABLE_DMABUF_RENDERER"));
            assert!(sets(&plan, "WEBKIT_DISABLE_COMPOSITING_MODE"));
        }
        assert_eq!(
            plan(
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
            plan(
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
                let plan = plan(NVIDIA, env(&[(var, value)]));
                assert_eq!(plan.mode, RendererMode::Native, "{var}={value:?}");
                assert!(plan.set.is_empty() && plan.unset.is_empty(), "{var}");
            }
        }
    }

    #[test]
    fn override_selects_the_mode_and_clears_conflicting_variables() {
        let user = ("WEBKIT_DISABLE_DMABUF_RENDERER", "1");

        let shm = plan(MESA, env(&[(OVERRIDE_VAR, "SHM"), user]));
        assert_eq!(shm.mode, RendererMode::SharedMemory);
        assert!(shm.unset.contains(&"WEBKIT_DISABLE_DMABUF_RENDERER"));
        assert!(!shm.unset.contains(&"WEBKIT_DMABUF_RENDERER_FORCE_SHM"));

        let legacy = plan(NVIDIA, env(&[(OVERRIDE_VAR, " legacy ")]));
        assert_eq!(legacy.mode, RendererMode::Legacy);
        assert!(!legacy.unset.contains(&"WEBKIT_DISABLE_DMABUF_RENDERER"));
        assert!(legacy.unset.contains(&"WEBKIT_DMABUF_RENDERER_FORCE_SHM"));

        let native = plan(NVIDIA, env(&[(OVERRIDE_VAR, "native"), user]));
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
        let plan = plan(old, env(&[(OVERRIDE_VAR, "shm")]));
        assert_eq!(plan.mode, RendererMode::SharedMemory);
        assert!(plan.reason.contains("ignores FORCE_SHM"), "{}", plan.reason);
    }

    #[test]
    fn unrecognised_override_falls_through_and_is_reported() {
        let plan = plan(NVIDIA, env(&[(OVERRIDE_VAR, "gpu")]));
        assert_eq!(plan.mode, RendererMode::SharedMemory);
        assert!(plan.reason.contains("\"gpu\""), "{}", plan.reason);
        assert_eq!(
            super::plan(NVIDIA, env(&[(OVERRIDE_VAR, "  ")])).mode,
            RendererMode::SharedMemory
        );
    }
}

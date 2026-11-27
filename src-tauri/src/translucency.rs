//! Window translucency (#1757): one setting, each platform's own material.
//!
//! The native side picks the material, because only it knows the OS build:
//! - macOS: NSVisualEffectView vibrancy with the `Sidebar` material (#1733).
//! - Windows 11 22H2+ (build 22523+): acrylic, which `window-vibrancy` draws
//!   with the DWM transient system backdrop. Earlier builds get its legacy
//!   accent-policy acrylic, which lags while a window is dragged or resized,
//!   so they use Mica instead.
//! - Windows 11 before that (build 22000+): Mica.
//!   DWM drops either backdrop when its window deactivates, so translucent
//!   Windows windows keep their frame active (`inactive_backdrop`, #1903).
//! - Windows 10, Linux: no material; the setting is hidden.
//!
//! Every page learns the result from [`init_script`], and the frontend
//! (`src/lib/domain/translucency.ts`) mirrors the rest: the window effects of
//! a material and the legacy settings rule.

use serde_json::Value;
use tauri::utils::config::WindowEffectsConfig;
use tauri::utils::{WindowEffect, WindowEffectState};

#[cfg(target_os = "windows")]
mod inactive_backdrop;
#[cfg(target_os = "windows")]
pub use inactive_backdrop::keep_backdrop_while_inactive;

/// A native window material, named as the frontend names it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Material {
    Vibrancy,
    Acrylic,
    Mica,
}

impl Material {
    pub fn name(self) -> &'static str {
        match self {
            Material::Vibrancy => "vibrancy",
            Material::Acrylic => "acrylic",
            Material::Mica => "mica",
        }
    }

    fn from_name(name: &str) -> Option<Self> {
        [Material::Vibrancy, Material::Acrylic, Material::Mica]
            .into_iter()
            .find(|material| material.name() == name)
    }

    /// Whether this is a Windows DWM system backdrop. Those go solid when the
    /// window deactivates unless the window keeps its frame active (#1903).
    /// macOS vibrancy stays lit through `WindowEffectState::Active` instead.
    pub fn is_windows_backdrop(self) -> bool {
        matches!(self, Material::Acrylic | Material::Mica)
    }
}

/// The URL parameter a JS-created window's material travels in
/// (`WINDOW_MATERIAL_PARAM` in `domain/translucency.ts`).
const WINDOW_MATERIAL_PARAM: &str = "material";

/// The material a JS-created window was built with, as its creator wrote it
/// into the window's URL (`withWindowMaterial`). `None` for an opaque window
/// (`material=none`) and for a URL that names no known material, such as the
/// Rust-built main window's.
pub fn url_material(url: &tauri::Url) -> Option<Material> {
    url.query_pairs()
        .find(|(key, _)| key == WINDOW_MATERIAL_PARAM)
        .and_then(|(_, value)| Material::from_name(&value))
}

/// The macOS window material behind a translucent window (#1733). `Sidebar`,
/// not `UnderWindowBackground`, which looked opaque in dark mode.
/// `tests/domain/translucency.test.ts` reads this constant to keep it equal
/// to the frontend's `MACOS_VIBRANCY_MATERIAL`, so change both together.
pub const MACOS_VIBRANCY_MATERIAL: WindowEffect = WindowEffect::Sidebar;

/// First Windows build whose acrylic uses the DWM system backdrop.
pub const WINDOWS_SYSTEM_BACKDROP_BUILD: u32 = 22523;
/// First Windows 11 build (Mica).
pub const WINDOWS_MICA_BUILD: u32 = 22000;

/// The material a Windows build offers, if any.
pub fn windows_material(build: u32) -> Option<Material> {
    if build >= WINDOWS_SYSTEM_BACKDROP_BUILD {
        Some(Material::Acrylic)
    } else if build >= WINDOWS_MICA_BUILD {
        Some(Material::Mica)
    } else {
        None
    }
}

/// The material this platform offers, if any.
pub fn platform_material() -> Option<Material> {
    #[cfg(target_os = "macos")]
    {
        Some(Material::Vibrancy)
    }
    #[cfg(target_os = "windows")]
    {
        windows_material(windows_version::OsVersion::current().build)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        None
    }
}

/// Whether the user's settings ask for a translucent window. A settings.json
/// the frontend has not migrated yet still carries the pre-#1757 keys, so the
/// first launch after an upgrade reads them the way the migration will
/// (`legacyTranslucency` in `domain/translucency.ts`). Anything but `true`
/// counts as off.
pub fn translucency_enabled(settings: Option<&Value>) -> bool {
    let Some(settings) = settings else {
        return false;
    };
    match settings.get("translucency") {
        Some(value) => value.as_bool() == Some(true),
        None => legacy_enabled(settings),
    }
}

fn legacy_enabled(settings: &Value) -> bool {
    settings.get("macOsVibrancy").and_then(Value::as_bool) == Some(true)
        || matches!(
            settings.get("windowsBackdrop").and_then(Value::as_str),
            Some("mica" | "acrylic")
        )
}

/// The window effects that draw a material.
pub fn effects(material: Material) -> WindowEffectsConfig {
    match material {
        Material::Vibrancy => WindowEffectsConfig {
            effects: vec![MACOS_VIBRANCY_MATERIAL],
            // Keep the material lit while the window is inactive (the JS
            // `MACOS_VIBRANCY_STATE`).
            state: Some(WindowEffectState::Active),
            ..Default::default()
        },
        Material::Acrylic => WindowEffectsConfig {
            effects: vec![WindowEffect::Acrylic],
            ..Default::default()
        },
        Material::Mica => WindowEffectsConfig {
            effects: vec![WindowEffect::Mica],
            ..Default::default()
        },
    }
}

/// Publishes the platform's material to every page, before its scripts run,
/// as `window.__TRANSLUCENCY_MATERIAL__` (a name, or null for none).
pub fn init_script(material: Option<Material>) -> String {
    define_global("__TRANSLUCENCY_MATERIAL__", material)
}

/// Tells one window's page which material that window was built with, as
/// `window.__WINDOW_MATERIAL__` (null for an opaque window). JS-created
/// windows say the same through their URL (`builtWindowMaterial` in
/// `domain/translucency.ts`).
pub fn window_init_script(material: Option<Material>) -> String {
    define_global("__WINDOW_MATERIAL__", material)
}

fn define_global(name: &str, material: Option<Material>) -> String {
    let value = material.map_or("null".to_string(), |m| format!("\"{}\"", m.name()));
    format!("Object.defineProperty(window, '{name}', {{ value: {value} }});")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn windows_builds_pick_their_material() {
        assert_eq!(windows_material(19045), None, "Windows 10");
        assert_eq!(windows_material(22000), Some(Material::Mica));
        assert_eq!(windows_material(22522), Some(Material::Mica));
        assert_eq!(windows_material(22523), Some(Material::Acrylic));
        assert_eq!(windows_material(26100), Some(Material::Acrylic));
    }

    #[test]
    fn the_setting_wins_over_legacy_keys() {
        let on = json!({ "translucency": true, "macOsVibrancy": false });
        let off = json!({ "translucency": false, "windowsBackdrop": "acrylic" });
        assert!(translucency_enabled(Some(&on)));
        assert!(!translucency_enabled(Some(&off)));
    }

    #[test]
    fn unmigrated_settings_read_the_legacy_keys() {
        for (settings, expected) in [
            (json!({ "macOsVibrancy": true }), true),
            (
                json!({ "macOsVibrancy": true, "vibrancyBlur": false }),
                true,
            ),
            (json!({ "windowsBackdrop": "mica" }), true),
            (json!({ "windowsBackdrop": "acrylic" }), true),
            (json!({ "windowsBackdrop": "off" }), false),
            (json!({ "macOsVibrancy": "yes" }), false),
            (json!({}), false),
        ] {
            assert_eq!(
                translucency_enabled(Some(&settings)),
                expected,
                "{settings}"
            );
        }
    }

    #[test]
    fn malformed_or_missing_settings_stay_opaque() {
        assert!(!translucency_enabled(None));
        assert!(!translucency_enabled(Some(
            &json!({ "translucency": "true" })
        )));
        assert!(!translucency_enabled(Some(&json!([true]))));
    }

    #[test]
    fn effects_draw_each_material() {
        let vibrancy = effects(Material::Vibrancy);
        assert_eq!(vibrancy.effects, vec![WindowEffect::Sidebar]);
        assert_eq!(vibrancy.state, Some(WindowEffectState::Active));
        assert_eq!(
            effects(Material::Acrylic).effects,
            vec![WindowEffect::Acrylic]
        );
        assert_eq!(effects(Material::Mica).effects, vec![WindowEffect::Mica]);
    }

    #[test]
    fn the_init_script_publishes_the_material() {
        assert_eq!(
            init_script(Some(Material::Acrylic)),
            "Object.defineProperty(window, '__TRANSLUCENCY_MATERIAL__', { value: \"acrylic\" });"
        );
        assert!(init_script(None).contains("{ value: null }"));
        assert_eq!(
            window_init_script(Some(Material::Vibrancy)),
            "Object.defineProperty(window, '__WINDOW_MATERIAL__', { value: \"vibrancy\" });"
        );
        assert!(window_init_script(None).contains("'__WINDOW_MATERIAL__', { value: null }"));
    }

    fn url(text: &str) -> tauri::Url {
        tauri::Url::parse(text).unwrap()
    }

    #[test]
    fn a_js_window_url_names_its_material() {
        for (text, expected) in [
            (
                "http://tauri.localhost/?path=C%3A%5C&material=acrylic",
                Some(Material::Acrylic),
            ),
            ("tauri://localhost/?material=mica&warm=1", Some(Material::Mica)),
            ("tauri://localhost/?material=vibrancy", Some(Material::Vibrancy)),
        ] {
            assert_eq!(url_material(&url(text)), expected, "{text}");
        }
    }

    #[test]
    fn opaque_unknown_or_unmarked_urls_name_no_material() {
        for text in [
            "tauri://localhost/?material=none",
            "tauri://localhost/index.html",
            "tauri://localhost/?material=",
            "tauri://localhost/?material=Acrylic",
            "tauri://localhost/?materials=acrylic",
            "tauri://localhost/#material=acrylic",
            "tauri://localhost/?path=%2Fhome%2Fmaterial%3Dacrylic",
        ] {
            assert_eq!(url_material(&url(text)), None, "{text}");
        }
    }

    #[test]
    fn only_windows_system_backdrops_need_an_active_frame() {
        assert!(Material::Acrylic.is_windows_backdrop());
        assert!(Material::Mica.is_windows_backdrop());
        assert!(!Material::Vibrancy.is_windows_backdrop());
    }
}

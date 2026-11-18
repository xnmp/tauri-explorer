//! Window translucency (#1757): one setting, each platform's own material.
//!
//! The native side picks the material, because only it knows the OS build:
//! - macOS: NSVisualEffectView vibrancy with the `Sidebar` material (#1733).
//! - Windows 11 22H2+ (build 22523+): acrylic, which `window-vibrancy` draws
//!   with the DWM transient system backdrop. Earlier builds get its legacy
//!   accent-policy acrylic, which lags while a window is dragged or resized,
//!   so they use Mica instead.
//! - Windows 11 before that (build 22000+): Mica.
//! - Windows 10, Linux: no material; the setting is hidden.
//!
//! Every page learns the result from [`init_script`], and the frontend
//! (`src/lib/domain/translucency.ts`) mirrors the rest: the window effects of
//! a material and the legacy settings rule.

use serde_json::Value;
use tauri::utils::config::WindowEffectsConfig;
use tauri::utils::{WindowEffect, WindowEffectState};

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
    let value = material.map_or("null".to_string(), |m| format!("\"{}\"", m.name()));
    format!("Object.defineProperty(window, '__TRANSLUCENCY_MATERIAL__', {{ value: {value} }});")
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
    }
}

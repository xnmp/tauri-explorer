use super::{
    classify_install, clean, display_scale_field, macos_product_version, parse_os_release,
    render_crash_lines, render_log_line, render_report_lines, summarize, windows_version_name,
    EnvironmentField, Install, Probe,
};

fn probe() -> Probe {
    Probe {
        os_name: Some("Arch Linux".into()),
        os: "linux",
        arch: "x86_64",
        webview_engine: "WebKitGTK",
        webview_version: Some("2.48.1".into()),
        ..Probe::default()
    }
}

fn values(fields: &[EnvironmentField]) -> Vec<(&str, &str)> {
    fields.iter().map(|f| (f.label, f.value.as_str())).collect()
}

#[test]
fn summary_names_os_webview_session_and_install() {
    let fields = summarize(&Probe {
        renderer: Some("SharedMemory".into()),
        session_type: Some("wayland".into()),
        desktop: Some("Hyprland".into()),
        install: Install::AppImage,
        ..probe()
    });
    assert_eq!(
        values(&fields),
        [
            ("OS", "Arch Linux (x86_64)"),
            ("Webview", "WebKitGTK 2.48.1"),
            ("Renderer", "SharedMemory"),
            ("Session", "wayland, Hyprland"),
            ("Install", "AppImage"),
        ]
    );
}

#[test]
fn missing_probes_fall_back_without_inventing_values() {
    let fields = summarize(&Probe {
        os_name: Some("   ".into()),
        webview_version: None,
        ..probe()
    });
    assert_eq!(
        values(&fields),
        [
            ("OS", "linux (x86_64)"),
            ("Webview", "WebKitGTK unknown"),
            ("Install", "other location"),
        ]
    );
}

#[test]
fn session_includes_forced_gdk_backend_and_wsl() {
    let fields = summarize(&Probe {
        session_type: Some("x11".into()),
        gdk_backend: Some("x11".into()),
        wsl_distro: Some("Ubuntu".into()),
        ..probe()
    });
    assert!(fields
        .iter()
        .any(|f| f.label == "Session" && f.value == "x11, GDK_BACKEND=x11, WSL (Ubuntu)"));
}

#[test]
fn values_are_single_line_and_bounded() {
    let fields = summarize(&Probe {
        desktop: Some(format!("evil\n- OS: forged\u{7}{}", "x".repeat(10_000))),
        ..probe()
    });
    let session = fields.iter().find(|f| f.label == "Session").unwrap();
    assert!(!session.value.contains('\n'));
    assert!(!session.value.contains('\u{7}'));
    assert!(session.value.chars().count() <= 100);
    assert_eq!(clean("a\t\tb\r\nc"), "a b c");
}

#[test]
fn os_release_prefers_pretty_name_and_unquotes() {
    let text = "NAME=\"Ubuntu\"\nVERSION_ID=\"24.04\"\nPRETTY_NAME=\"Ubuntu 24.04.1 LTS\"\n";
    assert_eq!(
        parse_os_release(text).as_deref(),
        Some("Ubuntu 24.04.1 LTS")
    );
    assert_eq!(
        parse_os_release("NAME='Fedora Linux'\nVERSION_ID=41\n").as_deref(),
        Some("Fedora Linux 41")
    );
    assert_eq!(
        parse_os_release("NAME=\"Say \\\"hi\\\"\"\n").as_deref(),
        Some("Say \"hi\"")
    );
    // Arch has no VERSION_ID.
    assert_eq!(
        parse_os_release("NAME=\"Arch Linux\"\n").as_deref(),
        Some("Arch Linux")
    );
}

#[test]
fn os_release_rejects_empty_and_malformed_input() {
    assert_eq!(parse_os_release(""), None);
    assert_eq!(parse_os_release("garbage without equals\n\0\0"), None);
    assert_eq!(parse_os_release("PRETTY_NAME=\"\"\nNAME=\n"), None);
    let huge = format!("PRETTY_NAME=\"{}\"", "a".repeat(1_000_000));
    assert_eq!(
        parse_os_release(&huge).map(|v| v.chars().count()),
        Some(100)
    );
}

#[test]
fn windows_build_numbers_name_the_release() {
    assert_eq!(
        windows_version_name(Some(22631), Some(4317), Some("23H2")).as_deref(),
        Some("Windows 11 23H2 (build 22631.4317)")
    );
    assert_eq!(
        windows_version_name(Some(19045), None, None).as_deref(),
        Some("Windows 10 (build 19045)")
    );
    assert_eq!(windows_version_name(None, Some(1), Some("23H2")), None);
}

#[test]
fn macos_version_comes_from_system_version_plist() {
    let plist = br#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>ProductName</key><string>macOS</string>
<key>ProductVersion</key><string>15.1.1</string>
</dict></plist>"#;
    assert_eq!(
        macos_product_version(plist).as_deref(),
        Some("macOS 15.1.1")
    );
    assert_eq!(macos_product_version(b"not a plist"), None);
    assert_eq!(macos_product_version(b""), None);
}

#[test]
fn install_classification_never_depends_on_user_names() {
    let none = |_: &str| false;
    let appimage = |key: &str| key == "APPIMAGE";
    let flatpak = |key: &str| key == "FLATPAK_ID";
    type Case<'a> = (&'a str, &'a dyn Fn(&str) -> bool, &'a str, Install);
    let cases: &[Case] = &[
        ("linux", &appimage, "/tmp/.mount_tauriX/usr/bin/tauri-explorer", Install::AppImage),
        ("linux", &flatpak, "/app/bin/tauri-explorer", Install::Flatpak),
        ("linux", &none, "/usr/bin/tauri-explorer", Install::SystemPackage),
        ("linux", &none, "/home/alice/src/te/src-tauri/target/release/tauri-explorer", Install::SourceBuild),
        ("linux", &none, "/home/alice/bin/tauri-explorer", Install::Other),
        ("macos", &none, "/Applications/tauri-explorer.app/Contents/MacOS/tauri-explorer", Install::Applications),
        ("macos", &none, "/Users/alice/Applications/tauri-explorer.app/Contents/MacOS/tauri-explorer", Install::Applications),
        ("macos", &none, "/private/var/folders/x/AppTranslocation/ABC/d/tauri-explorer.app/Contents/MacOS/tauri-explorer", Install::Translocated),
        ("windows", &none, r"C:\Program Files\tauri-explorer\tauri-explorer.exe", Install::WindowsAllUsers),
        ("windows", &none, r"C:\Users\alice\AppData\Local\tauri-explorer\tauri-explorer.exe", Install::WindowsPerUser),
        ("windows", &none, r"C:\src\te\src-tauri\target\x86_64-pc-windows-msvc\release\tauri-explorer.exe", Install::SourceBuild),
        ("windows", &none, r"D:\portable\tauri-explorer.exe", Install::Other),
    ];
    for (os, env, exe, expected) in cases {
        assert_eq!(
            classify_install(os, *env, Some(exe)),
            *expected,
            "{os} {exe}"
        );
    }
    assert_eq!(classify_install("linux", &none, None), Install::Other);
    // The rendered value is a category, not the path.
    let fields = summarize(&Probe {
        install: classify_install("linux", &none, Some("/home/alice/bin/x")),
        ..probe()
    });
    assert!(fields.iter().all(|f| !f.value.contains("alice")));
}

#[test]
fn display_scale_renders_compactly_and_rejects_nonsense() {
    let render = |scale| display_scale_field(scale).map(|f| f.value);
    assert_eq!(render(Some(1.5)).as_deref(), Some("1.5"));
    assert_eq!(render(Some(2.0)).as_deref(), Some("2"));
    assert_eq!(render(Some(1.25)).as_deref(), Some("1.25"));
    assert_eq!(render(Some(f64::NAN)), None);
    assert_eq!(render(Some(0.0)), None);
    assert_eq!(render(Some(1e9)), None);
    assert_eq!(render(None), None);
}

#[test]
fn renderers_emit_report_crash_and_log_forms() {
    let fields = summarize(&Probe {
        install: Install::SystemPackage,
        ..probe()
    });
    assert_eq!(
        render_report_lines("1.25.2", &fields, usize::MAX),
        "- Tauri Explorer: v1.25.2\n- OS: Arch Linux (x86_64)\n- Webview: WebKitGTK 2.48.1\n- Install: system package"
    );
    assert_eq!(
        render_crash_lines(&fields),
        "os: Arch Linux (x86_64)\nwebview: WebKitGTK 2.48.1\ninstall: system package"
    );
    assert_eq!(
        render_log_line(&fields),
        "OS=Arch Linux (x86_64); Webview=WebKitGTK 2.48.1; Install=system package"
    );
}

#[test]
fn report_lines_drop_whole_lines_to_fit_the_budget() {
    let fields = summarize(&Probe {
        install: Install::SystemPackage,
        ..probe()
    });
    let full = render_report_lines("1.25.2", &fields, usize::MAX);
    assert_eq!(render_report_lines("1.25.2", &fields, full.len()), full);
    // One unit short: the longest trailing candidate that no longer fits goes,
    // and no line is ever cut mid-way.
    let short = render_report_lines("1.25.2", &fields, full.len() - 1);
    assert!(short.len() < full.len());
    assert!(short
        .lines()
        .all(|line| full.lines().any(|whole| whole == line)));
    // A shorter later line can still use space a longer one could not.
    let uneven = [
        EnvironmentField {
            label: "OS",
            value: "o".repeat(100),
        },
        EnvironmentField {
            label: "Install",
            value: "AppImage".into(),
        },
    ];
    let skipped = render_report_lines("1.25.2", &uneven, 25 + 1 + 19);
    assert_eq!(skipped, "- Tauri Explorer: v1.25.2\n- Install: AppImage");
    assert_eq!(render_report_lines("1.25.2", &fields, 0), "");
}

/// Smoke test of the real platform adapters on whatever host runs the suite.
#[test]
fn live_probe_reports_every_mandatory_field() {
    let fields = super::summary();
    eprintln!("live environment: {}", render_log_line(fields));
    let labels: Vec<_> = fields.iter().map(|f| f.label).collect();
    for label in ["OS", "Webview", "Install"] {
        assert!(labels.contains(&label), "{label} missing from {labels:?}");
    }
    assert!(fields
        .iter()
        .all(|f| !f.value.is_empty() && !f.value.contains('\n')));
    assert_eq!(super::cached(), Some(fields));
}

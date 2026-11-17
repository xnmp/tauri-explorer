// Hosted-Mac visual capture helpers (#1750). Prints one JSON value.
//   wallpaper <png>   set the desktop picture on every screen, then read it back
//   windows <pid>     CGWindowList entries owned by <pid> (ids for screencapture -l)
//   a11y -            display accommodations that change how materials render
// Evidence tooling for a disposable runner only: it changes the desktop.
import AppKit
import CoreGraphics
import Foundation

func emit(_ value: Any) {
    let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    print(String(decoding: data, as: UTF8.self))
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

let arguments = CommandLine.arguments
guard arguments.count == 3 else { fail("usage: wallpaper <png> | windows <pid> | a11y -") }
_ = NSApplication.shared

switch arguments[1] {
case "wallpaper":
    let url = URL(fileURLWithPath: arguments[2])
    var results: [[String: Any]] = []
    for screen in NSScreen.screens {
        var entry: [String: Any] = ["screen": screen.localizedName]
        do {
            try NSWorkspace.shared.setDesktopImageURL(url, for: screen, options: [
                .imageScaling: NSImageScaling.scaleAxesIndependently.rawValue,
                .allowClipping: true,
            ])
            entry["set"] = true
        } catch {
            entry["set"] = false
            entry["error"] = String(describing: error)
        }
        entry["current"] = NSWorkspace.shared.desktopImageURL(for: screen)?.path ?? NSNull()
        results.append(entry)
    }
    emit(results)
case "windows":
    guard let pid = Int(arguments[2]) else { fail("pid must be an integer") }
    let info = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] ?? []
    let windows: [[String: Any]] = info.compactMap { window in
        guard (window[kCGWindowOwnerPID as String] as? Int) == pid else { return nil }
        let bounds = window[kCGWindowBounds as String] as? [String: Any] ?? [:]
        return [
            "id": window[kCGWindowNumber as String] as? Int ?? -1,
            "layer": window[kCGWindowLayer as String] as? Int ?? -1,
            "onscreen": window[kCGWindowIsOnscreen as String] as? Bool ?? false,
            "alpha": window[kCGWindowAlpha as String] as? Double ?? 0,
            "x": bounds["X"] as? Double ?? 0,
            "y": bounds["Y"] as? Double ?? 0,
            "width": bounds["Width"] as? Double ?? 0,
            "height": bounds["Height"] as? Double ?? 0,
        ]
    }
    emit(windows)
case "a11y":
    // Reduce Transparency makes NSVisualEffectView paint an opaque fallback
    // and matches the page's prefers-reduced-transparency media query.
    let workspace = NSWorkspace.shared
    emit([
        "reduceTransparency": workspace.accessibilityDisplayShouldReduceTransparency,
        "increaseContrast": workspace.accessibilityDisplayShouldIncreaseContrast,
        "reduceMotion": workspace.accessibilityDisplayShouldReduceMotion,
        "differentiateWithoutColor": workspace.accessibilityDisplayShouldDifferentiateWithoutColor,
    ])
default:
    fail("unknown command \(arguments[1])")
}

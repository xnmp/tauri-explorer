import { describe, it, expect } from "vitest";
import { detectViewportZoomCoords, detectChromiumEngine } from "../../src/lib/domain/zoom";

/**
 * The marquee-zoom bug on Windows was an ENGINE misclassification: WebView2
 * (Chromium) reports clientX and getBoundingClientRect in the same post-zoom
 * space as WKWebView, but the old code treated every non-mac engine like
 * WebKitGTK. These tests lock the classifier that distinguishes the regimes.
 */
describe("detectViewportZoomCoords", () => {
  // Representative user-agent strings per engine.
  const UA = {
    webView2:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
    chromeLinux:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    webkitGtk:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15",
    wkWebView:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15",
  };

  it("classifies Windows WebView2 (Chromium) as post-zoom viewport coords", () => {
    expect(detectViewportZoomCoords(UA.webView2, false)).toBe(true);
  });

  it("classifies the Chromium dev browser (on Linux) as post-zoom viewport coords", () => {
    expect(detectViewportZoomCoords(UA.chromeLinux, false)).toBe(true);
  });

  it("classifies WebKitGTK (Tauri Linux webview) as NOT post-zoom (the exception)", () => {
    expect(detectViewportZoomCoords(UA.webkitGtk, false)).toBe(false);
  });

  it("classifies macOS as post-zoom regardless of user agent", () => {
    expect(detectViewportZoomCoords(UA.wkWebView, true)).toBe(true);
    // Even with an empty UA, the isMac flag forces the post-zoom regime.
    expect(detectViewportZoomCoords("", true)).toBe(true);
  });

  /**
   * The context-menu (position:fixed) offset was Windows-only: under root CSS
   * `zoom`, only Chromium needs a single client→CSS division; WebKitGTK and
   * WKWebView (incl. mac) keep the legacy double division. So this classifier
   * must — unlike detectViewportZoomCoords — exclude mac's WKWebView.
   */
  describe("detectChromiumEngine", () => {
    it("is true for Windows WebView2", () => {
      expect(detectChromiumEngine(UA.webView2)).toBe(true);
    });

    it("is true for the Chromium dev browser", () => {
      expect(detectChromiumEngine(UA.chromeLinux)).toBe(true);
    });

    it("is false for WebKitGTK (Tauri Linux webview)", () => {
      expect(detectChromiumEngine(UA.webkitGtk)).toBe(false);
    });

    it("is false for macOS WKWebView (unlike detectViewportZoomCoords)", () => {
      expect(detectChromiumEngine(UA.wkWebView)).toBe(false);
    });
  });
});

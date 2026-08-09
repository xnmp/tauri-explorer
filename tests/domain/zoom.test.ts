import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  detectViewportZoomCoords,
  detectChromiumEngine,
  fixedFromClient,
  fixedFromRect,
  clientToCSSRelative,
  rectDimToCSS,
  cssToRect,
} from "../../src/lib/domain/zoom";

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

  /**
   * Fixed-overlay coordinate calculators. Both convert a target screen
   * coordinate into the value to assign a position:fixed overlay's left/top so
   * it lands where intended under root CSS `zoom`.
   */
  describe("fixedFromClient (cursor-anchored overlays)", () => {
    it("is a no-op at zoom 1", () => {
      expect(fixedFromClient(100, 1, true)).toBe(100);
      expect(fixedFromClient(100, 1, false)).toBe(100);
    });

    it("divides once on Chromium", () => {
      expect(fixedFromClient(100, 2, true)).toBe(50);
    });

    it.each([
      [0.9, 100, 100 / 0.9 ** 2],
      [1.25, 125, 125 / 1.25 ** 2],
    ])(
      "keeps a macOS WKWebView menu under its cursor at %s zoom",
      (zoom, cursorCoord, expectedFixedCoord) => {
        expect(fixedFromClient(cursorCoord, zoom, false)).toBeCloseTo(expectedFixedCoord);
      },
    );
  });

  describe("fixedFromRect (element-anchored overlays)", () => {
    it("is a no-op at zoom 1", () => {
      expect(fixedFromRect(100, 1, true, true)).toBe(100);
      expect(fixedFromRect(100, 1, false, false)).toBe(100);
    });

    it("divides once on Chromium and WebKitGTK", () => {
      expect(fixedFromRect(100, 2, true, true)).toBe(50);
      expect(fixedFromRect(100, 2, false, false)).toBe(50);
    });

    it.each([
      [0.9, 100, 100 / 0.9 ** 2],
      [1.25, 125, 125 / 1.25 ** 2],
    ])(
      "keeps a macOS WKWebView element menu aligned at %s zoom",
      (zoom, rectCoord, expectedFixedCoord) => {
        expect(fixedFromRect(rectCoord, zoom, true, false)).toBeCloseTo(expectedFixedCoord);
      },
    );
  });

  /**
   * Marquee-path conversions (#241). Under standardized CSS zoom, clientX/Y
   * and getBoundingClientRect are BOTH post-zoom viewport px on every engine
   * (incl. WebKitGTK ≥2.44 — the real Tauri Linux webview), so these must be
   * a single division/multiplication with NO engine branch. The old
   * "WebKitGTK reports pre-zoom rects" model is what kept re-breaking the
   * marquee at zoom.
   */
  describe("marquee-path conversions under live zoom", () => {
    const setZoom = (zoom: string) => {
      (globalThis as { document?: unknown }).document = {
        documentElement: { style: { zoom } },
      };
    };

    beforeEach(() => setZoom("200%"));
    afterEach(() => {
      delete (globalThis as { document?: unknown }).document;
    });

    it("clientToCSSRelative subtracts the rect edge then divides once", () => {
      // cursor at viewport 300, container edge at viewport 100, zoom 2
      // → container-relative CSS coordinate (300 - 100) / 2 = 100
      expect(clientToCSSRelative(300, 100)).toBe(100);
    });

    it("rectDimToCSS divides a rect dimension by the zoom", () => {
      expect(rectDimToCSS(400)).toBe(200);
    });

    it("cssToRect is the inverse of rectDimToCSS", () => {
      expect(cssToRect(rectDimToCSS(360))).toBe(360);
      expect(cssToRect(150)).toBe(300);
    });

    it("all three are identity at zoom 1", () => {
      setZoom("");
      expect(clientToCSSRelative(300, 100)).toBe(200);
      expect(rectDimToCSS(400)).toBe(400);
      expect(cssToRect(150)).toBe(150);
    });
  });
});

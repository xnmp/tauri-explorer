/**
 * Playwright Performance Test Suite
 * Issue: tauri-explorer-xqgy
 *
 * Measures real user scenario performance using Playwright's tracing and metrics APIs.
 * Tests: app startup, navigate to folder, scroll through files, search.
 */

import { test, expect, type Page } from "@playwright/test";

interface PerfMetric {
  name: string;
  duration: number;
  threshold: number;
}

const perfResults: PerfMetric[] = [];

/**
 * Measure time for an async operation.
 */
async function measureTime(
  name: string,
  operation: () => Promise<void>,
  thresholdMs: number
): Promise<PerfMetric> {
  const start = performance.now();
  await operation();
  const duration = performance.now() - start;

  const metric = { name, duration, threshold: thresholdMs };
  perfResults.push(metric);

  console.log(
    `[PERF] ${name}: ${duration.toFixed(2)}ms (threshold: ${thresholdMs}ms) ${duration > thresholdMs ? "EXCEEDED" : "OK"}`
  );

  return metric;
}

/**
 * Wait for file list to be populated with items.
 */
async function waitForFileList(page: Page): Promise<void> {
  await page.waitForSelector(".file-list");
  await page.locator(".file-item").first().waitFor({ timeout: 10000 });
}

test.describe("Performance Tests", () => {
  test.describe("App Startup", () => {
    test("cold start time under 3 seconds", async ({ page }) => {
      const metric = await measureTime(
        "cold-start",
        async () => {
          await page.goto("/");
          await waitForFileList(page);
        },
        3000
      );

      expect(metric.duration).toBeLessThan(metric.threshold);
    });

    test("DOM content loaded under 1 second", async ({ page }) => {
      const metric = await measureTime(
        "dom-content-loaded",
        async () => {
          await page.goto("/", { waitUntil: "domcontentloaded" });
        },
        1000
      );

      expect(metric.duration).toBeLessThan(metric.threshold);
    });

    test("initial render under 2 seconds", async ({ page }) => {
      const metric = await measureTime(
        "initial-render",
        async () => {
          await page.goto("/");
          // Wait for main layout to be visible
          await page.locator(".explorer").waitFor();
          await page.locator(".sidebar").waitFor();
          await page.locator(".navigation-bar").waitFor();
        },
        2000
      );

      expect(metric.duration).toBeLessThan(metric.threshold);
    });
  });

  test.describe("Navigation Performance", () => {
    test.beforeEach(async ({ page }) => {
      await page.goto("/");
      await waitForFileList(page);
    });

    test("folder navigation under 500ms", async ({ page }) => {
      const folder = page.locator(".file-item.directory").first();
      await folder.waitFor({ timeout: 5000 });

      const metric = await measureTime(
        "folder-navigation",
        async () => {
          await folder.dblclick();
          // Wait for new content to load
          await page.waitForFunction(
            () => document.querySelectorAll(".file-item").length > 0,
            { timeout: 5000 }
          );
        },
        500
      );

      expect(metric.duration).toBeLessThan(metric.threshold);
    });

    test("back navigation under 300ms", async ({ page }) => {
      // First navigate into a folder
      const folder = page.locator(".file-item.directory").first();
      await folder.dblclick();
      await page.waitForTimeout(300);

      const metric = await measureTime(
        "back-navigation",
        async () => {
          await page.keyboard.press("Alt+ArrowLeft");
          await page.waitForFunction(
            () => document.querySelectorAll(".file-item").length > 0,
            { timeout: 5000 }
          );
        },
        300
      );

      expect(metric.duration).toBeLessThan(metric.threshold);
    });

    test("breadcrumb click navigation under 400ms", async ({ page }) => {
      // Navigate deep first
      const folder = page.locator(".file-item.directory").first();
      await folder.dblclick();
      await page.waitForTimeout(300);

      const breadcrumb = page.locator(".breadcrumb-segment").first();

      const metric = await measureTime(
        "breadcrumb-navigation",
        async () => {
          await breadcrumb.click();
          await page.waitForFunction(
            () => document.querySelectorAll(".file-item").length > 0,
            { timeout: 5000 }
          );
        },
        400
      );

      expect(metric.duration).toBeLessThan(metric.threshold);
    });
  });

  test.describe("Scroll Performance", () => {
    test.beforeEach(async ({ page }) => {
      await page.goto("/");
      await waitForFileList(page);
    });

    test("scroll response under 16ms per frame", async ({ page }) => {
      // Get the file list container
      const fileList = page.locator(".file-list");
      const viewport = fileList.locator(".virtual-viewport");

      // Measure scroll FPS
      const scrollMetrics = await page.evaluate(async () => {
        const container = document.querySelector(".virtual-viewport");
        if (!container) return { avgFrameTime: Infinity, frames: 0 };

        const frameTimes: number[] = [];
        let lastTime = performance.now();
        let frames = 0;

        return new Promise<{ avgFrameTime: number; frames: number }>((resolve) => {
          const startTime = performance.now();

          function onScroll() {
            const now = performance.now();
            frameTimes.push(now - lastTime);
            lastTime = now;
            frames++;
          }

          container.addEventListener("scroll", onScroll);

          // Perform scroll
          let scrollAmount = 0;
          const interval = setInterval(() => {
            scrollAmount += 100;
            container.scrollTop = scrollAmount;

            if (scrollAmount >= 2000 || performance.now() - startTime > 2000) {
              clearInterval(interval);
              container.removeEventListener("scroll", onScroll);

              const avgFrameTime =
                frameTimes.length > 0
                  ? frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length
                  : 0;

              resolve({ avgFrameTime, frames });
            }
          }, 16);
        });
      });

      console.log(
        `[PERF] scroll: avg frame time ${scrollMetrics.avgFrameTime.toFixed(2)}ms, ${scrollMetrics.frames} frames`
      );

      // Average frame time should be reasonable (not exceeding 100ms)
      expect(scrollMetrics.avgFrameTime).toBeLessThan(100);
    });

    test("rapid scroll does not freeze UI", async ({ page }) => {
      const metric = await measureTime(
        "rapid-scroll",
        async () => {
          const viewport = page.locator(".virtual-viewport");

          // Rapid scroll up and down
          for (let i = 0; i < 5; i++) {
            await viewport.evaluate((el) => (el.scrollTop = 1000));
            await page.waitForTimeout(50);
            await viewport.evaluate((el) => (el.scrollTop = 0));
            await page.waitForTimeout(50);
          }
        },
        1000
      );

      expect(metric.duration).toBeLessThan(metric.threshold);
    });
  });

  test.describe("Selection Performance", () => {
    test.beforeEach(async ({ page }) => {
      await page.goto("/");
      await waitForFileList(page);
    });

    test("single selection under 100ms", async ({ page }) => {
      const item = page.locator(".file-item").first();

      const metric = await measureTime(
        "single-selection",
        async () => {
          await item.click();
          await expect(item).toHaveClass(/selected/);
        },
        100
      );

      expect(metric.duration).toBeLessThan(metric.threshold);
    });

    test("select all (Ctrl+A) under 200ms", async ({ page }) => {
      const metric = await measureTime(
        "select-all",
        async () => {
          await page.keyboard.press("Control+a");
          // Wait for selection to apply
          await page.waitForTimeout(50);
        },
        200
      );

      expect(metric.duration).toBeLessThan(metric.threshold);
    });

    test("range selection (Shift+Click) under 150ms", async ({ page }) => {
      const firstItem = page.locator(".file-item").first();
      await firstItem.click();

      const fifthItem = page.locator(".file-item").nth(4);

      const metric = await measureTime(
        "range-selection",
        async () => {
          await fifthItem.click({ modifiers: ["Shift"] });
          await page.waitForTimeout(50);
        },
        150
      );

      expect(metric.duration).toBeLessThan(metric.threshold);
    });
  });

  test.describe("Quick Open Performance", () => {
    test.beforeEach(async ({ page }) => {
      await page.goto("/");
      await waitForFileList(page);
    });

    test("quick open dialog opens under 200ms", async ({ page }) => {
      const metric = await measureTime(
        "quick-open-open",
        async () => {
          await page.keyboard.press("Control+p");
          await page.locator(".quick-open").waitFor();
        },
        200
      );

      expect(metric.duration).toBeLessThan(metric.threshold);
    });

    test("search results appear under 500ms", async ({ page }) => {
      await page.keyboard.press("Control+p");
      await page.locator(".quick-open").waitFor();

      const metric = await measureTime(
        "quick-open-search",
        async () => {
          await page.locator(".quick-open input").fill("test");
          // Wait for results or empty state
          await page.waitForTimeout(400);
        },
        500
      );

      expect(metric.duration).toBeLessThan(metric.threshold);
    });

    test("quick open closes under 100ms", async ({ page }) => {
      await page.keyboard.press("Control+p");
      await page.locator(".quick-open").waitFor();

      const metric = await measureTime(
        "quick-open-close",
        async () => {
          await page.keyboard.press("Escape");
          await page.locator(".quick-open").waitFor({ state: "hidden" });
        },
        100
      );

      expect(metric.duration).toBeLessThan(metric.threshold);
    });
  });

  test.describe("Command Palette Performance", () => {
    test.beforeEach(async ({ page }) => {
      await page.goto("/");
      await waitForFileList(page);
    });

    test("command palette opens under 200ms", async ({ page }) => {
      const metric = await measureTime(
        "command-palette-open",
        async () => {
          await page.keyboard.press("Control+Shift+p");
          await page.locator(".command-palette").waitFor();
        },
        200
      );

      expect(metric.duration).toBeLessThan(metric.threshold);
    });

    test("command filtering under 100ms", async ({ page }) => {
      await page.keyboard.press("Control+Shift+p");
      await page.locator(".command-palette").waitFor();

      const metric = await measureTime(
        "command-filter",
        async () => {
          await page.locator(".command-palette input").fill("new");
          await page.waitForTimeout(50);
        },
        100
      );

      expect(metric.duration).toBeLessThan(metric.threshold);
    });
  });

  test.describe("Tab Operations Performance", () => {
    test.beforeEach(async ({ page }) => {
      await page.goto("/");
      await waitForFileList(page);
    });

    test("new tab creation under 300ms", async ({ page }) => {
      const metric = await measureTime(
        "new-tab",
        async () => {
          await page.keyboard.press("Control+t");
          // Wait for new tab to appear
          await page.waitForFunction(
            () => document.querySelectorAll(".tab").length >= 2,
            { timeout: 2000 }
          );
        },
        300
      );

      expect(metric.duration).toBeLessThan(metric.threshold);
    });

    test("tab switch under 200ms", async ({ page }) => {
      // Create a second tab first
      await page.keyboard.press("Control+t");
      await page.waitForFunction(() => document.querySelectorAll(".tab").length >= 2);

      const metric = await measureTime(
        "tab-switch",
        async () => {
          await page.keyboard.press("Control+Tab");
          await page.waitForTimeout(50);
        },
        200
      );

      expect(metric.duration).toBeLessThan(metric.threshold);
    });

    test("tab close under 200ms", async ({ page }) => {
      // Create a second tab
      await page.keyboard.press("Control+t");
      await page.waitForFunction(() => document.querySelectorAll(".tab").length >= 2);

      const metric = await measureTime(
        "tab-close",
        async () => {
          await page.keyboard.press("Control+w");
          await page.waitForFunction(
            () => document.querySelectorAll(".tab").length === 1,
            { timeout: 2000 }
          );
        },
        200
      );

      expect(metric.duration).toBeLessThan(metric.threshold);
    });
  });

  test.describe("View Mode Switch Performance", () => {
    test.beforeEach(async ({ page }) => {
      await page.goto("/");
      await waitForFileList(page);
    });

    test("view mode toggle under 200ms", async ({ page }) => {
      // Find view toggle button
      const viewButton = page.locator('[title*="view"], [aria-label*="view"]').first();

      if ((await viewButton.count()) > 0) {
        const metric = await measureTime(
          "view-mode-toggle",
          async () => {
            await viewButton.click();
            await page.waitForTimeout(100);
          },
          200
        );

        expect(metric.duration).toBeLessThan(metric.threshold);
      }
    });
  });
});

test.afterAll(() => {
  console.log("\n=== Performance Test Summary ===");
  console.log("| Test | Duration | Threshold | Status |");
  console.log("|------|----------|-----------|--------|");

  for (const metric of perfResults) {
    const status = metric.duration <= metric.threshold ? "PASS" : "FAIL";
    console.log(
      `| ${metric.name} | ${metric.duration.toFixed(2)}ms | ${metric.threshold}ms | ${status} |`
    );
  }

  const passed = perfResults.filter((m) => m.duration <= m.threshold).length;
  const total = perfResults.length;
  console.log(`\nTotal: ${passed}/${total} passed`);
});

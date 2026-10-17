/**
 * Interaction perf sweep (#1174): a report, not a budget gate.
 *
 * Measures the main interactions (startup, folder open, scroll, keyboard and
 * marquee selection, tab switching, preview walks, Quick Open) under 4x CPU
 * throttling and prints medians; `PERF_SWEEP_OUT=<file>` also writes them as
 * JSON. The spec imports nothing app-specific beyond the e2e fixtures, so this
 * directory and its config can be copied into a `git archive` of an older
 * release (with its own `bun install`) to record a baseline:
 *
 *   PERF_SWEEP_OUT=/tmp/head.json bun run perf:sweep
 *
 * Absolute headless timings only mean something relative to a baseline run on
 * the same machine at the same time (docs/lessons/1174-keydown-availability-cost.md):
 * compare `taskMs` (renderer main-thread time), not wall time.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { CDPSession } from "@playwright/test";
import { test, type Page } from "../e2e/fixtures";

test.setTimeout(240_000);

const RUNS = Number(process.env.PERF_SWEEP_RUNS ?? 5);
const HUGE = "/perf/huge-5000";

interface Sample {
  wallMs: number;
  /** Sum of long-task time (>50ms tasks) observed during the interaction. */
  longTaskMs: number;
  /** Worst gap between consecutive animation frames. */
  worstFrameMs: number;
  /** Renderer main-thread task time (CDP `TaskDuration`): robust to driver round-trip noise. */
  taskMs: number;
}

const results: Record<string, Sample[]> = {};
const sessions = new WeakMap<Page, CDPSession>();

async function taskSeconds(page: Page): Promise<number> {
  const { metrics } = await sessions.get(page)!.send("Performance.getMetrics");
  return metrics.find((m: { name: string }) => m.name === "TaskDuration")?.value ?? 0;
}

declare global {
  interface Window {
    __sweep: { longTasks: { start: number; duration: number }[]; frames: number[] };
  }
}

async function prepare(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const sweep = { longTasks: [] as { start: number; duration: number }[], frames: [] as number[] };
    window.__sweep = sweep;
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) sweep.longTasks.push({ start: entry.startTime, duration: entry.duration });
      }).observe({ type: "longtask", buffered: true });
    } catch {
      /* longtask unsupported */
    }
    const tick = (t: number) => {
      sweep.frames.push(t);
      if (sweep.frames.length > 20_000) sweep.frames.splice(0, 10_000);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await cdp.send("Performance.enable");
  sessions.set(page, cdp);
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
}

/** Runs `action` (which must await its own completion signal) and records a sample. */
async function measure(page: Page, name: string, action: () => Promise<void>): Promise<void> {
  await settle(page);
  const taskStart = await taskSeconds(page);
  const start = await page.evaluate(() => performance.now());
  await action();
  await settle(page);
  const taskMs = ((await taskSeconds(page)) - taskStart) * 1000;
  const sample = await page.evaluate((from) => {
    const end = performance.now();
    const { longTasks, frames } = window.__sweep;
    const longTaskMs = longTasks
      .filter((t) => t.start + t.duration > from && t.start < end)
      .reduce((sum, t) => sum + t.duration, 0);
    let worstFrameMs = 0;
    const inWindow = frames.filter((f) => f >= from && f <= end);
    for (let i = 1; i < inWindow.length; i++) worstFrameMs = Math.max(worstFrameMs, inWindow[i] - inWindow[i - 1]);
    return { wallMs: end - from, longTaskMs, worstFrameMs };
  }, start);
  (results[name] ??= []).push({ ...sample, taskMs });
}

async function waitForRows(page: Page, text?: string): Promise<void> {
  // `:visible`: recently active tabs stay mounted but hidden (#1173).
  const rows = page.locator(".entry-item:visible");
  await (text ? rows.filter({ hasText: text }).first() : rows.first()).waitFor({ timeout: 30_000 });
}

async function openPath(page: Page, path: string): Promise<void> {
  await page.keyboard.press("Control+l");
  const input = page.locator(".path-input").first();
  await input.waitFor();
  await input.fill(path);
  await input.press("Enter");
}

test.afterAll(() => {
  const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  const summary = Object.fromEntries(
    Object.entries(results).map(([name, samples]) => [
      name,
      {
        runs: samples.length,
        wallMs: Math.round(median(samples.map((s) => s.wallMs))),
        longTaskMs: Math.round(median(samples.map((s) => s.longTaskMs))),
        worstFrameMs: Math.round(median(samples.map((s) => s.worstFrameMs))),
        taskMs: Math.round(median(samples.map((s) => s.taskMs))),
      },
    ]),
  );
  console.log(JSON.stringify(summary, null, 2));
  const out = process.env.PERF_SWEEP_OUT;
  if (!out) return;
  // A failed test restarts the worker; merge so earlier tests' results survive.
  const previous = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : {};
  writeFileSync(out, JSON.stringify({ ...previous, ...summary }, null, 2));
});

test("startup", async ({ page }) => {
  await prepare(page);
  for (let i = 0; i < RUNS; i++) {
    for (const [name, path] of [
      ["startup: home to first row", "/home/user"],
      ["startup: 5000-entry folder to first row", HUGE],
    ] as const) {
      const taskStart = await taskSeconds(page);
      await page.goto(`/?path=${path}`);
      await waitForRows(page);
      await settle(page);
      const taskMs = ((await taskSeconds(page)) - taskStart) * 1000;
      const sample = await page.evaluate(() => {
        const { longTasks } = window.__sweep;
        const now = performance.now();
        return {
          wallMs: now,
          longTaskMs: longTasks.reduce((sum, t) => sum + t.duration, 0),
          worstFrameMs: Math.max(0, ...longTasks.map((t) => t.duration)),
        };
      });
      (results[name] ??= []).push({ ...sample, taskMs });
    }
  }
});

test("folder loading", async ({ page }) => {
  await prepare(page);
  await page.goto("/?path=/home/user");
  await waitForRows(page, "Documents");
  for (let i = 0; i < RUNS; i++) {
    await measure(page, "folder: open small folder (dblclick)", async () => {
      await page.locator(".entry-item").filter({ hasText: "Documents" }).first().dblclick();
      await waitForRows(page, "notes.md");
    });
    await measure(page, "folder: address bar to small parent", async () => {
      await openPath(page, "/home/user");
      await waitForRows(page, "Documents");
    });
    await measure(page, "folder: open 5000-entry folder", async () => {
      await openPath(page, HUGE);
      await waitForRows(page, "folder-00000");
    });
    await measure(page, "folder: leave 5000-entry folder", async () => {
      await openPath(page, "/home/user");
      await waitForRows(page, "Documents");
    });
  }
});

test("scroll and selection in a 5000-entry folder", async ({ page }) => {
  await prepare(page);
  await page.goto(`/?path=${HUGE}`);
  await waitForRows(page);
  const viewport = page.locator(".virtual-viewport").first();
  const box = (await viewport.boundingBox())!;
  for (let i = 0; i < RUNS; i++) {
    await measure(page, "scroll: 30 wheel ticks", async () => {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      for (let j = 0; j < 30; j++) {
        await page.mouse.wheel(0, i % 2 ? -300 : 300);
        await page.waitForTimeout(16);
      }
    });
    await measure(page, "scroll: jump to end and home", async () => {
      await viewport.evaluate((el) => (el.scrollTop = el.scrollHeight));
      await settle(page);
      await viewport.evaluate((el) => (el.scrollTop = 0));
    });
  }
  await page.locator(".entry-item").first().click();
  for (let i = 0; i < RUNS; i++) {
    await measure(page, "select: 20x ArrowDown", async () => {
      for (let j = 0; j < 20; j++) await page.keyboard.press(i % 2 ? "ArrowUp" : "ArrowDown");
    });
    await measure(page, "select: Ctrl+A then click", async () => {
      await page.keyboard.press("Control+a");
      await page.locator(".entry-item.selected").nth(5).waitFor();
      await page.locator(".entry-item").nth(3).click();
    });
  }
});

test("marquee selection", async ({ page }) => {
  await prepare(page);
  await page.goto("/?path=/home/user");
  await waitForRows(page, "Documents");
  const viewport = page.locator(".virtual-viewport").first();
  const box = (await viewport.boundingBox())!;
  // `:visible`: recently active tabs stay mounted but hidden (#1173).
  const rows = page.locator(".entry-item:visible");
  const last = (await rows.last().boundingBox())!;
  const startY = Math.min(box.y + box.height - 10, last.y + last.height + 40);
  for (let i = 0; i < RUNS; i++) {
    await measure(page, "marquee: drag across all rows (40 moves)", async () => {
      await page.mouse.move(box.x + box.width - 30, startY);
      await page.mouse.down();
      await page.mouse.move(box.x + 40, box.y + 5, { steps: 40 });
      await page.mouse.up();
    });
    await page.keyboard.press("Escape");
  }
});

test("tab switching", async ({ page }) => {
  await prepare(page);
  await page.goto(`/?path=${HUGE}`);
  await waitForRows(page);
  await page.keyboard.press("Control+t");
  await page.waitForTimeout(500);
  await page.keyboard.press("Control+t");
  await page.waitForTimeout(500);
  for (let i = 0; i < RUNS; i++) {
    await measure(page, "tabs: 9x Ctrl+Tab across 3 tabs", async () => {
      for (let j = 0; j < 9; j++) {
        await page.keyboard.press("Control+Tab");
        await waitForRows(page);
      }
    });
  }
});

async function walkPreviews(page: Page, folder: string, first: string, steps: number, name: string): Promise<void> {
  await page.goto(`/?path=${folder}`);
  await waitForRows(page, first);
  await page.locator(".entry-item").filter({ hasText: first }).first().click();
  if (!(await page.locator(".preview-pane").isVisible())) await page.keyboard.press(" ");
  const title = page.locator(".preview-pane .preview-filename").first();
  await title.filter({ hasText: first }).waitFor({ timeout: 15_000 });
  const step = async (key: string) => {
    const before = await title.textContent();
    await page.keyboard.press(key);
    await page.waitForFunction(
      (prev) => document.querySelector(".preview-pane .preview-filename")?.textContent !== prev,
      before,
      { timeout: 15_000 },
    );
  };
  for (let i = 0; i < RUNS; i++) {
    await measure(page, name, async () => {
      for (let j = 0; j < steps; j++) await step("ArrowDown");
      for (let j = 0; j < steps; j++) await step("ArrowUp");
    });
  }
}

test("preview walks", async ({ page }) => {
  await prepare(page);
  await walkPreviews(page, "/home/user/Pictures", "photo1.jpg", 2, "preview: images");
  await walkPreviews(page, "/home/user/Documents", "budget.xlsx", 3, "preview: pdf/office/markdown");
  await walkPreviews(page, "/home/user/Videos", "recording.mp4", 2, "preview: video/audio");
  await walkPreviews(page, HUGE, "folder-00000", 6, "preview: 5000-entry folder (folders)");
});

test("quick open", async ({ page }) => {
  await prepare(page);
  await page.goto("/?path=/home/user");
  await waitForRows(page);
  for (let i = 0; i < RUNS; i++) {
    await measure(page, "quick open: open dialog", async () => {
      await page.keyboard.press("Control+p");
      await page.locator(".quick-open-dialog input").waitFor();
    });
    await measure(page, "quick open: type 'report' to result", async () => {
      await page.keyboard.type("report", { delay: 20 });
      await page.locator(".quick-open-dialog .result-item").filter({ hasText: "report" }).first().waitFor({ timeout: 15_000 });
    });
    await page.keyboard.press("Escape");
    await page.locator(".quick-open-dialog").waitFor({ state: "hidden" });
  }
});

test("List column flow: 10,000 entries", async ({ page }) => {
  await prepare(page);
  for (let i = 0; i < RUNS; i++) {
    // Keep startup/scroll/reveal workloads identical across repeated samples.
    await page.setViewportSize({ width: 1280, height: 800 });
    await settle(page);
    const taskStart = await taskSeconds(page);
    await page.goto('/?path=/perf/huge-10000&viewMode=list');
    await waitForRows(page);
    await settle(page);
    const taskMs = ((await taskSeconds(page)) - taskStart) * 1000;
    const startup = await page.evaluate(() => {
      const { longTasks, frames } = window.__sweep;
      const gaps = frames.slice(1).map((frame, index) => frame - frames[index]);
      return {
        wallMs: performance.now(),
        longTaskMs: longTasks.reduce((sum, task) => sum + task.duration, 0),
        worstFrameMs: Math.max(0, ...gaps),
      };
    });
    (results['list: 10000-entry startup'] ??= []).push({...startup,taskMs});
    const viewport = page.locator('.pane-tree:not(.retained) .list-scroller');
    await measure(page,'list: sustained sideways wheel',async () => {
      await viewport.evaluate(el => new Promise<void>(resolve => {
        let n = 0;
        const next = () => {
          el.dispatchEvent(new WheelEvent('wheel',{deltaY:180,bubbles:true,cancelable:true}));
          if (++n === 30) resolve(); else requestAnimationFrame(next);
        };
        requestAnimationFrame(next);
      }));
    });
    await viewport.focus();
    await measure(page,'list: distant reveal',async () => {
      await page.keyboard.press('End');
      await page.locator('.list-item[data-index="9999"]').waitFor();
    });
    await measure(page,'list: R-changing resize',async () => {
      await page.setViewportSize({width:1280,height:500});
      await settle(page);
    });
    await measure(page,'list: scroll back',async () => {
      await viewport.evaluate(el => { el.scrollLeft=0; });
      await page.locator('.list-item[data-index="0"]').waitFor();
    });
    // List cards (#1240): a user toggle of a 5,000-row folder, including its
    // listing and the ~200ms conveyor motion, until no ghost or motion style remains.
    const caret = page.locator('.pane-tree:not(.retained) .entry-item[data-path="/perf/huge-10000/folder-00016"] .peek-caret');
    const motionDone = () => page.waitForFunction(() => {
      const pane = document.querySelector('.pane-tree:not(.retained)')!;
      return pane.querySelector('.list-motion-layer')!.childElementCount === 0
        && ![...pane.querySelectorAll<HTMLElement>('.list-slot')].some(el => el.style.transform);
    });
    await measure(page,'list: open 5,000-row card',async () => {
      await caret.click();
      await page.locator('.pane-tree:not(.retained) [data-card-scroll] .entry-item').first().waitFor();
      await motionDone();
    });
    await measure(page,'list: close card',async () => {
      await caret.click();
      await page.locator('.pane-tree:not(.retained) [data-card-scroll]').waitFor({ state: 'detached' });
      await motionDone();
    });
  }
});

test("Tiles panels: 10,000 entries", async ({ page }) => {
  await prepare(page);
  const pane = '.pane-tree:not(.retained)';
  const scroller = page.locator(`${pane} .tiles-scroller`);
  // Older releases ignore the unknown key, so a baseline checkout still runs the classic case.
  const folderPeek = (on: boolean) => page.evaluate(async value => {
    const { settingsStore } = await import('/src/lib/state/settings.svelte.ts');
    settingsStore.update({ folderPeek: value });
  }, on);
  // The same 30 frames of programmatic scrolling for every case, so their task time compares.
  const scrollFrames = () => scroller.evaluate(el => new Promise<void>(resolve => {
    let n = 0;
    const next = () => {
      el.scrollTop += 300;
      if (++n === 30) resolve(); else requestAnimationFrame(next);
    };
    requestAnimationFrame(next);
  }));
  const home = async () => { await scroller.evaluate(el => { el.scrollTop = 0; }); await settle(page); };
  const motionDone = () => page.waitForFunction(selector => {
    const root = document.querySelector(selector)!;
    return !root.querySelector('.tile-panel-ghost')
      && ![...root.querySelectorAll<HTMLElement>('.tile-panel')].some(el => el.style.opacity);
  }, pane);
  const caret = page.locator(`${pane} .tile-row .entry-item[data-path="/perf/huge-10000/folder-00016"] .peek-caret`);
  const classic = async () => {
    await folderPeek(false);
    await page.locator(`${pane} .tiles-view:not(.tile-panels-view)`).waitFor();
    await home();
    await measure(page, 'tiles: 30 scroll frames (Folder Peek off)', scrollFrames);
  };
  const peek = async () => {
    await folderPeek(true);
    await page.locator(`${pane} .tile-panels-view`).waitFor();
    await home();
    await measure(page, 'tiles: 30 scroll frames (no panel)', scrollFrames);
    await home();
    // A user toggle of a 5,000-entry folder, including its listing and the
    // 150ms band motion, until no ghost or motion opacity remains.
    await measure(page, 'tiles: open 5,000-entry panel', async () => {
      await caret.click();
      await page.locator(`${pane} .tile-panel .entry-item`).first().waitFor();
      await motionDone();
    });
    await measure(page, 'tiles: 30 scroll frames (panel open)', scrollFrames);
    await home();
    await measure(page, 'tiles: close panel', async () => {
      await caret.click();
      await page.locator(`${pane} .tile-panel`).waitFor({ state: 'detached' });
      await motionDone();
    });
  };
  for (let i = 0; i < RUNS; i++) {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/?path=/perf/huge-10000&viewMode=tiles');
    await waitForRows(page);
    // Alternate which renderer runs first: the first case on a fresh page runs
    // markedly slower (warm-up), and always measuring classic first charged
    // that to classic alone, understating the peek renderer's cost.
    if (i % 2 === 0) { await classic(); await peek(); } else { await peek(); await classic(); }
  }
});

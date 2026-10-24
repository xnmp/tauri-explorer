import { test, expect, type Page } from "./fixtures";

async function prepare(page: Page, mode: string, listingDelay = 0) {
  await page.addInitScript(({ mode }) => {
    localStorage.setItem("explorer-settings", JSON.stringify({
      pluginsEnabled: { demo: true }, defaultFileView: "demo.cards", viewMode: mode,
    }));
    // Observe every mounted frame candidate, including brief wrong views that
    // a final locator assertion would miss. The plugin has its own .card rows.
    const wrong: string[] = [];
    (window as any).__wrongFileViewPaints = wrong;
    const record = () => {
      if (document.querySelector(".file-list .content > .details-view, .file-list .content > .list-view, .file-list .content > .tiles-view, .file-list .content > .status .spinner")) wrong.push("builtin");
    };
    new MutationObserver(record).observe(document, { childList: true, subtree: true });
  }, { mode });
  // Browser mock mode has no installed packages. Exercise the production
  // native discovery branch without making all mock IPC pretend to be Tauri.
  await page.route("**/src/lib/state/window-session.ts", async route => {
    const response = await route.fetch();
    const body = await response.text();
    expect(body).toContain("!options.picker && isTauri()");
    await route.fulfill({ response, body: body.replace("!options.picker && isTauri()", "!options.picker") });
  });
  // Freeze the eligibility deadline; independently control listing latency.
  // Non-listing IPC is immediate: otherwise
  // asynchronously imported IPC modules can schedule their 10ms timer after
  // runFor finishes and strand initial navigation on the frozen clock.
  await page.route("**/src/lib/api/mock-dispatch.ts", async route => {
    const response = await route.fetch();
    const body = await response.text();
    expect(body).toContain("setTimeout(resolve, 10)");
    await route.fulfill({ response, body: body.replace("await new Promise((resolve) => setTimeout(resolve, 10));", `if (cmd === "list_directory" || cmd === "list_directory_fresh") { window.__listingStarted = true; ${listingDelay ? `await new Promise(resolve => setTimeout(resolve, ${listingDelay}));` : "await Promise.resolve();"} } else { await Promise.resolve(); }`) });
  });
  await page.route("**/src/lib/plugins/demo/index.ts", async route => {
    const response = await route.fetch();
    const body = await response.text();
    expect(body).toContain("async activate(ctx)");
    expect(body).toContain("component: DemoFileView,");
    await route.fulfill({ response, body:
      'import * as eligibilityProbe from "/src/test-support/file-view-eligibility.svelte.ts";\n'
      + body.replace("async activate(ctx) {", "async activate(ctx) { await eligibilityProbe.activation;")
        .replace("component: DemoFileView,", "component: DemoFileView, available: eligibilityProbe.available,") });
  });
  const time = new Date("2026-01-01T00:00:00Z");
  await page.clock.install({ time });
  await page.clock.pauseAt(time);
}

async function answer(page: Page, directory: string, value: boolean) {
  await page.evaluate(async ({ directory, value }) => {
    const probe = await import("/src/test-support/file-view-eligibility.svelte.ts");
    probe.answer(directory, value);
  }, { directory, value });
}

async function release(page: Page) {
  await page.evaluate(async () => {
    const probe = await import("/src/test-support/file-view-eligibility.svelte.ts");
    probe.releaseActivation();
  });
  await expect.poll(() => page.evaluate(async () => {
    const { fileViewRegistry } = await import("/src/lib/plugins/file-view-registry.svelte.ts");
    return !!fileViewRegistry.get("demo.cards");
  })).toBe(true);
}

for (const mode of ["details", "list", "tiles"]) {
  test(`startup/new-window URL holds through activation and eligibility in ${mode}`, async ({ page }) => {
    await prepare(page, mode);
    await page.goto("/?path=/home/user&focusAddressBar=1");
    await page.locator(".file-list .content").waitFor();
    await page.clock.runFor(100);
    await page.locator('.file-list .content[data-current-path="/home/user"]').waitFor();
    await expect(page.locator(".file-list .content")).toBeEmpty();
    await release(page);
    await expect(page.locator(".file-list .content")).toBeEmpty();
    if (mode === "details") await page.screenshot({ path: "screenshots/view-eligibility-barrier/pending-neutral.png" });
    await answer(page, "/home/user", true);
    const view = page.getByTestId("demo-file-view");
    await expect(view.locator('.card[data-path="/home/user/readme.txt"]')).toBeVisible();
    if (mode === "details") await page.screenshot({ path: "screenshots/view-eligibility-barrier/eligible-plugin-view.png" });
    expect(await page.evaluate(() => (window as any).__wrongFileViewPaints)).toEqual([]);

    // Navigation re-arms the shared pane barrier without painting old content.
    await view.locator('.card[data-path="/home/user/Documents"]').dblclick();
    await page.clock.runFor(100);
    await page.locator('.file-list .content[data-current-path="/home/user/Documents"]').waitFor();
    await expect(page.locator(".file-list .content")).toBeEmpty();
    await answer(page, "/home/user/Documents", true);
    await expect(view.locator('.card[data-path="/home/user/Documents/project"]')).toBeVisible();
    expect(await page.evaluate(() => (window as any).__wrongFileViewPaints)).toEqual([]);

    // Newly created tabs use the same default and barrier.
    await page.evaluate(async () => {
      const { windowTabsManager } = await import("/src/lib/state/window-tabs.svelte.ts");
      windowTabsManager.createTab("/home/user/Pictures");
    });
    await page.clock.runFor(100);
    await page.locator('.file-list .content[data-current-path="/home/user/Pictures"]').waitFor();
    // The previous tab stays mounted but hidden (#1173); the new tab's pane holds.
    await expect(page.locator('.file-list .content[data-current-path="/home/user/Pictures"]')).toBeEmpty();
    await answer(page, "/home/user/Pictures", true);
    await expect(view.locator('.card[data-path="/home/user/Pictures/screenshot.png"]')).toBeVisible();
    expect(await page.evaluate(() => (window as any).__wrongFileViewPaints)).toEqual([]);
  });
}

test("a never-answering provider falls back at the bound, then switches on a late answer", async ({ page }) => {
  await prepare(page, "details");
  await page.goto("/?path=/home/user");
  await page.locator(".file-list .content").waitFor();
  await page.clock.runFor(100);
  await page.locator('.file-list .content[data-current-path="/home/user"]').waitFor();
  await release(page);
  // Exact boundary/interleaving contracts live in the client fake-timer unit
  // tests. Browser async imports can publish the directory a few ticks later.
  await expect(page.locator(".file-list .content")).toBeEmpty();
  await page.clock.runFor(400);
  await expect(page.locator('.file-list .entry-item[data-path="/home/user/readme.txt"]')).toBeVisible();
  await answer(page, "/home/user", true);
  await expect(page.getByTestId("demo-file-view").locator('.card[data-path="/home/user/readme.txt"]')).toBeVisible();
  await expect(page.locator(".file-list .entry-item")).toHaveCount(0);
});

for (const mode of ["details", "list", "tiles"]) {
  test(`a slow initial listing stays neutral and shares the original deadline in ${mode}`, async ({ page }) => {
    await prepare(page, mode, 250);
    await page.goto("/?path=/home/user");
    await page.locator(".file-list .content").waitFor();
    await expect.poll(() => page.evaluate(() => !!(window as any).__listingStarted)).toBe(true);
    await page.clock.runFor(150);
    await expect(page.locator(".file-list .content")).toBeEmpty();
    expect(await page.evaluate(() => (window as any).__wrongFileViewPaints)).toEqual([]);
    await page.clock.runFor(100);
    await page.locator('.file-list .content[data-current-path="/home/user"]').waitFor();
    await expect(page.locator(".file-list .content")).toBeEmpty();
    await release(page);
    await page.clock.runFor(150);
    await expect(page.locator('.file-list .entry-item[data-path="/home/user/readme.txt"]')).toBeVisible();
  });
}

test("tab remounts retain a timed-out directory's built-in paint", async ({ page }) => {
  await prepare(page, "details");
  await page.goto("/?path=/home/user");
  await page.locator('.file-list .content[data-current-path="/home/user"]').waitFor();
  await release(page);
  await page.clock.runFor(400);
  const row = page.locator('.file-list .entry-item[data-path="/home/user/readme.txt"]');
  await expect(row).toBeVisible();
  const first = await page.evaluate(async () => {
    const { windowTabsManager: tabs } = await import("/src/lib/state/window-tabs.svelte.ts");
    const first = tabs.activeTabId;
    tabs.createTab("/home/user/Pictures");
    return first;
  });
  await page.locator('.file-list .content[data-current-path="/home/user/Pictures"]').waitFor();
  for (let i = 0; i < 3; i++) {
    await page.evaluate(async first => {
      const { windowTabsManager: tabs } = await import("/src/lib/state/window-tabs.svelte.ts");
      tabs.setActiveTab(first!);
    }, first);
    await expect(row).toBeVisible();
    if (i < 2) await page.evaluate(async () => {
      const { windowTabsManager: tabs } = await import("/src/lib/state/window-tabs.svelte.ts");
      tabs.setActiveTab(tabs.tabs.find(tab => tab.id !== tabs.activeTabId)!.id);
    });
  }
});

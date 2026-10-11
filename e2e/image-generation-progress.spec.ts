import { test, expect } from "./fixtures";
import { HOME_URL, waitForEntries } from "./helpers";

test("image generation shows elapsed time and an explicitly estimated progress", async ({ page }) => {
  await page.clock.install();
  await page.goto(HOME_URL);
  await waitForEntries(page);
  await page.evaluate(async () => {
    const { jobsStore } = await import("/src/lib/state/jobs.svelte.ts");
    jobsStore.addJob(1234, "parent_edit.png", "Make it daytime", "openai-image", "image");
  });
  const progress = page.getByRole("region", { name: "Background progress" });
  await expect(progress.getByText(/elapsed/)).toBeVisible();
  await expect(progress.getByRole("progressbar", { name: "Estimated image generation progress" })).toBeVisible();
  await expect(progress.getByText(/^Estimate ·/)).toBeVisible();
  await expect(progress.getByText("Make it daytime", { exact: true })).toBeVisible();
  await page.clock.runFor(61_000);
  await expect(progress.getByText("1m 1s elapsed", {exact:true})).toBeVisible();
  await expect(progress.getByRole("progressbar")).toHaveAttribute("aria-valuenow","50");
  await page.evaluate(async()=>{const {jobsStore}=await import("/src/lib/state/jobs.svelte.ts");jobsStore.completeJob(1234,"/output/parent_edit.png");});
  await expect(progress.getByText("Complete",{exact:true})).toBeVisible();
  await page.clock.runFor(60_000);
  await expect(progress.getByText("1m 1s elapsed",{exact:true})).toBeVisible();
  await expect(progress.getByRole("progressbar")).toHaveCount(0);
});

test("native image estimates use the matching cohort and stay overdue until a result arrives", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-01-01T12:00:00Z") });
  await page.goto(HOME_URL);
  await waitForEntries(page);
  // Exact elapsed-time assertions must not include real runner/rendering delay.
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000));
  await page.evaluate(async () => {
    const { jobsStore } = await import("/src/lib/state/jobs.svelte.ts");
    const now = Date.now();
    const record = (n: number, estimateKey: string, duration?: number) => ({
      jobKey:n.toString(16).padStart(48,"0"), owner:{packageId:"consumer",digest:"a".repeat(64),incarnation:1},
      operationId:`cohort-${n}`,jobId:9000+n,kind:"openai-image",label:`cohort-${n}.png`,originWindow:"main",revision:n,
      createdAtMs:duration === undefined ? now : now-100_000-duration,updatedAtMs:now,
      state:duration === undefined ? "running" as const : "completed" as const,estimateKey,
      ...(duration === undefined ? {} : {settledAtMs:now-100_000,outputPath:`/cohort-${n}.png`,runId:n}),
    });
    const records = [1,2,3].map(n=>record(n,"fast",40_000)).concat([4,5,6].map(n=>record(n,"slow",200_000)),[record(7,"fast")]);
    jobsStore.applyNative(records);
    jobsStore.configureNativeControls({cancel:async()=>{},dismiss:async()=>{},resume:async()=>{}});
    (window as any).completeCohort = () => jobsStore.applyNative([
      ...records.slice(0,6),{...records[6],state:"completed",revision:8,updatedAtMs:Date.now(),settledAtMs:Date.now(),outputPath:"/result.png",runId:7},
    ]);
  });
  const row = page.getByRole("region",{name:"Background progress"}).locator('[data-job-id="9007"]');
  await page.clock.runFor(20_000);
  await expect(row.getByText("Estimate · ~20s remaining",{exact:true})).toBeVisible();
  await page.clock.runFor(25_000);
  await expect(row.getByText("Estimate · longer than usual",{exact:true})).toBeVisible();
  await expect(row.getByRole("progressbar")).toHaveAttribute("aria-valuenow","95");
  await expect(row.getByText("Complete",{exact:true})).toHaveCount(0);
  await row.getByRole("button",{name:"Cancel cohort-7.png"}).click();
  await expect(row.getByText(/cancellation requested/)).toBeVisible();
  await page.evaluate(()=>(window as any).completeCohort());
  await expect(row.getByText("Complete",{exact:true})).toBeVisible();
  await expect(row.getByRole("progressbar")).toHaveCount(0);
  await page.clock.runFor(60_000);
  await expect(row.getByText("45s elapsed",{exact:true})).toBeVisible();
});

for (const width of [1800, 800]) {
  test(`trace pane resizes and persists at ${width}px`, async ({ page }) => {
    await page.setViewportSize({width,height:900});
    await page.goto(HOME_URL);
    await waitForEntries(page);
    await page.evaluate(async () => {
      const {inspectorRegistry} = await import("/src/lib/plugins/inspector-registry.svelte.ts");
      const {default: InstalledPluginSettings} = await import("/src/lib/components/InstalledPluginSettings.svelte");
      inspectorRegistry.register({id:"fixture.trace",title:"Trace",component:InstalledPluginSettings,when:()=>true});
    });
    const handle = page.getByRole("separator",{name:"Resize trace pane"});
    const pane = page.getByRole("complementary",{name:"File inspector"});
    await expect(handle).toHaveAttribute("aria-orientation",width===1800 ? "vertical" : "horizontal");
    const before=(await pane.boundingBox())!;
    const box=(await handle.boundingBox())!;
    const x=box.x+box.width/2,y=box.y+box.height/2;
    await page.mouse.move(x,y);await page.mouse.down();
    await page.mouse.move(x-(width===1800?60:0),y-(width===800?60:0),{steps:4});await page.mouse.up();
    await expect.poll(async()=>{const after=(await pane.boundingBox())!;return width===1800?after.width-before.width:after.height-before.height;}).toBeCloseTo(60,0);
    await handle.focus();await page.keyboard.press(width===1800?"ArrowLeft":"ArrowUp");
    await expect.poll(async()=>{const after=(await pane.boundingBox())!;return width===1800?after.width-before.width:after.height-before.height;}).toBeCloseTo(70,0);
    const saved=await page.evaluate(key=>Number(localStorage.getItem(key)),width===1800?"explorer-inspector-width":"explorer-inspector-height");
    expect(saved).toBeGreaterThan(width===1800?before.width:before.height);
  });
}

test('title-generator settings notify subscribers after persisting reactive section values',async({page})=>{
  await page.goto(HOME_URL);await waitForEntries(page);
  await page.evaluate(async()=>{
    const {createPluginStorage}=await import('/src/lib/plugins/api.ts');
    const {pluginSettingsSections}=await import('/src/lib/plugins/settings-registry.svelte.ts');
    const storage=createPluginStorage('title-generator-contract');
    const notifications: unknown[]=[];
    storage.subscribe?.(value=>notifications.push(value));
    pluginSettingsSections.register('title-generator-contract',{id:'title',title:'Title generator',rows:[{id:'titleGenerator',label:'Title generator',type:'select',default:'codex'}]},storage);
    (window as any).titleStorageContract={storage,notifications,section:pluginSettingsSections.sections.find(section=>section.pluginId==='title-generator-contract')};
    (window as any).titleStorageContract.section.setValue('titleGenerator','disabled');
  });
  await expect.poll(()=>page.evaluate(()=>(window as any).titleStorageContract.notifications)).toEqual([{titleGenerator:'disabled'}]);
  await expect.poll(()=>page.evaluate(async()=>(await (window as any).titleStorageContract.storage.get()).titleGenerator)).toBe('disabled');
});

test("plugin directory observers follow navigation and stop when their context retires", async ({ page }) => {
  await page.goto(HOME_URL);
  await waitForEntries(page);
  await page.evaluate(async () => {
    const { createPluginContext } = await import("/src/lib/plugins/api.ts");
    const { ctx, dispose } = createPluginContext("directory-observer-contract");
    const paths: Array<string | null> = [];
    (window as any).directoryObserverContract = { ctx, dispose, paths };
    ctx.workspace.onDirectoryChanged?.(path => paths.push(path));
  });
  await expect.poll(() => page.evaluate(() => (window as any).directoryObserverContract.paths)).toEqual(["/home/user"]);
  await page.evaluate(() => (window as any).directoryObserverContract.ctx.workspace.navigate("/home/user/Documents"));
  await expect.poll(() => page.evaluate(() => (window as any).directoryObserverContract.paths)).toEqual(["/home/user", "/home/user/Documents"]);
  const before = await page.evaluate(() => {
    const contract = (window as any).directoryObserverContract;
    contract.dispose();
    return [...contract.paths];
  });
  await page.evaluate(() => (window as any).directoryObserverContract.ctx.workspace.navigate("/home/user/Downloads"));
  await expect.poll(() => page.evaluate(async () => {
    const { windowTabsManager } = await import("/src/lib/state/window-tabs.svelte.ts");
    return windowTabsManager.getActiveExplorer()?.currentPath;
  })).toBe("/home/user/Downloads");
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(await page.evaluate(() => (window as any).directoryObserverContract.paths)).toEqual(before);
});

async function publishUnlistedImage(page: import("@playwright/test").Page) {
  await page.goto(HOME_URL);
  await waitForEntries(page);
  await page.locator(".entry-item").filter({ hasText: "readme.txt" }).click();
  await page.evaluate(async () => {
    const { createPluginContext } = await import("/src/lib/plugins/api.ts");
    const { windowTabsManager } = await import("/src/lib/state/window-tabs.svelte.ts");
    const { mockInvoke } = await import("/src/lib/api/mock-invoke.ts");
    const { ctx, dispose } = createPluginContext("published-image-selection-contract");
    const explorer = windowTabsManager.getActiveExplorer()!;
    await mockInvoke("create_empty_file", { parentPath: "/home/user", name: "published.png" });
    (window as any).publishedImageContract = { ctx, dispose, explorer, target: "/home/user/published.png" };
  });
  await expect(page.locator(".entry-item").filter({ hasText: "published.png" })).toHaveCount(0);
}

test("plugin file selection refreshes before revealing a newly published image", async ({ page }) => {
  await publishUnlistedImage(page);
  await page.evaluate(async () => {
    const contract = (window as any).publishedImageContract;
    await contract.ctx.workspace.selectFile(contract.target);
    contract.dispose();
  });
  await expect(page.locator(".entry-item.selected")).toContainText("published.png");
  await expect(page.getByText("This recorded file is no longer present", { exact: true })).toHaveCount(0);
});

test("plugin file selection follows a superseding refresh of the same folder", async ({ page }) => {
  await publishUnlistedImage(page);
  await page.evaluate(async () => {
    const contract = (window as any).publishedImageContract;
    const selecting = contract.ctx.workspace.selectFile(contract.target);
    const refreshing = contract.explorer.refresh({ silent: true });
    await Promise.all([selecting, refreshing]);
    contract.dispose();
  });
  await expect(page.locator(".entry-item.selected")).toContainText("published.png");
  await expect(page.getByText("This recorded file is no longer present", { exact: true })).toHaveCount(0);
});

test("plugin file selection preserves a newer selection made during its refresh", async ({ page }) => {
  await publishUnlistedImage(page);
  await page.evaluate(async () => {
    const contract = (window as any).publishedImageContract;
    const selecting = contract.ctx.workspace.selectFile(contract.target);
    contract.explorer.selectEntry(contract.explorer.state.entries.find((entry: { path: string }) => entry.path === "/home/user/notes.md"));
    await selecting;
    contract.dispose();
  });
  await expect(page.locator(".entry-item.selected")).toContainText("notes.md");
  await expect(page.locator(".entry-item").filter({ hasText: "published.png" })).toBeVisible();
  await expect(page.getByText("This recorded file is no longer present", { exact: true })).toHaveCount(0);
});

test('plugin chord defaults appear in Keyboard Shortcuts and user overrides execute',async({page})=>{
  await page.goto(HOME_URL);await waitForEntries(page);
  await page.evaluate(async()=>{
    const {createPluginContext}=await import('/src/lib/plugins/api.ts');
    const context=createPluginContext('trace-shortcut-contract');
    (window as any).traceShortcutCalls=0;(window as any).traceShortcutContext=context;
    context.ctx.registerCommand({id:'fixture.trace-toggle',label:'Toggle Trace Pane',category:'view',shortcut:'Alt+M P',handler:()=>{(window as any).traceShortcutCalls+=1;}});
  });
  await page.keyboard.press('Alt+m');await page.keyboard.press('p');
  await expect.poll(()=>page.evaluate(()=>(window as any).traceShortcutCalls)).toBe(1);
  await page.keyboard.press('Control+,');await page.getByRole('button',{name:'Open Keyboard Shortcuts',exact:true}).click();
  await page.getByLabel('Search shortcuts').fill('Toggle Trace Pane');
  const row=page.locator('.shortcut-row').filter({hasText:'Toggle Trace Pane'});
  await expect(row.locator('.shortcut-btn')).toContainText('then');
  await row.locator('.shortcut-btn').click();await page.keyboard.press('Control+Alt+y');
  await expect(row.locator('.shortcut-btn')).toContainText('Y');
  await page.getByRole('button',{name:'Close keyboard shortcuts',exact:true}).click();
  await page.keyboard.press('Escape');await page.keyboard.press('Control+Alt+y');
  await expect.poll(()=>page.evaluate(()=>(window as any).traceShortcutCalls)).toBe(2);
  await page.evaluate(()=>(window as any).traceShortcutContext.dispose());
  await page.keyboard.press('Control+Alt+y');
  expect(await page.evaluate(()=>(window as any).traceShortcutCalls)).toBe(2);
});

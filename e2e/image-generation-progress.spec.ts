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
  await expect(progress.getByText(/estimated/)).toBeVisible();
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

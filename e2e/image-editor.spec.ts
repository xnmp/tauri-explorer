import {test,expect} from "./fixtures";
import {applySettingsAndReload,waitForEntries,runPaletteCommand} from "./helpers";

test("the core image editor saves captured crop pixels with no installed editing package",async({page})=>{
  await page.goto("/?path=/home/user/Pictures");
  await applySettingsAndReload(page,{showPreviewPane:true});await waitForEntries(page);
  await page.locator(".entry-item").filter({hasText:"screenshot.png"}).click();
  await runPaletteCommand(page,"Crop Image…");
  const dialog=page.getByRole("dialog",{name:"Edit image",exact:true});
  await expect(dialog.getByRole("button",{name:"AI edit",exact:true})).toHaveCount(0);
  const right=page.getByRole("slider",{name:"Right crop edge"});await right.focus();await page.keyboard.press("ArrowLeft");
  await dialog.getByRole("button",{name:"Save copy",exact:true}).click();await expect(dialog).toBeHidden();
  const target="/home/user/Pictures/screenshot - Cropped.png";
  await expect(page.locator(".entry-item").filter({hasText:"screenshot - Cropped.png"})).toBeVisible();
  expect(await page.evaluate(async(path)=>{
    const {invoke}=await import("/src/lib/api/common.ts");const image=new Image();image.src=await invoke<string>("read_image_data_url",{path});await image.decode();return [image.naturalWidth,image.naturalHeight];
  },target)).toEqual([511,384]);
});

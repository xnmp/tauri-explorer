import {test,expect} from "./fixtures";
import {applySettingsAndReload,waitForEntries,runPaletteCommand} from "./helpers";

test("the core image editor saves captured crop pixels with no installed editing package",async({page})=>{
  await page.goto("/?path=/home/user/Pictures");
  await applySettingsAndReload(page,{showPreviewPane:true});await waitForEntries(page);
  await page.locator(".entry-item").filter({hasText:"screenshot.png"}).click();
  await runPaletteCommand(page,"Crop Image…");
  const dialog=page.getByRole("dialog",{name:"Edit image",exact:true});
  await expect(dialog.getByRole("button",{name:"AI edit",exact:true})).toHaveCount(0);
  await expect(dialog.getByRole("group",{name:"Image editing tools"})).toHaveCount(0);
  const right=page.getByRole("slider",{name:"Right crop edge"});await right.focus();await page.keyboard.press("ArrowLeft");
  await dialog.getByRole("button",{name:"Save copy",exact:true}).click();await expect(dialog).toBeHidden();
  const target="/home/user/Pictures/screenshot - Cropped.png";
  await expect(page.locator(".entry-item").filter({hasText:"screenshot - Cropped.png"})).toBeVisible();
  expect(await page.evaluate(async(path)=>{
    const {invoke}=await import("/src/lib/api/common.ts");const image=new Image();image.src=await invoke<string>("read_image_data_url",{path});await image.decode();return [image.naturalWidth,image.naturalHeight];
  },target)).toEqual([511,384]);
});


test("a plugin editor opens directly without crop controls or tool-switch tabs",async({page})=>{
  await page.goto("/?path=/home/user/Pictures");await waitForEntries(page);
  await page.evaluate(async()=>{
    const {exposePluginSDK}=await import('/src/lib/plugins/runtime-sdk.ts');exposePluginSDK();
    const {mount}=(window as any).__TAURI_EXPLORER_PLUGIN_SDK__.modules['svelte'];
    const {default:Editor}=await import('/src/lib/components/ImageCropEditor.svelte');
    const {default:Panel}=await import('/src/lib/components/InstalledPluginSettings.svelte');
    const {imageEditorRegistry}=await import('/src/lib/plugins/image-editor-registry.svelte.ts');
    imageEditorRegistry.register({id:'fixture.ai-edit',title:'AI edit',component:Panel,when:()=>true});
    const target=document.createElement('div');document.body.append(target);
    mount(Editor,{target,props:{path:'/home/user/Pictures/screenshot.png',name:'screenshot.png',initialTool:'fixture.ai-edit',onclose(){target.remove();}}});
  });
  const dialog=page.getByRole('dialog',{name:'AI edit',exact:true});
  await expect(dialog.getByRole('region',{name:'AI edit',exact:true})).toBeVisible();
  await expect(dialog.getByRole('group',{name:'Image editing tools'})).toHaveCount(0);
  await expect(dialog.getByRole('slider',{name:'Right crop edge'})).toHaveCount(0);
  await expect(dialog.getByRole('button',{name:'Save copy',exact:true})).toHaveCount(0);
});

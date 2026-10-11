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

test("a plugin opens the image editor directly in its own tool and learns when it closes",async({page})=>{
  await page.goto("/?path=/home/user/Pictures");await waitForEntries(page);
  await page.evaluate(async()=>{
    const load=new Function("path","return import(path)");
    const {exposePluginSDK}=await load('/src/lib/plugins/runtime-sdk.ts');exposePluginSDK();
    const {default:Panel}=await load('/src/lib/components/InstalledPluginSettings.svelte');
    const {pluginRegistry}=await load('/src/lib/plugins/registry.svelte.ts');
    const w=window as any;w.__editorEvents=[];
    await pluginRegistry.registerInstalled([{id:"fixture-editor",name:"Fixture editor",description:"Editor entry fixture",
      activate(ctx:any){ctx.registerImageEditorTool({id:"fixture.ai-edit",title:"AI edit",component:Panel,when:()=>true});w.__editorCtx=ctx;}}]);
    const ctx=w.__editorCtx;
    const settle=(name:string,promise:Promise<void>)=>promise.then(()=>w.__editorEvents.push(`${name}:closed`),(error:Error)=>w.__editorEvents.push(`${name}:${error.message}`));
    settle("first",ctx.presentation.openImageEditor({path:"/home/user/Pictures/screenshot.png",tool:"fixture.ai-edit"}));
    settle("second",ctx.presentation.openImageEditor({path:"/home/user/Pictures/screenshot.png",tool:"fixture.ai-edit"}));
    settle("foreign",ctx.presentation.openImageEditor({path:"/home/user/Pictures/screenshot.png",tool:"crop"}));
    settle("relative",ctx.presentation.openImageEditor({path:"screenshot.png",tool:"fixture.ai-edit"}));
  });
  const dialog=page.getByRole("dialog",{name:"AI edit",exact:true});
  await expect(dialog.getByRole("region",{name:"AI edit",exact:true})).toBeVisible();
  await expect(dialog.getByRole("slider",{name:"Right crop edge"})).toHaveCount(0);
  await expect(dialog.getByRole("button",{name:"Save copy",exact:true})).toHaveCount(0);
  const events=()=>page.evaluate(()=>[...(window as any).__editorEvents].sort());
  await expect.poll(events).toEqual(["foreign:Image editor tool is not registered by this plugin","relative:Image editor path must be an absolute file path","second:Close the open image editor first"]);
  await dialog.getByRole("button",{name:"Close image editor"}).click();
  await expect(dialog).toBeHidden();
  await expect.poll(events).toContain("first:closed");
  // An editor opened over another dialog would steal its focus and Escape.
  await page.evaluate(async()=>{
    const load=new Function("path","return import(path)");const {dialogStore}=await load('/src/lib/state/dialogs.svelte.ts');
    const w=window as any;dialogStore.openSettings();
    await w.__editorCtx.presentation.openImageEditor({path:"/home/user/Pictures/screenshot.png",tool:"fixture.ai-edit"}).catch((error:Error)=>w.__editorEvents.push(`over-settings:${error.message}`));
    dialogStore.closeSettings();
  });
  await expect.poll(events).toContain("over-settings:Close the open dialog first");
  await expect(dialog).toBeHidden();
  // Disabling the plugin closes the editor it opened and settles its request.
  await page.evaluate(()=>{const w=window as any;w.__editorCtx.presentation.openImageEditor({path:"/home/user/Pictures/screenshot.png",tool:"fixture.ai-edit"}).then(()=>w.__editorEvents.push("third:closed"));});
  await expect(dialog).toBeVisible();
  await page.evaluate(async()=>{const load=new Function("path","return import(path)");const {pluginRegistry}=await load('/src/lib/plugins/registry.svelte.ts');await pluginRegistry.setEnabled("fixture-editor",false);});
  await expect(dialog).toBeHidden();
  await expect.poll(events).toContain("third:closed");
});

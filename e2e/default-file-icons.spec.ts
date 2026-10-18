import { test, expect } from './fixtures';
import fs from 'node:fs';
import { decodePng, colorDistance } from './png-pixels';
import { FILE_ICON_EXAMPLES } from '../tests/fixtures/file-icon-examples';
import { waitForEntries, runPaletteCommand, ALL_VIEW_MODES } from './helpers';

const root = '/default-icon-proof';
const names = ['playwright.config.ts', 'main.js', 'main.mts', 'data.jsonc', 'files.bz2', 'App.tsx', 'App.jsx', 'script.py', 'lib.rs', 'main.go', 'index.html', 'style.css', 'package.json', 'README.md', 'App.svelte', 'App.vue', 'report.pdf', 'letter.docx', 'budget.xlsx', 'slides.pptx', 'files.zip', 'image.svg', 'song.mp3', 'movie.mp4', 'settings.toml', 'data.sqlite', 'font.woff2', 'app.exe', 'notes.txt', 'unknown.xyz', '.gitignore', 'Dockerfile', 'Folder', 'Linked', 'Repository'];

async function openIcons(page: import('@playwright/test').Page, theme = 'dark', iconTheme = 'default', fileNames: readonly string[] = names) {
  await page.setViewportSize({width:1600,height:1100});
  await page.addInitScript(({theme,iconTheme})=>{
    if(sessionStorage.getItem('icon-proof-seeded'))return;
    localStorage.setItem('explorer-settings',JSON.stringify({theme,iconTheme,showHidden:true,thumbnailSize:'medium',viewMode:'tiles'}));
    sessionStorage.setItem('icon-proof-seeded','1');
  },{theme,iconTheme});
  await page.goto('/?path=/home/user');
  await waitForEntries(page);
  await page.evaluate(async ({root,names}) => {
    const url='/src/lib/api/mock-fixtures.ts';
    const {mockFiles}=await import(/* @vite-ignore */ url);
    mockFiles[root]=names.map(name=>({name,path:`${root}/${name}`,kind:['Folder','Linked','Repository'].includes(name)?'directory':'file',size:120,modified:'2026-10-17T00:00:00Z',...(name==='Linked'?{is_symlink:true,symlink_target:`${root}/Folder`}:{}),...(name==='Repository'?{is_git_repo:true}:{})}));
    const control=((window as unknown as {__mockControl?: import('../src/lib/api/mock-control').MockControl}).__mockControl??={});
    control.videoThumbnail=async()=>{throw new Error('No embedded media thumbnail in icon-proof fixture');};
  }, {root,names:fileNames});
  await page.keyboard.press('Control+l');
  await page.locator('.path-input').fill(root);
  await page.locator('.path-input').press('Enter');
  await expect(page.locator(`.entry-item[data-path="${root}/${fileNames[0]}"]:visible`)).toBeVisible();
}

test('TS lettering remains opaque white against a dark selected tile', async ({page})=>{
  await openIcons(page);
  const row=page.locator(`.entry-item[data-path="${root}/playwright.config.ts"]:visible`);
  await row.click();
  await expect(row).toHaveClass(/selected/);
  await expect.poll(async()=>{
    const pixels=decodePng(await row.locator('svg').first().screenshot({scale:'css'}));
    let white=0;for(let y=0;y<pixels.height;y++)for(let x=0;x<pixels.width;x++)if(pixels.pixel(x,y).every(c=>c>235))white++;
    return white;
  },{message:'TS must paint white lettering, not cut holes through the blue badge'}).toBeGreaterThan(80);
});

async function choosePack(page: import('@playwright/test').Page, pack: string) {
  await page.keyboard.press('Control+,');
  const settings=page.locator('.settings-dialog');
  await expect(settings).toBeVisible();
  await settings.locator('.icon-theme-select').selectOption(pack);
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
}

async function chooseView(page: import('@playwright/test').Page, mode: string) {
  const label=`${mode[0].toUpperCase()+mode.slice(1)} View`;
  await page.keyboard.press('Control+Shift+p');
  const palette=page.locator('.command-palette-dialog');
  await palette.locator('.search-input').fill(label);
  await palette.locator('.command-item').filter({has:page.getByText(label,{exact:true})}).click();
  await expect(palette).toBeHidden();
}

const row=(page: import('@playwright/test').Page,name:string)=>page.locator(`.entry-item[data-path="${root}/${name}"]:visible`);
async function capture(page: import('@playwright/test').Page, name:string) {
  if(process.env.CAPTURE_ICONS !== '1')return;
  fs.mkdirSync('screenshots/feat/colorful-default-icons',{recursive:true});
  await page.screenshot({path:`screenshots/feat/colorful-default-icons/${name}.png`});
}

test('icon picker previews without persisting, reverts, commits and survives reload independently of color',async({page})=>{
  await openIcons(page,'dark','classic');
  const ts=row(page,'playwright.config.ts');
  await runPaletteCommand(page,'Switch Icon Theme...');
  const picker=page.getByRole('dialog',{name:'Select Icon Theme',exact:true});
  await expect(picker.getByRole('option')).toHaveCount(5); // Four packs and Follow Color Theme.
  await capture(page,'icon-theme-picker');
  await picker.getByRole('combobox').fill('Material');
  await expect(ts.locator('[data-icon-theme="material"]')).toBeVisible();
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('explorer-settings')!).iconTheme)).toBe('classic');
  await page.keyboard.press('Escape');
  await expect(picker).toBeHidden();
  await expect(ts.locator('[data-icon-theme="classic"]')).toBeVisible();

  await runPaletteCommand(page,'Switch Icon Theme...');
  await picker.getByRole('combobox').fill('Catppuccin');
  await expect(ts.locator('[data-icon-theme="catppuccin"]')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(picker).toBeHidden();
  await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('explorer-settings')!).iconTheme)).toBe('catppuccin');
  await page.reload();
  await waitForEntries(page);
  await expect(page.locator('.catppuccin-file-icon:visible').first()).toBeVisible();
  await page.keyboard.press('Control+,');
  await page.locator('.color-theme-select').selectOption('light');
  await expect(page.locator('.icon-theme-select')).toHaveValue('catppuccin');
  await page.keyboard.press('Escape');
  await expect(page.locator('.settings-dialog')).toBeHidden();
  await expect(page.locator('.catppuccin-file-icon.light:visible').first()).toBeVisible();
});

for(const theme of ['light','dark']) {
  for(const mode of ALL_VIEW_MODES) {
    test(`${theme} ${mode}: all four packs switch with distinct rendered results`,async({page})=>{
      await openIcons(page,theme,'material');
      await chooseView(page,mode);
      const drawings=new Set<string>();
      for(const pack of ['material','classic','minimal','catppuccin']) {
        await choosePack(page,pack);
        const ts=row(page,'playwright.config.ts');
        const icon=ts.locator(`[data-icon-theme="${pack}"]`);
        await expect(icon).toBeVisible();
        const target=await icon.locator('svg').count() ? icon.locator('svg').first() : icon;
        drawings.add(await target.evaluate(el=>el.outerHTML));
        const bounds=await target.boundingBox();const cell=await ts.boundingBox();
        expect(bounds!.width).toBeCloseTo(mode==='tiles'?64:16,0);
        expect(bounds!.x).toBeGreaterThanOrEqual(cell!.x);
        expect(bounds!.y).toBeGreaterThanOrEqual(cell!.y);
        expect(bounds!.x+bounds!.width).toBeLessThanOrEqual(cell!.x+cell!.width+1);
        expect(bounds!.y+bounds!.height).toBeLessThanOrEqual(cell!.y+cell!.height+1);
        await ts.click();
        await expect(ts).toHaveClass(/selected/);
        await row(page,'main.js').hover();
        await capture(page,`${theme}-${pack}-${mode}`);
      }
      expect(drawings.size).toBe(4);
    });
  }
}

test('Material distinguishes neighboring file types, rounds TS/JS and obeys custom theme tint',async({page})=>{
  await openIcons(page,'dark','material');
  await runPaletteCommand(page,'Details View');
  const cases=[['playwright.config.ts','typescript'],['main.js','javascript'],['App.tsx','react-ts'],['App.jsx','react-js'],['report.pdf','pdf'],['budget.xlsx','spreadsheet'],['song.mp3','audio'],['movie.mp4','video'],['settings.toml','config'],['data.sqlite','database'],['font.woff2','font'],['image.svg','image']];
  for(const [name,id] of cases) await expect(row(page,name).locator(`[data-icon-id="${id}"]`)).toBeVisible();
  await chooseView(page,'tiles');
  for(const name of ['playwright.config.ts','main.js']) {
    await expect.poll(async()=>{
      const pixels=decodePng(await row(page,name).locator('svg').first().screenshot({scale:'css'}));
      return colorDistance(pixels.pixel(5,5),pixels.pixel(5,32));
    },{message:`${name} corner must be rounded`}).toBeGreaterThan(30);
  }
  await page.evaluate(()=>document.documentElement.style.setProperty('--icon-file-tint','#a24cde'));
  for(const name of ['playwright.config.ts','budget.xlsx']) {
    await expect.poll(async()=>{
      const pixels=decodePng(await row(page,name).locator('svg').first().screenshot({scale:'css'}));
      let count=0;for(let y=0;y<pixels.height;y++)for(let x=0;x<pixels.width;x++)if(colorDistance(pixels.pixel(x,y),[162,76,222])<20)count++;
      return count;
    },{message:`${name} must use file tint`}).toBeGreaterThan(20);
  }
});

test('every registered file symbol actually paints in both colorful packs',async({page})=>{
  await openIcons(page,'dark','material',FILE_ICON_EXAMPLES.map(([name])=>name));
  for(const pack of ['material','catppuccin']) {
    await choosePack(page,pack);
    const boxes=[];
    for(const [name,id] of FILE_ICON_EXAMPLES) {
      const icon=row(page,name).locator(`[data-icon-theme="${pack}"][data-icon-id="${id}"]`);
      await expect(icon).toBeVisible();
      boxes.push({name,box:(await icon.boundingBox())!});
    }
    await expect.poll(async()=>{
      const pixels=decodePng(await page.screenshot({scale:'css'}));
      return boxes.filter(({box})=>{
        let colored=0;
        for(let y=Math.ceil(box.y);y<Math.floor(box.y+box.height);y++)for(let x=Math.ceil(box.x);x<Math.floor(box.x+box.width);x++) {
          const rgb=pixels.pixel(x,y);if(Math.max(...rgb)-Math.min(...rgb)>20)colored++;
        }
        return colored<8;
      }).map(({name})=>name);
    },{message:`Every ${pack} symbol must have painted pixels, including SVG use references`}).toEqual([]);
    await capture(page,`full-catalog-${pack}`);
  }
});

test('Follow Color Theme reacts to color previews and same-ID CSS reloads; explicit icon packs stay independent',async({page})=>{
  await openIcons(page,'dark','default');
  const ts=row(page,'playwright.config.ts');
  await runPaletteCommand(page,'Switch Theme...');
  const picker=page.getByRole('dialog',{name:'Select Color Theme',exact:true});
  await picker.getByRole('combobox').fill('Hacker');
  await expect(ts.locator('[data-icon-theme="minimal"]')).toBeVisible();
  await page.keyboard.press('Escape');await expect(picker).toBeHidden();
  await expect(ts.locator('[data-icon-theme="material"]')).toBeVisible();
  await choosePack(page,'classic');
  await runPaletteCommand(page,'Switch Theme...');
  await picker.getByRole('combobox').fill('Hacker');
  await expect(page.locator('html')).toHaveAttribute('data-theme','hacker');
  await expect(ts.locator('[data-icon-theme="classic"]')).toBeVisible();
  await page.keyboard.press('Escape');await expect(picker).toBeHidden();
  await choosePack(page,'default');
  await page.evaluate(async()=>{
    document.documentElement.style.setProperty('--theme-icon-pack','minimal');
    const url='/src/lib/state/theme.svelte.ts';const {themeStore}=await import(/* @vite-ignore */ url);
    await themeStore.initTheme();
    themeStore.previewTheme(themeStore.appliedThemeId);
  });
  await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
  await expect(ts.locator('[data-icon-theme="minimal"]')).toBeVisible();
});

test('all aliases follow their identity category in both colorful packs',async({page})=>{
  await openIcons(page,'dark','material');
  // Tile-sized glyphs retain solid interior pixels after Retina screenshots normalize to CSS pixels.
  await chooseView(page,'tiles');
  await page.evaluate(()=>{
    document.documentElement.style.setProperty('--icon-code','#ef1234');
    document.documentElement.style.setProperty('--icon-document','#12ef34');
    document.documentElement.style.setProperty('--icon-archive','#1234ef');
  });
  for(const pack of ['material','catppuccin']) {
    await choosePack(page,pack);
    for(const [name,color] of [['playwright.config.ts','rgb(239, 18, 52)'],['main.mts','rgb(239, 18, 52)'],['data.jsonc','rgb(239, 18, 52)'],['files.bz2','rgb(18, 52, 239)']]) {
      const target=color==='rgb(239, 18, 52)' ? [239,18,52] as [number,number,number] : [18,52,239] as [number,number,number];
      await expect.poll(async()=>{
        const pixels=decodePng(await row(page,name).locator(`[data-icon-theme="${pack}"]`).screenshot({scale:'css'}));
        let matching=0;
        for(let y=0;y<pixels.height;y++)for(let x=0;x<pixels.width;x++)if(colorDistance(pixels.pixel(x,y),target)<20)matching++;
        return matching;
      },{message:`${pack} ${name} must paint the category tint`}).toBeGreaterThan(5);
    }
  }
});

test('Minimal files use one monochrome foreground while folders retain their theme color',async({page})=>{
  await openIcons(page,'dark','minimal');
  for(const mode of ['details','tiles']) {
    await chooseView(page,mode);
    // Check both glyph sizes while excluding folder carets and the separate video marker.
    const selector=mode==='details'?'.icon svg':'.tile-icon svg:not(.video-thumbnail-marker svg)';
    const color=(name:string)=>row(page,name).locator(selector).first().evaluate(svg=>getComputedStyle(svg).color);
    await expect.poll(async()=>{
      const colors=await Promise.all(['playwright.config.ts','main.js','report.pdf','index.html','movie.mp4'].map(color));
      const folderColor=await color('Folder');
      return {fileColors:[...new Set(colors)],folderDistinct:folderColor!=='' && folderColor!==colors[0]};
    },{message:`${mode}: Minimal file glyphs must share a painted foreground and keep folders distinct`}).toEqual({
      fileColors:[expect.stringMatching(/\S/)],folderDistinct:true,
    });
  }
});

test('photo folders retain pack styling and link/repository decorations at large sizes',async({page})=>{
  await openIcons(page,'dark','material');
  await page.evaluate(async(root)=>{
    const url='/src/lib/api/mock-fixtures.ts';const {mockFiles}=await import(/* @vite-ignore */ url);
    for(const name of ['Folder','Linked','Repository'])mockFiles[`${root}/${name}`]=[{name:'photo.png',path:`${root}/${name}/photo.png`,kind:'file',size:100,modified:'2026-10-17T00:00:00Z'}];
  },root);
  for(const pack of ['material','classic','minimal','catppuccin']) {
    await choosePack(page,pack);
    for(const preset of ['large','xlarge']) {
      await page.keyboard.press('Control+,');
      const settings=page.locator('.settings-dialog');
      await settings.locator('.setting-row').filter({has:page.getByText('Thumbnail Size',{exact:true})}).locator('select').selectOption(preset);
      await page.keyboard.press('Escape');await expect(settings).toBeHidden();
      for(const name of ['Folder','Linked','Repository']) {
        const folder=row(page,name);
        await expect(folder.locator('.front-photo')).toBeVisible();
        await expect(folder.locator('.folder-thumb')).toHaveAttribute('data-icon-theme',pack);
        if(pack==='minimal'||pack==='catppuccin')await expect(folder.locator('.folder-back-fill')).toHaveCSS('fill','none');
      }
      await expect(row(page,'Repository').locator('.git-repo-badge')).toBeVisible();
      await expect(row(page,'Linked').locator('.linked-folder')).toBeVisible();
      if(preset==='large')await capture(page,`photo-folders-${pack}`);
    }
  }
});

test('all packs preserve icon size and linked/repository folder distinctions at every tile preset',async({page})=>{
  await openIcons(page,'dark','material');
  for(const pack of ['material','classic','minimal','catppuccin']) {
    await choosePack(page,pack);
    for(const [preset,pixels] of [['small',48],['medium',64],['large',96],['xlarge',128]] as const) {
      await page.keyboard.press('Control+,');
      const settings=page.locator('.settings-dialog');
      await settings.locator('.setting-row').filter({has:page.getByText('Thumbnail Size',{exact:true})}).locator('select').selectOption(preset);
      await page.keyboard.press('Escape');await expect(settings).toBeHidden();
      for(const name of ['playwright.config.ts','main.js','Folder','Linked','Repository']) {
        const svg=row(page,name).locator('svg').first();
        const box=await svg.boundingBox();
        expect(box!.width,`${pack} ${preset} ${name}`).toBeCloseTo(pixels,0);
      }
      await expect(row(page,'Linked').locator('.linked-folder')).toBeVisible();
      await expect(row(page,'Repository').locator('.git-repo-badge')).toBeVisible();
    }
  }
});

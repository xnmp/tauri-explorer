import { readFile } from 'node:fs/promises';
import { describe, it, expect } from 'vitest';
import { FILE_ICON_IDENTITIES } from '$lib/domain/file-icon-identity';
import { FILE_ICON_EXAMPLES } from '../fixtures/file-icon-examples';
import { buildIconSprite, renderIconSprite, catppuccinFolderGlyph } from '../../scripts/build-icon-sprites.mjs';

describe('icon artwork contract',()=>{
  it('visually exercises every registered file identity',()=>{
    expect(new Set(FILE_ICON_EXAMPLES.map(([,id])=>id))).toEqual(new Set(FILE_ICON_IDENTITIES.filter(id=>id!=='folder')));
  });
  it.each(['material','catppuccin'] as const)('%s ships a fresh sprite covering every supported identity',async(pack)=>{
    const sprite=await readFile(`src/lib/components/icons/${pack}-sprite.svg`,'utf8');
    expect(sprite).toBe(await buildIconSprite(pack));
    for(const id of FILE_ICON_IDENTITIES.filter(id=>pack!=='material'||id!=='folder')) expect(sprite,`missing ${id}`).toContain(`<symbol id="${id}"`);
  });
  it('ships a fresh special-folder glyph sprite (#1491)',async()=>{
    expect(await readFile('src/lib/components/icons/folder-glyphs-sprite.svg','utf8')).toBe(await buildIconSprite('folder-glyphs'));
  });
  it('derives Catppuccin glyph-only folder symbols by removing just the shared outline',async()=>{
    const svg=await readFile('src/lib/components/icons/catppuccin/folder-src.svg','utf8');
    const glyph=catppuccinFolderGlyph(svg);
    expect(glyph).not.toContain('var(--vscode-ctp-text)');
    expect(glyph).toContain('stroke="var(--vscode-ctp-green)"');
    expect(svg.length-glyph.length).toBeLessThan(260);
    expect(()=>catppuccinFolderGlyph('<svg viewBox="0 0 16 16"><path d="M1 1h2"/></svg>')).toThrow();
  });
  it('ships the complete upstream permission notice inside the distributed Catppuccin sprite',async()=>{
    const license=await readFile('src/lib/components/icons/catppuccin/LICENSE.txt','utf8');
    const sprite=await buildIconSprite('catppuccin');
    expect(sprite).toContain('<metadata>');
    expect(sprite).toContain(license.trim());
    expect(sprite).toContain('Copyright (c) 2023 Catppuccin');
    expect(sprite).toContain('Copyright (c) 2023 thang-nm');
  });
  it('keeps local SVG definition IDs independent between icons',()=>{
    const svg='<svg viewBox="0 0 16 16"><defs><clipPath id="clip"><path d="M0 0h1"/></clipPath></defs><g clip-path="url(#clip)"/></svg>';
    const sprite=renderIconSprite({one:svg,two:svg});
    expect(sprite).toContain('id="one-clip"');expect(sprite).toContain('url(#one-clip)');
    expect(sprite).toContain('id="two-clip"');expect(sprite).toContain('url(#two-clip)');
    expect(sprite).not.toContain('id="clip"');
  });
});

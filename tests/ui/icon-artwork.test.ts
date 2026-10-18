import { readFile } from 'node:fs/promises';
import { describe, it, expect } from 'vitest';
import { FILE_ICON_IDENTITIES } from '$lib/domain/file-icon-identity';
import { FILE_ICON_EXAMPLES } from '../fixtures/file-icon-examples';
import { buildIconSprite, renderIconSprite } from '../../scripts/build-icon-sprites.mjs';

describe('icon artwork contract',()=>{
  it('visually exercises every registered file identity',()=>{
    expect(new Set(FILE_ICON_EXAMPLES.map(([,id])=>id))).toEqual(new Set(FILE_ICON_IDENTITIES.filter(id=>id!=='folder')));
  });
  it.each(['material','catppuccin'] as const)('%s ships a fresh sprite covering every supported identity',async(pack)=>{
    const sprite=await readFile(`src/lib/components/icons/${pack}-sprite.svg`,'utf8');
    expect(sprite).toBe(await buildIconSprite(pack));
    for(const id of FILE_ICON_IDENTITIES.filter(id=>pack!=='material'||id!=='folder')) expect(sprite,`missing ${id}`).toContain(`<symbol id="${id}"`);
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

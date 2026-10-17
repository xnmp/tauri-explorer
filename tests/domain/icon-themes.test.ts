import { describe, it, expect } from 'vitest';
import { resolveIconTheme } from '$lib/domain/icon-themes';

describe('icon theme resolution',()=>{
  it('keeps an explicit pack independent of a color theme suggestion',()=>{
    expect(resolveIconTheme('classic','minimal')).toBe('classic');
    expect(resolveIconTheme('material','minimal')).toBe('material');
    expect(resolveIconTheme('minimal','material')).toBe('minimal');
  });
  it('follows supported suggestions and retains legacy custom-theme meaning',()=>{
    expect(resolveIconTheme('default'," 'minimal' ")).toBe('minimal');
    expect(resolveIconTheme('default','material')).toBe('material');
    expect(resolveIconTheme('default','classic')).toBe('classic');
    expect(resolveIconTheme('default','default')).toBe('classic');
  });
  it('uses Material when a color theme has no supported suggestion',()=>{
    expect(resolveIconTheme('default','')).toBe('material');
    expect(resolveIconTheme('default','unknown')).toBe('material');
  });
});

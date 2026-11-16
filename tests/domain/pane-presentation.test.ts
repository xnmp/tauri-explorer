import { describe, expect, it } from 'vitest';
import { leaf, removeLeaf, splitLeaf, splitNode, updateRatio } from '$lib/domain/pane-layout';
import { paneCreation, panePresentation } from '$lib/domain/pane-presentation';

const viewport = { width: 1200, height: 800 };

describe('pane creation policy', () => {
  it.each(['left', 'right', 'up', 'down'] as const)('recognizes a %s split and its original pane', placement => {
    const before = splitLeaf(leaf('a'), 'a', 'right', 'b', 'ab');
    const after = splitLeaf(before, 'b', placement, 'c', 'bc');
    expect(paneCreation(before, after)).toEqual({ sourceId: 'b', paneId: 'c', splitId: 'bc',
      direction: ['left', 'right'].includes(placement) ? 'row' : 'column', first: ['left', 'up'].includes(placement) });
  });

  it('does not animate initial/restored layouts, ratio changes, removals or replacements', () => {
    const before = splitLeaf(leaf('a'), 'a', 'right', 'b', 'ab');
    expect(paneCreation(undefined, before)).toBeUndefined();
    expect(paneCreation(before, before)).toBeUndefined();
    expect(paneCreation(before, updateRatio(before, 'ab', .7))).toBeUndefined();
    expect(paneCreation(before, removeLeaf(before, 'b')!)).toBeUndefined();
    expect(paneCreation(before, splitLeaf(leaf('c'), 'c', 'right', 'd', 'cd'))).toBeUndefined();
  });

  it('rejects a split accompanied by another layout mutation', () => {
    const before = splitLeaf(leaf('a'), 'a', 'right', 'b', 'ab');
    const split = splitLeaf(before, 'b', 'down', 'c', 'bc');
    expect(paneCreation(before, updateRatio(split, 'ab', .8))).toBeUndefined();
    expect(paneCreation(before, splitLeaf(split, 'c', 'down', 'd', 'cd'))).toBeUndefined();
  });

  it('does not treat restoring a pane against a whole subtree as a single-pane reveal', () => {
    const before = splitLeaf(leaf('a'), 'a', 'right', 'b', 'ab');
    expect(paneCreation(before, splitNode(before, 'ab', 'up', 'c', 'outer'))).toBeUndefined();
  });
});

describe('flat pane placement', () => {
  it('fills a lone pane directly in CSS without waiting for a viewport measurement', () => {
    const layout = panePresentation(leaf('a'), { width: 0, height: 0 }, 6);
    expect(layout.panes[0].style).toBe('left:0;top:0;width:100%;height:100%');
  });

  it('keeps pane identities independent of split ancestry and emits each divider once', () => {
    const initial = panePresentation(leaf('a'), viewport, 6);
    const nested = panePresentation(splitLeaf(splitLeaf(leaf('a'), 'a', 'right', 'b', 'ab'), 'a', 'down', 'c', 'ac'), viewport, 6);
    expect(initial.panes.map(p => p.id)).toEqual(['a']);
    expect(nested.panes.map(p => p.id)).toEqual(['a', 'c', 'b']);
    expect(nested.splits.map(s => s.node.id)).toEqual(['ab', 'ac']);
    expect(nested.splits[0].controls).toBe('pane-region-a pane-region-c');
  });

  it('keeps the last panes reachable at their minimum width in deep layouts', () => {
    let root = leaf('0') as import('$lib/domain/pane-layout').PaneNode;
    for (let i = 1; i <= 100; i++) root = splitLeaf(root, String(i - 1), 'right', String(i), `s${i}`);
    const layout = panePresentation(root, viewport, 8);
    expect(layout.panes).toHaveLength(101);
    const style = Object.fromEntries(layout.panes.at(-1)!.style.split(';').map(property => property.split(':')));
    expect(parseFloat(style.left)).toBeCloseTo(24800, 5);
    expect(parseFloat(style.width)).toBe(240);
    expect(Math.max(...layout.panes.map(p => p.style.length))).toBeLessThan(150);
  });
});

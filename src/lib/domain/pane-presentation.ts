/** Flat, identity-stable pane placement (#1703). Layout and input share the
 * same domain geometry; only the presentation measurement runs before paint. */
import { leafIds, removeLeaf, type PaneNode, type PaneSplit } from './pane-layout';
import { paneMinima, paneGeometryFromMinima, type PaneSize } from './pane-viewport';

export function panePresentation(root: PaneNode, viewport: PaneSize, divider: number, minima = paneMinima(root, divider), ready: (id: string) => boolean = () => true) {
  const geometry = paneGeometryFromMinima(root, viewport, divider, minima);
  const panes: { id: string; style: string }[] = [];
  const placeholders: { id: string; style: string }[] = [];
  const splits: { node: PaneSplit; style: string; firstMinimum: number; secondMinimum: number; controls: string }[] = [];
  const materialized = new Map<string, boolean>();
  function mark(node: PaneNode): boolean {
    const first = node.type === 'leaf' ? ready(node.id) : mark(node.first);
    const second = node.type === 'leaf' ? false : mark(node.second);
    materialized.set(node.id, first || second);
    return first || second;
  }
  mark(root);
  function place(node: PaneNode) {
    const rect = node.type === 'leaf' ? geometry.panes.get(node.id)! : geometry.splits.get(node.id)!.rect;
    const style = `left:${rect.x}px;top:${rect.y}px;width:${rect.w}px;height:${rect.h}px`;
    if (!materialized.get(node.id)) { placeholders.push({ id: node.id, style }); return; }
    if (node.type === 'leaf') { panes.push({ id: node.id, style }); return; }
    const horizontal = node.direction === 'row';
    const axis: keyof PaneSize = horizontal ? 'width' : 'height';
    const firstMinimum = minima.get(node.first.id)![axis];
    const secondMinimum = minima.get(node.second.id)![axis];
    splits.push({ node, style, firstMinimum, secondMinimum, controls: leafIds(node.first).map(id => `pane-region-${id}`).join(' ') });
    place(node.first);
    place(node.second);
  }
  place(root);
  return { panes, placeholders, splits };
}

export interface PaneCreation { sourceId: string; paneId: string; splitId: string; direction: 'row' | 'column'; first: boolean }
const sameLayout = (a: PaneNode, b: PaneNode): boolean => a.type === b.type && a.id === b.id
  && (a.type === 'leaf' || (b.type === 'split' && a.direction === b.direction && a.ratio === b.ratio
    && sameLayout(a.first, b.first) && sameLayout(a.second, b.second)));

/** Animate only a single leaf split. Restoration, replacement, removal and
 * ratio changes are immediate; they must not look like a user-created pane. */
export function paneCreation(before: PaneNode | undefined, after: PaneNode): PaneCreation | undefined {
  if (!before || before === after) return;
  const previous = new Set(leafIds(before));
  const ids = leafIds(after);
  const added = ids.filter(id => !previous.has(id));
  if (added.length !== 1 || ids.length !== previous.size + 1) return;
  const paneId = added[0];
  const without = removeLeaf(after, paneId);
  if (!without || !sameLayout(before, without)) return;
  function find(node: PaneNode): PaneCreation | undefined {
    if (node.type === 'leaf') return;
    if (node.first.type === 'leaf' && node.second.type === 'leaf') {
      const first = node.first.id === paneId;
      if (first || node.second.id === paneId) return { sourceId: first ? node.second.id : node.first.id, paneId, splitId: node.id, direction: node.direction, first };
    }
    return find(node.first) ?? find(node.second);
  }
  return find(after);
}

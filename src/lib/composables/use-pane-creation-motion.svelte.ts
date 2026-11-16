import { onDestroy, onMount, untrack } from 'svelte';
import type { PaneNode } from '$lib/domain/pane-layout';
import { createPaneCreationMotion } from '$lib/state/pane-creation-motion';

export function usePaneCreationMotion(deps: { root(): HTMLElement | undefined; layout(): PaneNode; shown(): boolean }) {
  const preference = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : undefined;
  const motion = createPaneCreationMotion(deps.root, () => preference?.matches ?? true);
  $effect.pre(() => {
    const layout = deps.layout(), shown = deps.shown();
    untrack(() => motion.prepare(layout, shown));
  });
  $effect(() => {
    deps.layout(); deps.shown();
    untrack(motion.play);
  });
  onMount(() => {
    const root = deps.root();
    if (!root) return;
    let size = getComputedStyle(root).width + '/' + getComputedStyle(root).height;
    const observer = new ResizeObserver(() => {
      const next = getComputedStyle(root).width + '/' + getComputedStyle(root).height;
      if (size !== next) motion.finish();
      size = next;
    });
    observer.observe(root);
    const dividerInput = (event: Event) => {
      if ((event.target as Element).closest('.pane-divider')) motion.finish();
    };
    root.addEventListener('pointerdown', dividerInput, true);
    root.addEventListener('keydown', dividerInput, true);
    const scrollport = root.closest('.pane-container');
    scrollport?.addEventListener('scroll', motion.finish);
    preference?.addEventListener('change', motion.finish);
    window.addEventListener('blur', motion.finish);
    return () => {
      observer.disconnect();
      root.removeEventListener('pointerdown', dividerInput, true);
      root.removeEventListener('keydown', dividerInput, true);
      scrollport?.removeEventListener('scroll', motion.finish);
      preference?.removeEventListener('change', motion.finish);
      window.removeEventListener('blur', motion.finish);
    };
  });
  onDestroy(motion.finish);
}

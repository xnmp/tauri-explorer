import { onDestroy, onMount, untrack } from 'svelte';
import type { PaneNode } from '$lib/domain/pane-layout';
import { isModifierKey } from '$lib/domain/keyboard';
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
    const holdPointer = (event: PointerEvent) => {
      if ((event.target as Element).closest('.pane-divider')) motion.finish();
      else motion.pause();
    };
    const keyboardInput = (event: KeyboardEvent) => {
      if (!isModifierKey(event.key)) motion.finish();
    };
    // Resume before stopped events too. Playing schedules a future frame;
    // it does not resize the held content during the release/click dispatch.
    const releases = ['pointerup', 'click', 'auxclick', 'contextmenu'];
    const completions = ['dblclick', 'dragend', 'drop'];
    root.addEventListener('pointerdown', holdPointer, true);
    const scrollport = root.closest('.pane-container');
    scrollport?.addEventListener('scroll', motion.finish);
    preference?.addEventListener('change', motion.finish);
    window.addEventListener('blur', motion.finish);
    window.addEventListener('keydown', keyboardInput, true);
    for (const type of releases) window.addEventListener(type, motion.resume, true);
    for (const type of completions) window.addEventListener(type, motion.finish);
    window.addEventListener('pointercancel', motion.finish, true);
    return () => {
      observer.disconnect();
      root.removeEventListener('pointerdown', holdPointer, true);
      scrollport?.removeEventListener('scroll', motion.finish);
      preference?.removeEventListener('change', motion.finish);
      window.removeEventListener('blur', motion.finish);
      window.removeEventListener('keydown', keyboardInput, true);
      for (const type of releases) window.removeEventListener(type, motion.resume, true);
      for (const type of completions) window.removeEventListener(type, motion.finish);
      window.removeEventListener('pointercancel', motion.finish, true);
    };
  });
  onDestroy(motion.finish);
}

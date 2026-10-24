/**
 * Whether the active theme uses a light color scheme, for picking the
 * highlight.js palette. Recomputed via a MutationObserver on the
 * documentElement's `data-theme` attribute (set by theme.svelte.ts) —
 * getComputedStyle only reflects the new theme after the attribute has
 * actually been applied to the DOM. Call during component initialisation.
 */
export function useLightTheme(): { readonly light: boolean } {
  let light = $state(false);
  $effect(() => {
    const compute = () =>
      (light = getComputedStyle(document.documentElement).colorScheme === "light");
    compute();
    const observer = new MutationObserver(compute);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  });
  return {
    get light() { return light; },
  };
}

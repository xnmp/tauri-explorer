/**
 * Background animation registry - maps animation names to render functions.
 * Issue: tauri-jsn1.3
 *
 * Themes declare --theme-bg-animation: 'particles' | 'starfield' | 'none'
 * The renderer reads this CSS variable and activates the matching animation.
 */

export interface AnimationColors {
  primary: string;
  accent: string;
  background: string;
}

/** A render function that receives a canvas and returns a cleanup function. */
export type AnimationRenderer = (
  canvas: HTMLCanvasElement,
  colors: AnimationColors,
) => () => void;

const registry = new Map<string, AnimationRenderer>();

export function registerAnimation(name: string, renderer: AnimationRenderer): void {
  registry.set(name, renderer);
}

export function getAnimation(name: string): AnimationRenderer | undefined {
  return registry.get(name);
}

export function getAnimationNames(): string[] {
  return [...registry.keys()];
}

/** Read the current theme's preferred background animation from CSS. */
export function getThemeAnimation(): string {
  if (typeof document === "undefined") return "none";
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue("--theme-bg-animation")
    .trim()
    .replace(/["']/g, "");
  return value || "none";
}

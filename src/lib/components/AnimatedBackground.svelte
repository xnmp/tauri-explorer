<!--
  AnimatedBackground component - renders canvas-based background animations.
  Reads --theme-bg-animation CSS variable to determine which animation to play.
  Respects prefers-reduced-motion media query.
  Issue: tauri-jsn1.3
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { themeStore } from "$lib/state/theme.svelte";
  import { getAnimation, getThemeAnimation } from "$lib/background-animations";
  import type { AnimationColors } from "$lib/background-animations";

  let canvasEl: HTMLCanvasElement | null = null;
  let cleanup: (() => void) | null = null;
  let prefersReducedMotion = false;

  function readColors(): AnimationColors {
    const style = getComputedStyle(document.documentElement);
    return {
      primary: style.getPropertyValue("--text-primary").trim() || "#ffffff",
      accent: style.getPropertyValue("--accent").trim() || "#4cc2f4",
      background: style.getPropertyValue("--background-solid").trim() || "#1c1c1e",
    };
  }

  function startAnimation() {
    stopAnimation();
    if (!canvasEl || prefersReducedMotion) return;

    const animName = getThemeAnimation();
    if (animName === "none" || !animName) return;

    const renderer = getAnimation(animName);
    if (!renderer) return;

    cleanup = renderer(canvasEl, readColors());
  }

  function stopAnimation() {
    cleanup?.();
    cleanup = null;
  }

  onMount(() => {
    // Check reduced motion preference
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    prefersReducedMotion = mq.matches;
    function handleMotionChange(e: MediaQueryListEvent) {
      prefersReducedMotion = e.matches;
      if (prefersReducedMotion) stopAnimation();
      else startAnimation();
    }
    mq.addEventListener("change", handleMotionChange);

    startAnimation();

    return () => {
      stopAnimation();
      mq.removeEventListener("change", handleMotionChange);
    };
  });

  // Re-start animation when theme changes
  $effect(() => {
    const _themeId = themeStore.currentThemeId;
    // Delay to let CSS variables update
    requestAnimationFrame(() => startAnimation());
  });
</script>

<canvas
  bind:this={canvasEl}
  class="animated-background"
  aria-hidden="true"
></canvas>

<style>
  .animated-background {
    position: fixed;
    inset: 0;
    width: 100%;
    height: 100%;
    z-index: -1;
    pointer-events: none;
  }
</style>

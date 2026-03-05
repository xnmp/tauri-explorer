/**
 * Starfield animation - twinkling stars with faint constellation lines.
 * Issue: tauri-jsn1.3
 */

import type { AnimationRenderer } from "./registry";

interface Star {
  x: number;
  y: number;
  radius: number;
  baseOpacity: number;
  twinkleSpeed: number;
  twinkleOffset: number;
}

const STAR_COUNT = 80;
const CONSTELLATION_DISTANCE = 100;
const CONSTELLATION_CHANCE = 0.3; // Only some nearby stars form constellations

export const starfieldRenderer: AnimationRenderer = (canvas, colors) => {
  const ctx = canvas.getContext("2d")!;
  let animId = 0;
  let running = true;
  let time = 0;

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.offsetWidth * dpr;
    canvas.height = canvas.offsetHeight * dpr;
    ctx.scale(dpr, dpr);
  }

  resize();
  window.addEventListener("resize", resize);

  const stars: Star[] = Array.from({ length: STAR_COUNT }, () => ({
    x: Math.random() * canvas.offsetWidth,
    y: Math.random() * canvas.offsetHeight,
    radius: Math.random() * 1.2 + 0.3,
    baseOpacity: Math.random() * 0.5 + 0.15,
    twinkleSpeed: Math.random() * 0.02 + 0.005,
    twinkleOffset: Math.random() * Math.PI * 2,
  }));

  function draw() {
    if (!running) return;
    time++;
    const w = canvas.offsetWidth;
    const h = canvas.offsetHeight;
    ctx.clearRect(0, 0, w, h);

    // Draw constellation lines (faint connections between nearby stars)
    for (let i = 0; i < stars.length; i++) {
      for (let j = i + 1; j < stars.length; j++) {
        const dx = stars[i].x - stars[j].x;
        const dy = stars[i].y - stars[j].y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < CONSTELLATION_DISTANCE) {
          // Use seeded random based on indices for stable constellation pattern
          const seed = (i * 7 + j * 13) % 100;
          if (seed / 100 < CONSTELLATION_CHANCE) {
            const alpha = (1 - dist / CONSTELLATION_DISTANCE) * 0.08;
            ctx.strokeStyle = `${colors.accent}${Math.round(alpha * 255).toString(16).padStart(2, "0")}`;
            ctx.lineWidth = 0.4;
            ctx.beginPath();
            ctx.moveTo(stars[i].x, stars[i].y);
            ctx.lineTo(stars[j].x, stars[j].y);
            ctx.stroke();
          }
        }
      }
    }

    // Draw stars with twinkling
    for (const star of stars) {
      const twinkle = Math.sin(time * star.twinkleSpeed + star.twinkleOffset);
      const opacity = star.baseOpacity + twinkle * 0.15;
      const r = star.radius + twinkle * 0.2;

      ctx.beginPath();
      ctx.arc(star.x, star.y, Math.max(0.2, r), 0, Math.PI * 2);
      ctx.fillStyle = `${colors.primary}${Math.round(Math.max(0, Math.min(1, opacity)) * 255).toString(16).padStart(2, "0")}`;
      ctx.fill();
    }

    animId = requestAnimationFrame(draw);
  }

  function handleVisibility() {
    if (document.hidden) {
      running = false;
      cancelAnimationFrame(animId);
    } else {
      running = true;
      draw();
    }
  }
  document.addEventListener("visibilitychange", handleVisibility);

  draw();

  return () => {
    running = false;
    cancelAnimationFrame(animId);
    window.removeEventListener("resize", resize);
    document.removeEventListener("visibilitychange", handleVisibility);
  };
};

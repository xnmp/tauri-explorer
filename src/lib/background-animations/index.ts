/**
 * Background animations barrel - registers all built-in animations.
 * Issue: tauri-jsn1.3
 */

export { registerAnimation, getAnimation, getAnimationNames, getThemeAnimation } from "./registry";
export type { AnimationColors, AnimationRenderer } from "./registry";

import { registerAnimation } from "./registry";
import { particlesRenderer } from "./particles";
import { starfieldRenderer } from "./starfield";

// Register built-in animations
registerAnimation("particles", particlesRenderer);
registerAnimation("starfield", starfieldRenderer);

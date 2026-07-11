/**
 * Collision-free output filename derivation (#278).
 *
 * Shared by plugin dialogs that write a derived file next to the original
 * (photo.png → photo_upscaled.png, photo_upscaled_2.png, …). Extracted from
 * two copy-pasted implementations in the nano-banana and upscale dialogs.
 * Pure domain logic — the existence check is injected.
 */

/** Split a filename into base and extension. No-extension and dotfile names
 *  keep their whole name as the base and fall back to `.png` (these dialogs
 *  produce images). */
function splitName(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return { base: name, ext: ".png" };
  return { base: name.slice(0, dot), ext: name.slice(dot) };
}

/**
 * Find the next available `<base><suffix>[_N]<ext>` name in `dir`.
 * Checks the plain suffixed name plus numbered variants 2-20 in one
 * `pathsExist` batch; if all collide, falls back to a timestamped name
 * (unique enough for a 21st derivative).
 */
export async function findAvailableFilename(
  dir: string,
  name: string,
  suffix: string,
  pathsExist: (paths: string[]) => Promise<boolean[]>,
): Promise<string> {
  const { base, ext } = splitName(name);
  const suffixedBase = base + suffix;

  const candidates = [suffixedBase + ext];
  for (let i = 2; i <= 20; i++) {
    candidates.push(`${suffixedBase}_${i}${ext}`);
  }
  const exists = await pathsExist(candidates.map((c) => `${dir}/${c}`));

  const firstAvailable = candidates.find((_, i) => !exists[i]);
  return firstAvailable ?? `${suffixedBase}_${Date.now()}${ext}`;
}

import { isChordShortcut, parseChord, parseShortcut, shortcutKeysOverlap, type ParsedShortcut } from "./keybinding-parser";

function steps(binding: string): ParsedShortcut[] | null {
  if (isChordShortcut(binding)) {
    const chord = parseChord(binding);
    return chord ? [chord.prefix, chord.suffix] : null;
  }
  const single = parseShortcut(binding);
  return single ? [single] : null;
}

// Runtime Ctrl bindings accept Ctrl OR Cmd. Explicit Meta requires Meta, and
// Ctrl+Meta requires both, so aliases conflict when their accepted masks overlap.
function modifierMasks(step: ParsedShortcut): readonly number[] {
  return step.meta ? [step.ctrl ? 3 : 2] : step.ctrl ? [1, 2] : [0];
}

function overlaps(left: ParsedShortcut, right: ParsedShortcut): boolean {
  return shortcutKeysOverlap(left, right)
    && left.alt === right.alt && left.shift === right.shift
    && modifierMasks(left).some((mask) => modifierMasks(right).includes(mask));
}

/** Duplicate complete bindings or a single binding that shadows a chord prefix. */
export function shortcutsConflict(left: string, right: string): boolean {
  const a = steps(left);
  const b = steps(right);
  if (!a || !b || !overlaps(a[0], b[0])) return false;
  return a.length === 1 || b.length === 1 || overlaps(a[1], b[1]);
}

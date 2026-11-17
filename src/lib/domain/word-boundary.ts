/**
 * Word boundaries for inline file-name editing (#1746).
 *
 * A "word" is a run of letters or digits; every other character (whitespace,
 * `.`, `_`, `-`, quotes, brackets, `&`, `+`, `'`, …) separates words, so word
 * movement stops on both sides of any punctuation run. camelCase humps,
 * acronym ends and letter/digit transitions are boundaries too.
 */
const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;

function isSeparator(ch: string): boolean {
  return !WORD_CHAR.test(ch);
}

function isBoundary(text: string, i: number): boolean {
  if (i <= 0 || i >= text.length) return true;
  const prev = text[i - 1];
  const curr = text[i];
  if (isSeparator(prev) !== isSeparator(curr)) return true;
  if (/[a-z]/.test(prev) && /[A-Z]/.test(curr)) return true;
  if (/[A-Z]/.test(prev) && /[A-Z]/.test(curr) && i + 1 < text.length && /[a-z]/.test(text[i + 1])) return true;
  if (/\d/.test(prev) !== /\d/.test(curr) && !isSeparator(prev) && !isSeparator(curr)) return true;
  return false;
}

export function findNextWordBoundary(text: string, pos: number): number {
  if (pos >= text.length) return text.length;
  let i = pos + 1;
  while (i < text.length && !isBoundary(text, i)) i++;
  return i;
}

export function findPrevWordBoundary(text: string, pos: number): number {
  if (pos <= 0) return 0;
  let i = pos - 1;
  while (i > 0 && !isBoundary(text, i)) i--;
  return i;
}

export type WordEditCommand = { kind: "move" | "delete"; forward: boolean };

/**
 * The word command a keydown requests in a text field, or null. Word
 * movement/deletion uses Ctrl on Windows/Linux and Option on macOS, where
 * Cmd+Arrow keeps its native line-start/end meaning.
 */
export function wordEditCommand(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">,
  isMac: boolean,
): WordEditCommand | null {
  const wordModifier = isMac
    ? event.altKey && !event.ctrlKey && !event.metaKey
    : event.ctrlKey && !event.altKey && !event.metaKey;
  if (!wordModifier) return null;
  switch (event.key) {
    case "ArrowLeft": return { kind: "move", forward: false };
    case "ArrowRight": return { kind: "move", forward: true };
    case "Backspace": return { kind: "delete", forward: false };
    case "Delete": return { kind: "delete", forward: true };
    default: return null;
  }
}

export interface TextFieldState {
  value: string;
  selectionStart: number;
  selectionEnd: number;
  selectionDirection: "forward" | "backward" | "none";
}

/** Apply a word command to a text field's value and selection. */
export function applyWordEdit(
  state: TextFieldState,
  command: WordEditCommand,
  extendSelection: boolean,
): TextFieldState {
  const { value, selectionStart: start, selectionEnd: end } = state;
  if (command.kind === "delete") {
    if (start !== end) {
      return { value: value.slice(0, start) + value.slice(end), selectionStart: start, selectionEnd: start, selectionDirection: "none" };
    }
    const target = command.forward ? findNextWordBoundary(value, end) : findPrevWordBoundary(value, start);
    const [from, to] = target < start ? [target, start] : [start, target];
    return { value: value.slice(0, from) + value.slice(to), selectionStart: from, selectionEnd: from, selectionDirection: "none" };
  }
  const backward = state.selectionDirection === "backward";
  const caret = extendSelection ? (backward ? start : end) : (command.forward ? end : start);
  const next = command.forward ? findNextWordBoundary(value, caret) : findPrevWordBoundary(value, caret);
  if (!extendSelection) {
    return { value, selectionStart: next, selectionEnd: next, selectionDirection: "none" };
  }
  const anchor = backward ? end : start;
  return next < anchor
    ? { value, selectionStart: next, selectionEnd: anchor, selectionDirection: "backward" }
    : { value, selectionStart: anchor, selectionEnd: next, selectionDirection: "forward" };
}

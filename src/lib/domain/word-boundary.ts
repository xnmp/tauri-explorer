const SEPARATORS = new Set([" ", "_", "-", ".", ",", "(", ")", "[", "]", "{", "}"]);

function isBoundary(text: string, i: number): boolean {
  if (i <= 0 || i >= text.length) return true;
  const prev = text[i - 1];
  const curr = text[i];
  if (SEPARATORS.has(prev) !== SEPARATORS.has(curr)) return true;
  if (/[a-z]/.test(prev) && /[A-Z]/.test(curr)) return true;
  if (/[A-Z]/.test(prev) && /[A-Z]/.test(curr) && i + 1 < text.length && /[a-z]/.test(text[i + 1])) return true;
  if (/\d/.test(prev) !== /\d/.test(curr) && !SEPARATORS.has(prev) && !SEPARATORS.has(curr)) return true;
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

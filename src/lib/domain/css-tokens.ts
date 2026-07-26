/**
 * Pure helpers for reasoning about CSS custom properties ("design tokens")
 * in stylesheet source.
 *
 * Motivation (#499): `var(--token, fallback)` degrades *silently* when
 * `--token` is never defined anywhere — the browser just uses the fallback and
 * nothing warns you. The git graph's changed-files list styled itself with
 * `var(--font-mono, monospace)`; because `--font-mono` is defined nowhere in
 * the codebase, every such rule quietly resolved to the generic `monospace`
 * family instead of the app font.
 *
 * These functions let a unit test resolve a declaration exactly the way the
 * browser would — against the real token table parsed from the real
 * stylesheet — so that class of silent degradation is caught in CI.
 */

/** Guards against `--a: var(--b)` / `--b: var(--a)` cycles. */
const MAX_RESOLVE_DEPTH = 16;

/**
 * Splits a `var()` argument list into its reference and fallback halves,
 * respecting nested parentheses so `var(--a, var(--b, x))` splits correctly.
 * Returns `null` when the arguments are malformed.
 */
function splitVarArgs(args: string): { name: string; fallback: string | null } | null {
  let depth = 0;
  for (let i = 0; i < args.length; i++) {
    const ch = args[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      const name = args.slice(0, i).trim();
      if (!name.startsWith("--")) return null;
      return { name, fallback: args.slice(i + 1).trim() };
    }
  }
  const name = args.trim();
  if (!name.startsWith("--")) return null;
  return { name, fallback: null };
}

/** Finds the index of the `)` closing the `(` at `open`, or -1 if unbalanced. */
function matchingParen(value: string, open: number): number {
  let depth = 0;
  for (let i = open; i < value.length; i++) {
    if (value[i] === "(") depth++;
    else if (value[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

/**
 * Parses every custom-property declaration in a stylesheet into a token table.
 *
 * Later declarations win, mirroring the cascade for same-specificity rules —
 * which is the common case for a `:root` token block.
 */
export function collectCustomProperties(css: string): Map<string, string> {
  const tokens = new Map<string, string>();
  const declaration = /(--[\w-]+)\s*:\s*([^;{}]+)[;}]/g;
  for (const [, name, value] of css.matchAll(declaration)) {
    tokens.set(name, value.trim());
  }
  return tokens;
}

/**
 * Resolves the `var()` references in a CSS value against `tokens`, returning
 * what the browser would actually compute.
 *
 * An undefined token resolves to its fallback; an undefined token with no
 * fallback resolves to the empty string (the declaration would be invalid at
 * computed-value time). Unbalanced or malformed `var()` syntax is left as-is
 * rather than throwing, so a caller always gets a comparable string.
 */
export function resolveCssValue(
  value: string,
  tokens: Map<string, string>,
  depth = 0,
): string {
  if (depth >= MAX_RESOLVE_DEPTH) return value.trim();

  const start = value.indexOf("var(");
  if (start === -1) return value.trim();

  const open = start + "var".length;
  const close = matchingParen(value, open);
  if (close === -1) return value.trim();

  const args = splitVarArgs(value.slice(open + 1, close));
  if (args === null) return value.trim();

  const defined = tokens.get(args.name);
  const replacement =
    defined !== undefined
      ? resolveCssValue(defined, tokens, depth + 1)
      : args.fallback !== null
        ? resolveCssValue(args.fallback, tokens, depth + 1)
        : "";

  const rewritten = value.slice(0, start) + replacement + value.slice(close + 1);
  return resolveCssValue(rewritten, tokens, depth + 1);
}

/**
 * Reads the value a rule declares for `property`, where the rule's selector
 * list contains `selector` as one of its comma-separated parts.
 *
 * Returns the last matching declaration (cascade order) or `null` when no rule
 * declares it. Deliberately naive — it targets flat component stylesheets, not
 * arbitrary CSS — but it reads the *shipped* source rather than a transcript
 * of it, so drift between the test and the component is impossible.
 */
export function findDeclaredValue(
  css: string,
  selector: string,
  property: string,
): string | null {
  let found: string | null = null;
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  for (const [, selectorList, body] of css.matchAll(rule)) {
    const targets = selectorList
      .split(",")
      .map((s) => s.trim())
      .includes(selector);
    if (!targets) continue;

    const declaration = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, "g");
    for (const [, value] of body.matchAll(declaration)) found = value.trim();
  }
  return found;
}

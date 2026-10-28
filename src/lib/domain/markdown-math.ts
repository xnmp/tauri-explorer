/**
 * Marked extension for TeX math in Markdown previews (#1393).
 *
 * Pure and KaTeX-free: the typesetter is injected (`MathTypesetter`) so this
 * module stays in the startup bundle while KaTeX itself is lazy-loaded only
 * when a document actually contains math (see `renderMarkdownBlocks`).
 *
 * Delimiters follow GitHub/Obsidian/Typora: inline `$…$` and `\(…\)`, display
 * `$$…$$` and `\[…\]`. Because these are Marked tokenizers, code spans and
 * fenced/indented code are never scanned, and `\$` stays an escaped dollar.
 * Currency such as `$5 and $10` is not math: an opening `$` must not be
 * followed by whitespace, and a closing `$` must not follow whitespace or
 * precede a digit.
 */

import type { MarkedExtension, Tokens } from "marked";

/** Typeset one TeX expression to HTML (display = block-level math). */
export type MathTypesetter = (tex: string, display: boolean) => string;

/** Formulas longer than this stay literal text (bounds pathological input). */
export const MAX_TEX_LENGTH = 5_000;

/** Cheap pre-check so documents without math never load KaTeX. */
export function mayContainMath(markdown: string): boolean {
  return /\$|\\[([]/.test(markdown);
}

interface MathToken extends Tokens.Generic {
  type: "mathBlock" | "mathInline";
  text: string;
  display: boolean;
}

const INLINE_PAREN = /^\\\(([\s\S]+?)\\\)/;
const INLINE_BRACKET = /^\\\[([\s\S]+?)\\\]/;
const INLINE_DOUBLE_DOLLAR = /^\$\$((?:\\[\s\S]|[^\\])+?)\$\$/;
// Body ends in a non-space char; the closer must not be followed by a digit.
const INLINE_DOLLAR = /^\$(?!\s)((?:\\[\s\S]|[^\\$\n])*?(?:\\\S|[^\\$\s]))\$(?!\d)/;
const BLOCK_DOLLAR = /^ {0,3}\$\$[ \t]*\n?([\s\S]*?)\n?[ \t]*\$\$[ \t]*(?:\n|$)/;
const BLOCK_BRACKET = /^ {0,3}\\\[[ \t]*\n?([\s\S]*?)\n?[ \t]*\\\][ \t]*(?:\n|$)/;

function mathToken(type: MathToken["type"], raw: string, body: string, display: boolean): MathToken | undefined {
  const text = body.trim();
  if (text === "" || text.length > MAX_TEX_LENGTH) return undefined;
  return { type, raw, text, display };
}

function inlineTokenizer(src: string): MathToken | undefined {
  const display = INLINE_DOUBLE_DOLLAR.exec(src);
  if (display) return mathToken("mathInline", display[0], display[1], true);
  const bracket = INLINE_BRACKET.exec(src);
  if (bracket) return mathToken("mathInline", bracket[0], bracket[1], true);
  const paren = INLINE_PAREN.exec(src);
  if (paren) return mathToken("mathInline", paren[0], paren[1], false);
  const dollar = INLINE_DOLLAR.exec(src);
  if (dollar) return mathToken("mathInline", dollar[0], dollar[1], false);
  return undefined;
}

function blockTokenizer(src: string): MathToken | undefined {
  const dollar = BLOCK_DOLLAR.exec(src);
  if (dollar) return mathToken("mathBlock", dollar[0], dollar[1], true);
  const bracket = BLOCK_BRACKET.exec(src);
  if (bracket) return mathToken("mathBlock", bracket[0], bracket[1], true);
  return undefined;
}

export function mathExtension(typeset: MathTypesetter): MarkedExtension {
  const render = (token: MathToken): string => {
    try {
      return typeset(token.text, token.display);
    } catch {
      // Typesetter bugs must not break the surrounding document: show source.
      return `<code class="md-math-error">${escape(token.raw)}</code>`;
    }
  };
  return {
    extensions: [
      {
        name: "mathBlock",
        level: "block",
        start: (src: string) => {
          // Marked probes with the first char sliced off, so only a true line
          // start (after a newline) may interrupt a paragraph.
          const at = src.search(/\n {0,3}(?:\$\$|\\\[)/);
          return at < 0 ? undefined : at + 1;
        },
        tokenizer: (src: string) => blockTokenizer(src),
        renderer: (token) => {
          const math = token as MathToken;
          return `<div class="md-math-block">${render(math)}</div>\n`;
        },
      },
      {
        name: "mathInline",
        level: "inline",
        start: (src: string) => {
          const at = src.search(/\$|\\[([]/);
          return at < 0 ? undefined : at;
        },
        tokenizer: (src: string) => inlineTokenizer(src),
        renderer: (token) => render(token as MathToken),
      },
    ],
  };
}

function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

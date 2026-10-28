/**
 * KaTeX typesetter for Markdown math (#1393). Imported only through a dynamic
 * `import()` from `renderMarkdownBlocks`, so KaTeX, its stylesheet and its
 * fonts (bundled, never a CDN) stay out of the startup chunk.
 */

import katex from "katex";
import "katex/dist/katex.min.css";
import type { MathTypesetter } from "./markdown-math";

export const typesetTex: MathTypesetter = (tex, display) =>
  katex.renderToString(tex, {
    displayMode: display,
    // Malformed TeX renders as an error span instead of throwing.
    throwOnError: false,
    trust: false,
    strict: "ignore",
    // Bound pathological input: macro expansion and user-specified sizes.
    maxExpand: 1000,
    maxSize: 50,
    output: "htmlAndMathml",
  });

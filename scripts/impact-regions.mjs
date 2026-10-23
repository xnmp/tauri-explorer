// impact-regions.mjs — static facts about the lines a diff touches (#1368).
//
// The test-impact map says which tests ran each original line (V8 block
// coverage through Vite's source maps). Lines that produce no code need a
// static proof instead, and new code needs to know what it is. Per line of a
// TypeScript/JavaScript module or Svelte component this reports:
//   trivia  comments and blank lines                 (no runtime effect)
//   type    type-only syntax: interfaces, type aliases, annotations,
//           `import type`, `declare`                 (no runtime effect)
//   import  an import/re-export statement, with its specifier
//   code    anything else
// and, for the selector's "a new function is only a binding" rule, the
// function/const-arrow declarations with the line span and name of each.
// Anything that cannot be parsed counts as `code`.
//
// The TypeScript compiler API is injected (`ts`), so this stays pure and a
// missing dependency degrades to `code` rather than failing.

/**
 * @typedef {"trivia" | "type" | "import" | "code"} RegionKind
 * @typedef {{ kind: RegionKind, specifier?: string }} LineRegion
 * @typedef {{ start: number, end: number, name: string, exported: boolean, topLevel: boolean }} Declaration
 *   1-based inclusive line span of a function declaration or of a `const`
 *   whose every initializer is a function.
 * @typedef {{ line: number, name: string }} FunctionHeader
 *   A line holding only a named function's header (its name, modifiers and
 *   parameters, up to the opening of its body): nothing on it runs until the
 *   function is called, except creating a function of that name.
 * @typedef {{ start: number, end: number, name: string }} Member
 *   1-based inclusive line span of a named method or function-valued
 *   property, on lines it has to itself.
 * @typedef {{ lines: LineRegion[], declarations: Declaration[], headers?: FunctionHeader[], members?: Member[] }} SourceFacts
 * @typedef {{ baseStart: number, baseCount: number, headStart: number, headCount: number }} Hunk
 */

/**
 * Parse `git diff -U0` output for one file into hunks (1-based lines). A
 * zero count means a pure insertion (base) or deletion (head) after the start
 * line.
 * @param {string} diff
 * @returns {Hunk[]}
 */
export function parseHunks(diff) {
  /** @type {Hunk[]} */
  const hunks = [];
  for (const m of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    hunks.push({
      baseStart: Number(m[1]),
      baseCount: m[2] === undefined ? 1 : Number(m[2]),
      headStart: Number(m[3]),
      headCount: m[4] === undefined ? 1 : Number(m[4]),
    });
  }
  return hunks;
}

const PRIORITY = { trivia: 0, type: 1, import: 2, code: 3 };

/**
 * @param {any} ts the `typescript` module
 * @param {string} text
 * @param {{ js?: boolean }} [options]
 * @returns {SourceFacts}
 */
export function scriptFacts(ts, text, { js = false } = {}) {
  const source = ts.createSourceFile("x." + (js ? "js" : "ts"), text, ts.ScriptTarget.Latest, true, js ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  const SK = ts.SyntaxKind;
  /** @type {Array<[number, number, RegionKind, string?]>} */
  const ranges = [];
  /** @type {Declaration[]} */
  const declarations = [];
  const add = (/** @type {number} */ start, /** @type {number} */ end, /** @type {RegionKind} */ kind, /** @type {string | undefined} */ specifier = undefined) => {
    if (end > start) ranges.push([start, end, kind, specifier]);
  };
  const lineOf = (/** @type {number} */ pos) => source.getLineAndCharacterOfPosition(pos).line + 1;
  const hasModifier = (/** @type {any} */ node, /** @type {number} */ kind) =>
    (ts.canHaveModifiers?.(node) ? ts.getModifiers(node) : node.modifiers)?.some((/** @type {any} */ m) => m.kind === kind) ?? false;
  const unwrap = (/** @type {any} */ e) => {
    while (e && (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression?.(e) || ts.isTypeAssertionExpression?.(e))) e = e.expression;
    return e;
  };
  const isFn = (/** @type {any} */ e) => e && (ts.isArrowFunction(e) || ts.isFunctionExpression(e));
  const typeOnlyModuleStatement = (/** @type {any} */ node) => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      if (!clause) return false; // side-effect import
      if (clause.isTypeOnly) return true;
      const named = clause.namedBindings;
      return !clause.name && named && ts.isNamedImports(named) && named.elements.length > 0 &&
        named.elements.every((/** @type {any} */ el) => el.isTypeOnly);
    }
    if (ts.isExportDeclaration(node)) {
      if (node.isTypeOnly) return true;
      const clause = node.exportClause;
      return Boolean(clause && ts.isNamedExports(clause) && clause.elements.length > 0 &&
        clause.elements.every((/** @type {any} */ el) => el.isTypeOnly));
    }
    return false;
  };
  const declare = (/** @type {any} */ node, /** @type {string} */ name, /** @type {boolean} */ topLevel) => {
    declarations.push({
      start: lineOf(node.getStart(source)),
      end: lineOf(Math.max(node.getStart(source), node.end - 1)),
      name,
      exported: hasModifier(node, SK.ExportKeyword) || hasModifier(node, SK.DefaultKeyword),
      topLevel,
    });
  };

  /** @type {FunctionHeader[]} */
  const headers = [];
  /** @type {Member[]} */
  const members = [];
  const nameText = (/** @type {any} */ n) => n && (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isPrivateIdentifier?.(n)) ? n.text : null;
  /** The declaration that owns function `fn`, and its name, or null. */
  const ownerOf = (/** @type {any} */ fn) => {
    if (ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn) || ts.isGetAccessorDeclaration(fn) || ts.isSetAccessorDeclaration(fn)) {
      const name = nameText(fn.name);
      return name ? { owner: fn, name } : null;
    }
    if (ts.isConstructorDeclaration(fn)) return { owner: fn, name: "constructor" };
    if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return null;
    let p = fn.parent;
    while (p && (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isSatisfiesExpression?.(p))) p = p.parent;
    if (p && ts.isPropertyAssignment(p) && unwrap(p.initializer) === fn) {
      const name = nameText(p.name);
      return name ? { owner: p, name } : null;
    }
    if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name) && unwrap(p.initializer) === fn &&
        p.parent?.declarations?.length === 1 && p.parent.parent && ts.isVariableStatement(p.parent.parent)) {
      return { owner: p.parent.parent, name: p.name.text };
    }
    return null;
  };
  const header = (/** @type {any} */ fn) => {
    if (!fn.body) return;
    const found = ownerOf(fn);
    if (!found) return;
    const start = found.owner.getStart(source);
    const lineStart = text.lastIndexOf("\n", start - 1) + 1;
    if (text.slice(lineStart, start).trim() !== "") return;
    for (let line = lineOf(start); line <= lineOf(fn.body.getStart(source)); line++) headers.push({ line, name: found.name });
    const owner = found.owner;
    if (ts.isMethodDeclaration(owner) || ts.isPropertyAssignment(owner) || ts.isGetAccessorDeclaration(owner) || ts.isSetAccessorDeclaration(owner)) {
      const lineEnd = text.indexOf("\n", owner.end);
      if (/^[\s,;]*$/.test(text.slice(owner.end, lineEnd === -1 ? text.length : lineEnd))) {
        members.push({ start: lineOf(start), end: lineOf(owner.end - 1), name: found.name });
      }
    }
  };

  /** @param {any} node @param {boolean} topLevel */
  const visit = (node, topLevel) => {
    if (ts.isFunctionLike(node)) header(node);
    if (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments?.(node)) { add(node.getStart(source), node.end, "type"); return; }
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || hasModifier(node, SK.DeclareKeyword)) {
      add(node.getStart(source), node.end, "type");
      return;
    }
    if (ts.isImportDeclaration(node) || (ts.isExportDeclaration(node) && node.moduleSpecifier)) {
      const spec = node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : undefined;
      add(node.getStart(source), node.end, typeOnlyModuleStatement(node) ? "type" : "import", spec);
      return;
    }
    if (ts.isExportDeclaration(node) && typeOnlyModuleStatement(node)) { add(node.getStart(source), node.end, "type"); return; }
    if (ts.isFunctionDeclaration(node) && node.body && node.name) declare(node, node.name.text, topLevel);
    if (ts.isVariableStatement(node) && node.declarationList.declarations.length === 1) {
      const d = node.declarationList.declarations[0];
      if (ts.isIdentifier(d.name) && isFn(unwrap(d.initializer))) declare(node, d.name.text, topLevel);
    }
    const child = ts.isFunctionLike(node) ? false : topLevel && (ts.isSourceFile(node) || ts.isModuleBlock?.(node));
    ts.forEachChild(node, (/** @type {any} */ c) => visit(c, child));
  };
  for (const statement of source.statements) visit(statement, true);

  const lineCount = text.split("\n").length;
  /** @type {LineRegion[]} */
  const lines = Array.from({ length: lineCount }, () => ({ kind: /** @type {RegionKind} */ ("trivia") }));
  const regionAt = (/** @type {number} */ pos) => {
    // The narrowest range containing pos decides; ties prefer type.
    /** @type {[number, number, RegionKind, string?] | null} */
    let best = null;
    for (const r of ranges) {
      if (pos < r[0] || pos >= r[1]) continue;
      if (!best || r[1] - r[0] < best[1] - best[0] || (r[1] - r[0] === best[1] - best[0] && r[2] === "type")) best = r;
    }
    return best ? { kind: best[2], specifier: best[3] } : { kind: /** @type {RegionKind} */ ("code") };
  };
  // Leaf nodes of the parsed tree are its tokens (comments are trivia;
  // template literals and regexes are whole tokens). Mark every line a token
  // spans with the most impactful kind on it.
  /** @param {any} node */
  const leaves = (node) => {
    if (ts.isJSDoc?.(node) || node.kind === SK.EndOfFileToken) return;
    const children = node.getChildren(source);
    if (children.length === 0) {
      const start = node.getStart(source);
      if (node.end <= start) return;
      const region = regionAt(start);
      for (let line = lineOf(start); line <= lineOf(node.end - 1); line++) {
        if (PRIORITY[region.kind] > PRIORITY[lines[line - 1].kind]) lines[line - 1] = region;
      }
      return;
    }
    for (const child of children) leaves(child);
  };
  leaves(source);
  return { lines, declarations, headers, members };
}

/** @param {string} text @param {number} offset */
const lineAt = (text, offset) => text.slice(0, offset).split("\n").length; // 1-based

/**
 * Facts for a Svelte component: script contents are classified as
 * TypeScript/JavaScript; markup, styles, the script/style tags themselves and
 * `<svelte:options>` are `code`. Only `<script module>` declarations count as
 * top-level; instance-script exports are component API and never count as
 * mere bindings.
 * @param {any} ts
 * @param {string} text
 * @returns {SourceFacts}
 */
export function svelteFacts(ts, text) {
  /** @type {LineRegion[]} */
  const lines = text.split("\n").map((line) => ({ kind: /** @type {RegionKind} */ (line.trim() === "" ? "trivia" : "code") }));
  /** @type {Declaration[]} */
  const declarations = [];
  /** @type {FunctionHeader[]} */
  const headers = [];
  /** @type {Member[]} */
  const members = [];
  for (const m of text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/g)) {
    const [whole, attrs, content] = m;
    const contentStart = /** @type {number} */ (m.index) + whole.indexOf(">") + 1;
    const first = lineAt(text, contentStart);
    const isModule = /\bmodule\b|context\s*=\s*["']module["']/.test(attrs);
    const facts = scriptFacts(ts, content, { js: !/lang\s*=\s*["']ts["']/.test(attrs) });
    // The opening tag shares its line with the first content line.
    facts.lines.forEach((region, i) => {
      const n = first + i;
      if (i === 0 || n === lineAt(text, /** @type {number} */ (m.index) + whole.length)) {
        lines[n - 1] = { kind: "code" };
        return;
      }
      lines[n - 1] = region;
    });
    for (const d of facts.declarations) {
      declarations.push({
        ...d,
        start: d.start + first - 1,
        end: d.end + first - 1,
        topLevel: isModule && d.topLevel,
      });
    }
    // The opening tag's line also holds tag text; never count it a header.
    for (const h of facts.headers ?? []) if (h.line > 1) headers.push({ ...h, line: h.line + first - 1 });
    for (const d of facts.members ?? []) if (d.start > 1) members.push({ ...d, start: d.start + first - 1, end: d.end + first - 1 });
  }
  return { lines, declarations, headers, members };
}

/**
 * Facts of a module's text, or null when the file type is not a module
 * (callers treat that as unknown). With no `ts`, or unparseable text, every
 * non-blank line is `code` and there are no declarations.
 * @param {any} ts
 * @param {string} file
 * @param {string} text
 * @returns {SourceFacts | null}
 */
export function factsOf(ts, file, text) {
  if (!/\.(svelte|ts|js|mjs)$/.test(file)) return null;
  const fallback = () => ({
    lines: text.split("\n").map((l) => ({ kind: /** @type {RegionKind} */ (l.trim() === "" ? "trivia" : "code") })),
    declarations: [],
  });
  if (!ts) return fallback();
  try {
    return file.endsWith(".svelte") ? svelteFacts(ts, text) : scriptFacts(ts, text, { js: /\.m?js$/.test(file) });
  } catch {
    return fallback();
  }
}

/**
 * Resolve an import specifier written in `from` to a repo path, or null for
 * a package or an unresolvable path.
 * @param {string} from repo path of the importing file
 * @param {string} specifier
 * @param {(path: string) => boolean} exists
 */
export function resolveSpecifier(from, specifier, exists) {
  let base;
  if (specifier === "$lib" || specifier.startsWith("$lib/")) base = "src/lib" + specifier.slice(4);
  else if (specifier.startsWith("/src/")) base = specifier.slice(1);
  else if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const parts = from.split("/").slice(0, -1);
    for (const seg of specifier.split("/")) {
      if (seg === "." || seg === "") continue;
      if (seg === "..") parts.pop();
      else parts.push(seg);
    }
    base = parts.join("/");
  } else return null;
  base = base.replace(/\?.*$/, "");
  const candidates = [base, base.replace(/\.js$/, ".ts"), `${base}.ts`, `${base}.js`, `${base}.svelte`, `${base}.svelte.ts`, `${base}/index.ts`, `${base}/index.js`];
  return candidates.find(exists) ?? null;
}

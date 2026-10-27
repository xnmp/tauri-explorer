// impact-regions.mjs — static facts about the lines a diff touches (#1368).
//
// The test-impact map says which tests ran each original line (V8 block
// coverage through Vite's source maps). The selector scopes a change to the
// function around it and needs static proof for lines that produce no code.
// Per line of a TypeScript/JavaScript module or Svelte component this reports:
//   trivia  comments and blank lines                 (no runtime effect)
//   type    type-only syntax: interfaces, type aliases, annotations,
//           `import type`, `declare`                 (no runtime effect)
//   import  an import/re-export statement, with its specifier
//   code    anything else
// plus every function with a body (its header, body and closing lines) and
// every import statement's value bindings, in source order.
// Anything that cannot be parsed counts as `code`.
//
// The TypeScript compiler API is injected (`ts`), so this stays pure and a
// missing dependency degrades to `code` rather than failing.

/**
 * @typedef {"trivia" | "type" | "import" | "code"} RegionKind
 * @typedef {{ kind: RegionKind, specifier?: string }} LineRegion
 * @typedef {{ start: number, body: number, end: number }} FunctionSpan
 *   1-based lines of a function with a body: where its declaration starts,
 *   where its body starts, and where it ends.
 * @typedef {{ specifier: string, bindings: string[] | null, erased: boolean }} ImportFact
 *   One import or re-export statement, in source order: its value bindings
 *   as `local=imported` (`*` for a namespace, `default`), null for a
 *   side-effect import or a re-export (never mere bindings); `erased` for
 *   `import type` / `export type`, which emit nothing.
 * @typedef {{ lines: LineRegion[], functions: FunctionSpan[], imports: ImportFact[] }} SourceFacts
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
  /** @type {FunctionSpan[]} */
  const functions = [];
  const add = (/** @type {number} */ start, /** @type {number} */ end, /** @type {RegionKind} */ kind, /** @type {string | undefined} */ specifier = undefined) => {
    if (end > start) ranges.push([start, end, kind, specifier]);
  };
  const lineOf = (/** @type {number} */ pos) => source.getLineAndCharacterOfPosition(pos).line + 1;
  const hasModifier = (/** @type {any} */ node, /** @type {number} */ kind) =>
    (ts.canHaveModifiers?.(node) ? ts.getModifiers(node) : node.modifiers)?.some((/** @type {any} */ m) => m.kind === kind) ?? false;
  // Only `import type` / `export type` statements are erased. The project
  // compiles with verbatimModuleSyntax, which keeps `import { type A } from
  // "x"` as `import {} from "x"`: the module still evaluates.
  const typeOnlyModuleStatement = (/** @type {any} */ node) =>
    ts.isImportDeclaration(node) ? Boolean(node.importClause?.isTypeOnly)
    : ts.isExportDeclaration(node) ? Boolean(node.isTypeOnly)
    : false;
  /** @type {ImportFact[]} */
  const imports = [];
  /** @param {any} node */
  const importFact = (node) => {
    const specifier = node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : null;
    if (!specifier) return;
    const erased = typeOnlyModuleStatement(node);
    const clause = ts.isImportDeclaration(node) ? node.importClause : null;
    if (!clause) { imports.push({ specifier, bindings: null, erased }); return; }
    /** @type {string[]} */
    const bindings = [];
    if (clause.name) bindings.push(`${clause.name.text}=default`);
    const named = clause.namedBindings;
    if (named && ts.isNamespaceImport(named)) bindings.push(`${named.name.text}=*`);
    if (named && ts.isNamedImports(named)) {
      for (const el of named.elements) {
        if (el.isTypeOnly) continue;
        bindings.push(`${el.name.text}=${(el.propertyName ?? el.name).text}`);
      }
    }
    imports.push({ specifier, bindings: erased ? [] : bindings, erased });
  };

  /** @param {any} node */
  const visit = (node) => {
    if (ts.isFunctionLike(node) && node.body) {
      functions.push({ start: lineOf(node.getStart(source)), body: lineOf(node.body.getStart(source)), end: lineOf(node.end - 1) });
    }
    if (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments?.(node)) { add(node.getStart(source), node.end, "type"); return; }
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || hasModifier(node, SK.DeclareKeyword)) {
      add(node.getStart(source), node.end, "type");
      return;
    }
    if (ts.isImportDeclaration(node) || (ts.isExportDeclaration(node) && node.moduleSpecifier)) {
      importFact(node);
      const spec = node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : undefined;
      add(node.getStart(source), node.end, typeOnlyModuleStatement(node) ? "type" : "import", spec);
      return;
    }
    if (ts.isExportDeclaration(node) && typeOnlyModuleStatement(node)) { add(node.getStart(source), node.end, "type"); return; }
    ts.forEachChild(node, visit);
  };
  for (const statement of source.statements) visit(statement);

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
  return { lines, functions, imports };
}

/** @param {string} text @param {number} offset */
const lineAt = (text, offset) => text.slice(0, offset).split("\n").length; // 1-based

/**
 * Facts for a Svelte component: script contents are classified as
 * TypeScript/JavaScript; markup, styles, the script/style tags themselves and
 * `<svelte:options>` are `code`, outside every function.
 * @param {any} ts
 * @param {string} text
 * @returns {SourceFacts}
 */
export function svelteFacts(ts, text) {
  /** @type {LineRegion[]} */
  const lines = text.split("\n").map((line) => ({ kind: /** @type {RegionKind} */ (line.trim() === "" ? "trivia" : "code") }));
  /** @type {FunctionSpan[]} */
  const functions = [];
  /** @type {ImportFact[]} */
  const imports = [];
  for (const m of text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/g)) {
    const [whole, attrs, content] = m;
    const contentStart = /** @type {number} */ (m.index) + whole.indexOf(">") + 1;
    const first = lineAt(text, contentStart);
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
    for (const f of facts.functions) {
      functions.push({ start: f.start + first - 1, body: f.body + first - 1, end: f.end + first - 1 });
    }
    imports.push(...facts.imports);
  }
  return { lines, functions, imports };
}

/**
 * Facts of a module's text, or null when the file type is not a module
 * (callers treat that as unknown). With no `ts`, or unparseable text, every
 * non-blank line is `code` and no function or import is known.
 * @param {any} ts
 * @param {string} file
 * @param {string} text
 * @returns {SourceFacts | null}
 */
export function factsOf(ts, file, text) {
  if (!/\.(svelte|ts|js|mjs)$/.test(file)) return null;
  const fallback = () => ({
    lines: text.split("\n").map((l) => ({ kind: /** @type {RegionKind} */ (l.trim() === "" ? "trivia" : "code") })),
    functions: [],
    imports: [],
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

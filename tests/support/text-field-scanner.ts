export const REQUIRED = ["autocorrect", "autocapitalize", "spellcheck"] as const;
const NON_TEXT_TYPES = new Set([
  "checkbox", "radio", "range", "color", "file", "number", "hidden",
  "button", "submit", "reset", "image", "date", "datetime-local", "time", "month", "week",
]);

export interface Field {
  tag: "input" | "textarea";
  line: number;
  source: string;
}

/** Index just past the `{...}` expression opening at `i`, honouring nested braces and strings. */
function skipExpression(src: string, i: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i + 1;
  }
  return src.length;
}

/** Index of the `>` that closes the tag opening at `start`, skipping quoted values and `{}` expressions. */
function findTagEnd(src: string, start: number): number {
  let i = start;
  while (i < src.length) {
    const c = src[i];
    if (c === "{") i = skipExpression(src, i);
    else if (c === '"' || c === "'") {
      const close = src.indexOf(c, i + 1);
      i = close < 0 ? src.length : close + 1;
    } else if (c === ">") return i;
    else i++;
  }
  return src.length;
}

/** Every `<input>` / `<textarea>` opening tag in a component source. */
export function findFields(src: string): Field[] {
  const fields: Field[] = [];
  const re = /<(input|textarea)(?=[\s/>])/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const end = findTagEnd(src, m.index + m[0].length);
    fields.push({
      tag: m[1] as Field["tag"],
      line: src.slice(0, m.index).split("\n").length,
      source: src.slice(m.index, end + 1),
    });
    re.lastIndex = end;
  }
  return fields;
}

/** Attribute names present on a tag, with `{...}` expressions and quoted values blanked out. */
export function attributeNames(tagSource: string): Set<string> {
  let out = "";
  const body = tagSource.replace(/^<\w+/, "");
  for (let i = 0; i < body.length; ) {
    const c = body[i];
    if (c === "{") {
      const next = skipExpression(body, i);
      out += body.slice(i, i + 1) === "{" && /^\{\s*\.\.\./.test(body.slice(i, next)) ? " {...} " : " _ ";
      i = next;
    } else if (c === '"' || c === "'") {
      const close = body.indexOf(c, i + 1);
      i = close < 0 ? body.length : close + 1;
      out += " _ ";
    } else {
      out += c;
      i++;
    }
  }
  return new Set(out.match(/[^\s=/<>{}]+(?==|\s|$)/g)?.filter((n) => n !== "_") ?? []);
}

/** True when the field's `type` is statically a non-text control. */
function isNonText(tagSource: string): boolean {
  const m = /\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*["'`]([^"'`]*)["'`]\s*\})/.exec(tagSource);
  const type = m?.[1] ?? m?.[2] ?? m?.[3];
  return type !== undefined && NON_TEXT_TYPES.has(type.trim().toLowerCase());
}

/** Fields in `src` that are missing at least one required attribute. */
export function findViolations(src: string): { line: number; missing: string[] }[] {
  return findFields(src).flatMap((f) => {
    if (f.tag === "input" && isNonText(f.source)) return [];
    const names = attributeNames(f.source);
    // A spread may supply the attributes; it can't be verified statically, so it does not exempt the field.
    const missing = REQUIRED.filter((a) => !names.has(a));
    return missing.length ? [{ line: f.line, missing }] : [];
  });
}


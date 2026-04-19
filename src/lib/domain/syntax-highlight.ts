/**
 * Syntax highlighting utility using highlight.js.
 * Issue: tauri-explorer-92ka
 *
 * Uses highlight.js core with tree-shaken language imports.
 * Maps file extensions to languages for the preview pane.
 */

import hljs from "highlight.js/lib/core";

// Language imports (tree-shaken: only what we register is bundled)
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import xml from "highlight.js/lib/languages/xml";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import lua from "highlight.js/lib/languages/lua";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import perl from "highlight.js/lib/languages/perl";
import php from "highlight.js/lib/languages/php";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import yaml from "highlight.js/lib/languages/yaml";

// Register languages
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("c", c);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("csharp", csharp);
hljs.registerLanguage("css", css);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("go", go);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("ini", ini);
hljs.registerLanguage("java", java);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("kotlin", kotlin);
hljs.registerLanguage("lua", lua);
hljs.registerLanguage("makefile", makefile);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("perl", perl);
hljs.registerLanguage("php", php);
hljs.registerLanguage("python", python);
hljs.registerLanguage("ruby", ruby);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("scss", scss);
hljs.registerLanguage("shell", shell);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("swift", swift);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("yaml", yaml);

// Register extension aliases
hljs.registerAliases(["sh", "zsh", "fish"], { languageName: "bash" });
hljs.registerAliases(["h"], { languageName: "c" });
hljs.registerAliases(["cc", "cxx", "hpp", "hxx", "hh"], { languageName: "cpp" });
hljs.registerAliases(["cs"], { languageName: "csharp" });
hljs.registerAliases(["patch"], { languageName: "diff" });
hljs.registerAliases(["htm", "html", "svg", "svelte", "vue", "jsx", "tsx"], { languageName: "xml" });
hljs.registerAliases(["toml", "cfg", "conf", "env", "properties"], { languageName: "ini" });
hljs.registerAliases(["js", "mjs", "cjs"], { languageName: "javascript" });
hljs.registerAliases(["jsonc", "json5"], { languageName: "json" });
hljs.registerAliases(["kt", "kts"], { languageName: "kotlin" });
hljs.registerAliases(["mk", "makefile"], { languageName: "makefile" });
hljs.registerAliases(["md", "mdx"], { languageName: "markdown" });
hljs.registerAliases(["pl", "pm"], { languageName: "perl" });
hljs.registerAliases(["py", "pyw", "pyi"], { languageName: "python" });
hljs.registerAliases(["rb", "gemspec", "rake"], { languageName: "ruby" });
hljs.registerAliases(["rs"], { languageName: "rust" });
hljs.registerAliases(["sass"], { languageName: "scss" });
hljs.registerAliases(["ts", "mts", "cts"], { languageName: "typescript" });
hljs.registerAliases(["yml"], { languageName: "yaml" });

/** Highlight code based on filename extension. Returns HTML string. */
export function highlightCode(code: string, filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  if (ext && hljs.getLanguage(ext)) {
    return hljs.highlight(code, { language: ext, ignoreIllegals: true }).value;
  }
  // Try auto-detection as fallback
  const result = hljs.highlightAuto(code);
  return result.value;
}

/** Check if a file extension has a registered language. */
export function hasLanguageSupport(filename: string): boolean {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return !!hljs.getLanguage(ext);
}

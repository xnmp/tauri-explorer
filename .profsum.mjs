import fs from "node:fs"; import path from "node:path";
import { SourceMapConsumer } from "source-map-js";
const profile = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const maps = new Map();
const consumer = (url) => {
  const file = url.split("/").slice(-1)[0]; if (!file.endsWith(".js")) return null;
  if (!maps.has(file)) { const found = ["build/_app/immutable/chunks", "build/_app/immutable/nodes", "build/_app/immutable/entry"].map((d) => path.join(d, file + ".map")).find((p) => fs.existsSync(p)); maps.set(file, found ? new SourceMapConsumer(JSON.parse(fs.readFileSync(found, "utf8"))) : null); }
  return maps.get(file);
};
const name = (cf) => {
  const c = consumer(cf.url);
  if (c) { const o = c.originalPositionFor({ line: cf.lineNumber + 1, column: cf.columnNumber }); if (o.source) return `${o.name ?? cf.functionName ?? "?"} ${o.source.split("/").slice(-2).join("/")}:${o.line}`; }
  return `${cf.functionName || "(anon)"} ${cf.url.split("/").slice(-1)[0]}`;
};
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const parent = new Map(); for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const self = new Map(), total = new Map();
profile.samples.forEach((id, i) => {
  const ms = (profile.timeDeltas[i] ?? 0) / 1000; const n = byId.get(id); const k = name(n.callFrame);
  self.set(k, (self.get(k) ?? 0) + ms);
  const seen = new Set(); let cur = id; while (cur !== undefined) { const kk = name(byId.get(cur).callFrame); if (!seen.has(kk)) { seen.add(kk); total.set(kk, (total.get(kk) ?? 0) + ms); } cur = parent.get(cur); }
});
const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${v.toFixed(1).padStart(7)} ms  ${k}`).join("\n");
console.log("== self\n" + top(self, 25)); console.log("== total\n" + top(total, 40));

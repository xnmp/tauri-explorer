import { chromium } from "@playwright/test";
import fs from "node:fs";
const N = process.env.N ?? "200000";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
await page.goto(`http://localhost:1470/?path=/perf/huge-${N}`);
const rows = page.locator(".pane-tree:not(.retained) .entry-item[data-path]");
await rows.first().waitFor({ timeout: 120000 });
await page.waitForTimeout(1500);
const back = page.locator('.nav-btn[aria-label="Go back"]');
const cdp = await page.context().newCDPSession(page);
await cdp.send("Profiler.enable");
await cdp.send("Profiler.setSamplingInterval", { interval: 100 });
for (let i = 0; i < 3; i++) {
  await rows.first().dblclick(); await page.waitForFunction((p) => document.querySelector(".status-path")?.getAttribute("title") !== p, `/perf/huge-${N}`); await page.waitForTimeout(800);
  if (i === 2) await cdp.send("Profiler.start");
  const t = Date.now();
  await back.click();
  await page.waitForFunction((p) => document.querySelector(".status-path")?.getAttribute("title") === p && !!document.querySelector(`.pane-tree:not(.retained) .entry-item[data-path^="${p}/"]`), `/perf/huge-${N}`, { timeout: 120000 });
  console.log("back ms", Date.now() - t);
}
await page.waitForTimeout(300);
const { profile } = await cdp.send("Profiler.stop");
fs.writeFileSync(process.env.OUT, JSON.stringify(profile));
// self time per function
const self = new Map(); const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const dt = profile.timeDeltas; 
profile.samples.forEach((id, i) => { const n = byId.get(id); const k = `${n.callFrame.functionName || "(anon)"} ${n.callFrame.url.split("/").slice(-1)[0]}:${n.callFrame.lineNumber}`; self.set(k, (self.get(k) ?? 0) + (dt[i] ?? 0) / 1000); });
console.log([...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, v]) => `${v.toFixed(1).padStart(7)} ms  ${k}`).join("\n"));
await browser.close();

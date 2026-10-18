import { browser, $ } from "@wdio/globals";
import fs from "node:fs";
import { navigateTo, domText } from "../specs/helpers";

const dirs = (process.env.PROBE_DIRS ?? "").split(",").filter(Boolean);
const out = process.env.PROBE_OUT ?? "/tmp/probe.jsonl";
const ROUNDS = Number(process.env.PROBE_ROUNDS ?? 3);
const previews = (process.env.PROBE_PREVIEW ?? "0").split(",").map((v) => v === "1");
const variants = (process.env.PROBE_VARIANTS ?? "normal").split(",").filter(Boolean);
const view = process.env.PROBE_VIEW ?? "tiles";

const VARIANT_CSS: Record<string, string> = {
  normal: "",
  // Pre-#1051 band emulation: hide the transform-only layers and drive a
  // sibling element with the old width/height/translate writes (see below).
  legacyresize: ".marquee-rect,.marquee-edge{visibility:hidden !important}",
  norect: ".marquee-rect,.marquee-edge{display:none !important}",
  nosel: ".tile-item.selected,.list-item.selected{background:transparent !important;border-color:transparent !important;border-radius:var(--radius-md) !important}",
  noimg: ".thumbnail-container img{visibility:hidden !important}",
  nothumb: ".thumbnail-container{display:none !important}",
  nohover: ".tile-item:hover,.list-item:hover{background:transparent !important}",
  rectlayer: ".marquee-rect{will-change:transform !important;contain:strict !important}",
  rectflat: ".marquee-rect{background:none !important;border:none !important}",
  rectfixedsize: ".marquee-rect{width:400px !important;height:300px !important}",
  contenthidden: ".file-list .content{overflow:hidden !important}",
  contentclip: ".file-list .content{overflow:clip !important}",
  contentpaint: ".file-list .content{contain:paint !important}",
  rectcontain: ".marquee-rect{contain:strict !important}",
};

async function keyChord(key: string, modifiers: string[]) {
  await browser.performActions([{ type: "key", id: "k", actions: [
    ...modifiers.map((value) => ({ type: "keyDown" as const, value })),
    { type: "keyDown", value: key }, { type: "keyUp", value: key },
    ...[...modifiers].reverse().map((value) => ({ type: "keyUp" as const, value })),
  ] }]);
  await browser.releaseActions();
}
async function command(label: string) {
  await keyChord("p", ["", ""]);
  const input = $(".command-palette-dialog .search-input");
  await input.waitForDisplayed();
  await input.setValue(label);
  await browser.waitUntil(async () => (await domText(".command-palette-dialog")).includes(label));
  await browser.keys("Enter");
  await $(".command-palette-dialog").waitForExist({ reverse: true });
}
const settle = () => browser.executeAsync((done) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => done())), 1500));

describe("marquee probe", () => {
  for (const preview of previews) {
    for (const dir of dirs) {
      it(`${dir} preview=${preview}`, async () => {
        await navigateTo(dir);
        if (preview) await command("Dock Preview Pane Right");
        await command(view === "list" ? "List View" : "Tiles View");
        await $(view === "list" ? ".list-view" : ".tiles-view").waitForDisplayed();
        await browser.setWindowSize(1600, 1000).catch(() => {});
        await settle();
        await browser.pause(4000);
        await settle();
        const idle = await browser.executeAsync((done) => { const f: number[] = []; const t = (x: number) => { f.push(x); if (f.length < 40) requestAnimationFrame(t); else { const g = f.slice(1).map((v, i) => v - f[i]).sort((a, b) => a - b); done(g[Math.floor(g.length / 2)]); } }; requestAnimationFrame(t); });
        if (process.env.PROBE_SHOT) {
          const shotGeo = await browser.execute((itemSel: string) => {
            const content = document.querySelector(".file-list .content")!.getBoundingClientRect();
            const tiles = Array.from(document.querySelectorAll<HTMLElement>(itemSel)).map((e) => e.getBoundingClientRect());
            const bg = ["tile-row", "tile-group", "tiles-view", "virtual-viewport", "virtual-item", "content", "list-row", "list-view"];
            let start: { x: number; y: number } | null = null;
            for (let y = Math.round(content.top + 2); y < tiles[0].bottom && !start; y += 2)
              for (let x = Math.round(content.left + 2); x < content.left + 300 && !start; x += 2) {
                const el = document.elementFromPoint(x, y) as HTMLElement | null;
                if (el && bg.some((c) => el.classList.contains(c))) start = { x, y };
              }
            return { start, end: { x: Math.round(content.left + content.width * 0.72), y: Math.round(content.top + content.height * 0.68) } };
          }, view === "list" ? ".list-item" : ".tile-item");
          await browser.executeAsync((g: any, done: () => void) => {
            const opts = (x: number, y: number, buttons: number) => ({ bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons, view: window });
            document.elementFromPoint(g.start.x, g.start.y)!.dispatchEvent(new MouseEvent("mousedown", opts(g.start.x, g.start.y, 1)));
            let i = 0;
            const step = () => {
              i++;
              const f = i / 12;
              document.body.dispatchEvent(new MouseEvent("mousemove", opts(Math.round(g.start.x + (g.end.x - g.start.x) * f), Math.round(g.start.y + (g.end.y - g.start.y) * f), 1)));
              if (i < 12) requestAnimationFrame(step); else requestAnimationFrame(() => requestAnimationFrame(() => done()));
            };
            requestAnimationFrame(step);
          }, shotGeo);
          await browser.pause(300);
          const name = `${process.env.PROBE_SHOT}-${dir.split("/").at(-1)}-${view}${preview ? "-preview" : ""}.png`;
          await browser.saveScreenshot(name);
          await browser.execute((g: any) => {
            document.body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, clientX: g.end.x, clientY: g.end.y, button: 0, buttons: 0, view: window }));
          }, shotGeo);
          await settle();
          await browser.keys("Escape");
          await settle();
        }
        for (const variant of variants) {
          await browser.execute((css: string) => {
            document.getElementById("probe-variant")?.remove();
            const style = document.createElement("style");
            style.id = "probe-variant";
            style.textContent = css;
            document.head.appendChild(style);
          }, VARIANT_CSS[variant] ?? variant);
          await settle();
          for (let round = 0; round < ROUNDS; round++) {
            const geo = await browser.execute((itemSel: string) => {
              const content = document.querySelector(".file-list .content")!.getBoundingClientRect();
              const tiles = Array.from(document.querySelectorAll<HTMLElement>(itemSel)).map((e) => e.getBoundingClientRect());
              const first = tiles[0];
              const bg = ["tile-row", "tile-group", "tiles-view", "virtual-viewport", "virtual-item", "content", "list-row", "list-view"];
              let start: { x: number; y: number } | null = null;
              for (let y = Math.round(content.top + 2); y < first.bottom && !start; y += 2)
                for (let x = Math.round(content.left + 2); x < content.left + 300 && !start; x += 2) {
                  const el = document.elementFromPoint(x, y) as HTMLElement | null;
                  if (el && bg.some((c) => el.classList.contains(c))) start = { x, y };
                }
              return { start, right: Math.round(content.right - 40), bottom: Math.round(content.bottom - 40), tiles: tiles.length };
            }, view === "list" ? ".list-item" : ".tile-item");
            if (!geo.start) throw new Error("no background point");
            const raw = await browser.executeAsync((g: any, legacy: boolean, done: (r: unknown) => void) => {
              const frames: number[] = []; const js: number[] = []; const sel: number[] = [];
              const w = window as any;
              const origRaf = w.requestAnimationFrame.bind(window);
              let frameJs = 0;
              // Emulate the pre-#1051 band inside the same session: a sibling
              // element with the old CSS whose width/height/translate are
              // rewritten every frame from the (hidden) fill's rendered box.
              let legacyOn = legacy;
              const content = document.querySelector<HTMLElement>(".file-list .content")!;
              let legacyEl: HTMLElement | null = null;
              if (legacy) {
                legacyEl = document.createElement("div");
                legacyEl.style.cssText = "position:absolute;left:0;top:0;pointer-events:none;z-index:10;" +
                  "background:color-mix(in srgb, var(--accent) 15%, transparent);border:1px solid var(--accent);" +
                  "border-radius:2px;will-change:transform,width,height;";
                content.appendChild(legacyEl);
              }
              const legacyLoop = () => {
                if (!legacyOn) { legacyEl?.remove(); return; }
                const fill = document.querySelector<HTMLElement>(".marquee-rect");
                if (fill && legacyEl) {
                  const r = fill.getBoundingClientRect();
                  const c = content.getBoundingClientRect();
                  legacyEl.style.width = `${r.width}px`; legacyEl.style.height = `${r.height}px`;
                  legacyEl.style.transform = `translate(${r.left - c.left}px, ${r.top - c.top}px)`;
                }
                origRaf(legacyLoop);
              };
              if (legacy) origRaf(legacyLoop);
              // Time every rAF callback plus the microtasks it queues (Svelte's flush).
              w.requestAnimationFrame = (cb: FrameRequestCallback) => origRaf((t: number) => {
                const s = performance.now();
                try { cb(t); } finally { queueMicrotask(() => { frameJs += performance.now() - s; }); }
              });
              const startEl = document.elementFromPoint(g.start.x, g.start.y)!;
              const opts = (x: number, y: number, buttons: number) => ({ bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons, view: window });
              startEl.dispatchEvent(new MouseEvent("mousedown", opts(g.start.x, g.start.y, 1)));
              const steps = 120; let i = 0;
              const tick = (t: number) => {
                frames.push(t); js.push(frameJs); frameJs = 0;
                sel.push(document.querySelectorAll(".entry-item.selected").length);
                i++;
                if (i > steps) {
                  document.body.dispatchEvent(new MouseEvent("mouseup", opts(g.start.x, g.start.y, 0)));
                  legacyOn = false;
                  origRaf(() => origRaf(() => { w.requestAnimationFrame = origRaf; done({ frames, js, sel }); }));
                  return;
                }
                const f = i <= 80 ? i / 80 : 1 - (i - 80) / 80;
                const x = Math.round(g.start.x + (g.right - g.start.x) * f), y = Math.round(g.start.y + (g.bottom - g.start.y) * f);
                document.body.dispatchEvent(new MouseEvent("mousemove", opts(x - 1, y - 1, 1)));
                document.body.dispatchEvent(new MouseEvent("mousemove", opts(x, y, 1)));
                w.requestAnimationFrame(tick);
              };
              w.requestAnimationFrame(tick);
            }, geo, variant === "legacyresize") as any;
            await settle();
            const afterUp = await browser.execute(() => document.querySelectorAll(".entry-item.selected").length);
            const frames: number[] = raw.frames;
            const gaps = frames.slice(1).map((t, i) => t - frames[i]).sort((a, b) => a - b);
            const q = (p: number) => Math.round(gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * p))]);
            const js: number[] = raw.js.slice(1).sort((a: number, b: number) => a - b);
            const jq = (p: number) => Math.round(js[Math.min(js.length - 1, Math.floor(js.length * p))] * 10) / 10;
            const selectedStatus = (await domText(".status-bar .selected-info")).trim();
            const sel: number[] = raw.sel;
            const rec = { dir, view, preview, variant, round, tiles: geo.tiles, dragMs: Math.round(frames[frames.length - 1] - frames[0]),
              frames: frames.length, p50: q(0.5), p95: q(0.95), max: Math.round(gaps.at(-1)!),
              jsP50: jq(0.5), jsP95: jq(0.95), jsMax: jq(1), jsSum: Math.round(js.reduce((a, b) => a + b, 0)),
              maxSel: Math.max(...sel), afterUp, idleP50: idle, selectedStatus };
            console.log("PROBE", JSON.stringify(rec));
            fs.appendFileSync(out, JSON.stringify(rec) + "\n");
            await browser.keys("Escape");
            await settle();
          }
        }
        await browser.execute(() => document.getElementById("probe-variant")?.remove());
      });
    }
  }
});

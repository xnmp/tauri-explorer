import { browser, $, expect } from "@wdio/globals";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createNativeFixtureDirectory } from "../native-qualification";
import { domText, navigateTo, entryPathSelector } from "./helpers";
const enabled =
  process.platform === "linux" &&
  process.env.TAURI_NATIVE_SELECTION_PROFILE !== undefined;
let ownedAppPid: number | undefined;
const swaymsg = process.env.TAURI_NATIVE_SWAYMSG ?? "swaymsg";
function ipc(command: string): unknown {
  return JSON.parse(
    execFileSync(swaymsg, ["-s", process.env.SWAYSOCK!, "-r", command], {
      encoding: "utf8",
    }),
  );
}
async function keyChord(key: string, modifiers = ["\uE009"]) {
  await browser.performActions([
    {
      type: "key",
      id: "selection-shortcut",
      actions: [
        ...modifiers.map((value) => ({ type: "keyDown" as const, value })),
        { type: "keyDown", value: key },
        { type: "keyUp", value: key },
        ...[...modifiers]
          .reverse()
          .map((value) => ({ type: "keyUp" as const, value })),
      ],
    },
  ]);
  await browser.releaseActions();
}
async function setAppZoom(value: number) {
  await command("Reset Zoom");
  for (let current = 110; current <= value; current += 10) {
    await command("Zoom In");
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => document.documentElement.style.zoom)) ===
        `${current}%`,
    );
  }
  expect(await browser.execute(() => document.documentElement.style.zoom)).toBe(
    `${value}%`,
  );
}
async function command(label: string) {
  if (ownedAppPid) {
    ipc(`[pid=${ownedAppPid}] focus`);
    await browser.waitUntil(async () =>
      browser.execute(() => document.hasFocus()),
    );
  }
  await keyChord("p", ["\uE009", "\uE008"]);
  const input = $(".command-palette-dialog .search-input");
  await input.waitForDisplayed();
  await input.setValue(label);
  await browser.waitUntil(async () =>
    (await domText(".command-palette-dialog")).includes(label),
  );
  await browser.keys("Enter");
  await $(".command-palette-dialog").waitForExist({ reverse: true });
}
const pointer = (
  actions: (
    | {
        type: "pointerMove";
        duration: number;
        origin: "viewport";
        x: number;
        y: number;
      }
    | { type: "pointerDown" | "pointerUp"; button: number }
  )[],
) =>
  browser.performActions([
    {
      type: "pointer",
      id: "native-marquee",
      parameters: { pointerType: "mouse" },
      actions,
    },
  ]);
async function measureDrag(reverse = false) {
  return browser.execute((reverseDirection: boolean) => {
    const content = document.querySelector(".file-list .content")!;
    const r = content.getBoundingClientRect();
    const entries = Array.from(
      content.querySelectorAll<HTMLElement>(".entry-item"),
    ).map((element) => {
      const r = element.getBoundingClientRect();
      return {
        name: element.dataset.path!.split("/").at(-1)!,
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
      };
    });
    const lowest = Math.max(...entries.map((e) => e.bottom));
    const last = entries
      .filter((e) => Math.abs(e.bottom - lowest) < 2)
      .sort((a, b) => a.left - b.left)
      .slice(0, 2);
    const start = {
      x: Math.round(Math.min(...last.map((e) => e.left)) + 5),
      y: Math.round(lowest + 12),
    };
    const end = {
      x: Math.round(
        Math.min(r.right, Math.max(...last.map((e) => e.right))) - 5,
      ),
      y: Math.round(Math.min(...last.map((e) => e.top)) + 6),
    };
    if (reverseDirection) {
      const x = start.x;
      start.x = end.x;
      end.x = x;
    }
    const hit = document.elementFromPoint(start.x, start.y);
    return {
      start,
      end,
      entries,
      content: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
      hitClass: hit?.className,
      dpr: devicePixelRatio,
      appZoom: document.documentElement.style.zoom,
    };
  }, reverse);
}

const artifactDirectory = path.resolve(
  process.env.TAURI_NATIVE_SELECTION_ARTIFACT_DIR ??
    "e2e-tauri/logs/scaled-selection",
);
function reportPath(name: string) {
  fs.mkdirSync(artifactDirectory, { recursive: true });
  return path.join(artifactDirectory, name);
}
const screenshotDirectory = path.resolve(
  "screenshots/fix/756-drag-selection-hit-boxes-seem-broken-again-when-zoomed",
);
async function capture(name: string) {
  await browser.executeAsync((done) =>
    requestAnimationFrame(() => requestAnimationFrame(() => done())),
  );
  fs.mkdirSync(screenshotDirectory, { recursive: true });
  execFileSync("grim", [
    "-o",
    "HEADLESS-2",
    path.join(screenshotDirectory, `${name}.png`),
  ]);
}
async function selectedNames() {
  return browser.execute(() =>
    Array.from(document.querySelectorAll<HTMLElement>(".entry-item.selected"))
      .map((element) => element.dataset.path!.split("/").at(-1)!)
      .sort(),
  );
}
async function assertSelection(expected: string[]) {
  expect(await selectedNames()).toEqual(expected);
  // The status count covers selected entries outside the virtual DOM too.
  expect((await domText(".status-bar .selected-info")).trim()).toMatch(
    new RegExp(`^${expected.length} selected(?:\\s|$)`),
  );
}
function intersecting(geometry: Awaited<ReturnType<typeof measureDrag>>) {
  return geometry.entries
    .filter(
      (e) =>
        e.right > Math.min(geometry.start.x, geometry.end.x) &&
        e.left < Math.max(geometry.start.x, geometry.end.x) &&
        e.bottom > Math.min(geometry.start.y, geometry.end.y) &&
        e.top < Math.max(geometry.start.y, geometry.end.y),
    )
    .map((e) => e.name)
    .sort();
}
(enabled ? describe : describe.skip)(
  "actual native compositor-scaled selection (#756)",
  function () {
    this.bail(true);
    let directory: string;
    let appPid: number;
    let virtualDirectory: string;
    const records: unknown[] = [];
    before(async () => {
      const profile = process.env.TAURI_NATIVE_SELECTION_PROFILE!;
      if (
        process.env.GDK_BACKEND !== "wayland" ||
        process.env.DISPLAY ||
        !process.env.WAYLAND_DISPLAY ||
        !process.env.SWAYSOCK?.startsWith(process.env.XDG_RUNTIME_DIR!) ||
        !process.env.XDG_CONFIG_HOME?.startsWith(profile)
      )
        throw new Error("Use only private headless Wayland/D-Bus/XDG");
      directory = createNativeFixtureDirectory("scaled-marquee-");
      for (let i = 0; i < 8; i++)
        fs.writeFileSync(
          path.join(directory, `selection-${String(i).padStart(2, "0")}.txt`),
          `entry ${i}`,
        );
      virtualDirectory = createNativeFixtureDirectory(
        "scaled-virtual-marquee-",
      );
      for (let i = 0; i < 500; i++)
        fs.writeFileSync(
          path.join(
            virtualDirectory,
            `virtual-${String(i).padStart(3, "0")}.txt`,
          ),
          `entry ${i}`,
        );
      await navigateTo(directory);
      const title = await browser.getTitle();
      expect(title.length).toBeGreaterThan(0);
      const privateTree = JSON.parse(
        execFileSync(
          swaymsg,
          ["-s", process.env.SWAYSOCK!, "-t", "get_tree", "-r"],
          { encoding: "utf8" },
        ),
      );
      const ownedPids: number[] = [];
      const collect = (node: {
        app_id?: string;
        pid?: number;
        nodes?: (typeof privateTree)[];
        floating_nodes?: (typeof privateTree)[];
      }) => {
        if (node.app_id === "tauri-explorer" && node.pid)
          ownedPids.push(node.pid);
        for (const child of [
          ...(node.nodes ?? []),
          ...(node.floating_nodes ?? []),
        ])
          collect(child);
      };
      collect(privateTree);
      if (ownedPids.length !== 1)
        throw new Error("Owned native application PID is ambiguous");
      appPid = ownedPids[0];
      ownedAppPid = appPid;
      const environment = Object.fromEntries(
        fs
          .readFileSync(`/proc/${appPid}/environ`, "utf8")
          .split("\0")
          .filter((value) => value.includes("="))
          .map((value) => {
            const split = value.indexOf("=");
            return [value.slice(0, split), value.slice(split + 1)];
          }),
      );
      for (const key of [
        "GDK_BACKEND",
        "WAYLAND_DISPLAY",
        "XDG_RUNTIME_DIR",
        "XDG_CONFIG_HOME",
        "DBUS_SESSION_BUS_ADDRESS",
      ]) {
        if (environment[key] !== process.env[key])
          throw new Error(`Native application lost private ${key}`);
      }
      if (environment.DISPLAY)
        throw new Error("Native application connected to X11");
      const result = ipc(
        `[pid=${appPid}] move container to output HEADLESS-2`,
      ) as { success: boolean }[];
      expect(result.every((row) => row.success)).toBe(true);
      fs.writeFileSync(
        reportPath("native-tree-before.json"),
        execFileSync(
          swaymsg,
          ["-s", process.env.SWAYSOCK!, "-t", "get_tree", "-r"],
          { encoding: "utf8" },
        ),
      );
    });
    for (const scale of [1, 1.25, 1.5, 2])
      for (const zoom of [100, 150])
        for (const mode of ["details", "list", "tiles"])
          for (const reverse of [false, true]) {
            it(`${scale * 100}% monitor, ${zoom}% app, ${mode}, ${reverse ? "reverse" : "forward"}: exact geometry and selection`, async () => {
              ipc(`[pid=${appPid}] move container to output HEADLESS-1`);
              ipc(
                `output HEADLESS-2 mode ${Math.round(1600 * scale)}x${Math.round(1000 * scale)} scale ${scale}`,
              );
              ipc(`[pid=${appPid}] move container to output HEADLESS-2`);
              await setAppZoom(zoom);
              await command(`${mode[0].toUpperCase() + mode.slice(1)} View`);
              await $(`.${mode}-view`).waitForDisplayed();
              await browser.executeAsync((done) =>
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => done()),
                ),
              );
              const tree = JSON.parse(
                execFileSync(
                  swaymsg,
                  ["-s", process.env.SWAYSOCK!, "-t", "get_tree", "-r"],
                  { encoding: "utf8" },
                ),
              );
              const located = (
                node: any,
                output: string | null = null,
              ): string | null => {
                const next = node.type === "output" ? node.name : output;
                if (node.pid === appPid) return next;
                for (const child of [
                  ...(node.nodes ?? []),
                  ...(node.floating_nodes ?? []),
                ]) {
                  const match = located(child, next);
                  if (match) return match;
                }
                return null;
              };
              expect(located(tree)).toBe("HEADLESS-2");
              const outputs = JSON.parse(
                execFileSync(
                  swaymsg,
                  ["-s", process.env.SWAYSOCK!, "-t", "get_outputs", "-r"],
                  { encoding: "utf8" },
                ),
              );
              expect(
                outputs.find((output: any) => output.name === "HEADLESS-2")
                  .scale,
              ).toBe(scale);
              const geometry = await measureDrag(reverse);
              expect(geometry.appZoom).toBe(`${zoom}%`);
              fs.writeFileSync(
                reportPath("native-geometry-before.json"),
                JSON.stringify(geometry, null, 2),
              );
              expect(geometry.start.y).toBeLessThan(geometry.content.bottom);
              const expected = geometry.entries
                .filter(
                  (e) =>
                    e.right > Math.min(geometry.start.x, geometry.end.x) &&
                    e.left < Math.max(geometry.start.x, geometry.end.x) &&
                    e.bottom > Math.min(geometry.start.y, geometry.end.y) &&
                    e.top < Math.max(geometry.start.y, geometry.end.y),
                )
                .map((e) => e.name)
                .sort();
              expect(expected.length).toBeGreaterThan(0);
              expect(expected.length).toBeLessThan(geometry.entries.length);
              await pointer([
                {
                  type: "pointerMove",
                  duration: 0,
                  origin: "viewport",
                  ...geometry.start,
                },
                { type: "pointerDown", button: 0 },
                {
                  type: "pointerMove",
                  duration: 250,
                  origin: "viewport",
                  ...geometry.end,
                },
              ]);
              await $(".marquee-rect").waitForDisplayed();
              const band = await browser.execute(() => {
                const r = document
                  .querySelector(".marquee-rect")!
                  .getBoundingClientRect();
                return {
                  left: r.left,
                  top: r.top,
                  right: r.right,
                  bottom: r.bottom,
                };
              });
              fs.writeFileSync(
                reportPath("native-band-before.json"),
                JSON.stringify(band, null, 2),
              );
              expect(
                Math.abs(
                  band.left - Math.min(geometry.start.x, geometry.end.x),
                ),
              ).toBeLessThan(3);
              expect(
                Math.abs(band.top - Math.min(geometry.start.y, geometry.end.y)),
              ).toBeLessThan(3);
              expect(
                Math.abs(
                  band.right - Math.max(geometry.start.x, geometry.end.x),
                ),
              ).toBeLessThan(3);
              expect(
                Math.abs(
                  band.bottom - Math.max(geometry.start.y, geometry.end.y),
                ),
              ).toBeLessThan(3);
              if (scale === 1.25 && zoom === 150 && !reverse)
                await capture(`${mode}-125-monitor-150-app-active`);
              await pointer([{ type: "pointerUp", button: 0 }]);
              await browser.releaseActions();
              if (scale === 1.25 && zoom === 150 && !reverse)
                await capture(`${mode}-125-monitor-150-app-selected`);
              await $(".marquee-rect").waitForExist({ reverse: true });
              const selected = await browser.execute(() =>
                Array.from(
                  document.querySelectorAll<HTMLElement>(
                    ".entry-item.selected",
                  ),
                )
                  .map((e) => e.dataset.path!.split("/").at(-1)!)
                  .sort(),
              );
              records.push({
                scale,
                zoom,
                displayBackend: process.env.GDK_BACKEND,
                webkitGTK: execFileSync(
                  "pkg-config",
                  ["--modversion", "webkit2gtk-4.1"],
                  { encoding: "utf8" },
                ).trim(),
                mode,
                reverse,
                geometry,
                band,
                expected,
                selected,
              });
              fs.writeFileSync(
                reportPath("native-matrix.json"),
                JSON.stringify(records, null, 2),
              );
              expect(selected).toEqual(expected);
            });
          }
    for (const mode of ["list", "tiles"])
      it(`${mode}: scrolling while dragging selects current virtualized rows at fractional scale`, async () => {
        ipc(`output HEADLESS-2 mode 2000x1250 scale 1.25`);
        ipc(`[pid=${appPid}] move container to output HEADLESS-2`);
        await navigateTo(virtualDirectory);
        await setAppZoom(150);
        await command(`${mode[0].toUpperCase() + mode.slice(1)} View`);
        await $(`.${mode}-view`).waitForDisplayed();
        const points = await browser.execute(() => {
          const content = document.querySelector(".file-list .content")!;
          const c = content.getBoundingClientRect();
          const first = content.querySelector(".entry-item")!;
          const r = first.getBoundingClientRect();
          const start = {
            x: Math.round(r.left - 4),
            y: Math.round(r.top + 10),
          };
          const end = {
            x: Math.round(r.right - 5),
            y: Math.round(Math.min(c.bottom - 20, r.bottom + r.height)),
          };
          const hit = document.elementFromPoint(start.x, start.y);
          return {
            start,
            end,
            hitClass: hit?.className,
            hitEntry: !!hit?.closest(".entry-item"),
          };
        });
        expect(points.hitEntry).toBe(false);
        await pointer([
          {
            type: "pointerMove",
            duration: 0,
            origin: "viewport",
            ...points.start,
          },
          { type: "pointerDown", button: 0 },
          {
            type: "pointerMove",
            duration: 250,
            origin: "viewport",
            ...points.end,
          },
        ]);
        await $(".marquee-rect").waitForDisplayed();
        await browser.execute(
          () =>
            (document.querySelector(".file-list .virtual-viewport")!.scrollTop =
              500),
        );
        await browser.waitUntil(
          async () =>
            await browser.execute(() => {
              const items = Array.from(
                document.querySelectorAll<HTMLElement>(".entry-item"),
              );
              return (
                items.length < 500 &&
                items.some((element) => Number(element.dataset.index) > 50)
              );
            }),
        );
        const stationary = await browser.execute(() => {
          const r = document
            .querySelector(".marquee-rect")!
            .getBoundingClientRect();
          const expected = Array.from(
            document.querySelectorAll<HTMLElement>(".entry-item"),
          )
            .filter((element) => {
              const e = element.getBoundingClientRect();
              return (
                e.right > r.left &&
                e.left < r.right &&
                e.bottom > r.top &&
                e.top < r.bottom
              );
            })
            .map((element) => element.dataset.path!.split("/").at(-1)!)
            .sort();
          const selected = Array.from(
            document.querySelectorAll<HTMLElement>(".entry-item.selected"),
          )
            .map((element) => element.dataset.path!.split("/").at(-1)!)
            .sort();
          return { expected, selected };
        });
        fs.writeFileSync(
          reportPath(`${mode}-stationary-scroll.json`),
          JSON.stringify(stationary, null, 2),
        );
        expect(stationary.selected).toEqual(stationary.expected);
        const final = { x: points.end.x - 2, y: points.end.y - 2 };
        await pointer([
          { type: "pointerMove", duration: 250, origin: "viewport", ...final },
        ]);
        const observed = await browser.execute(() => {
          const r = document
            .querySelector(".marquee-rect")!
            .getBoundingClientRect();
          const expected = Array.from(
            document.querySelectorAll<HTMLElement>(".entry-item"),
          )
            .filter((element) => {
              const e = element.getBoundingClientRect();
              return (
                e.right > r.left &&
                e.left < r.right &&
                e.bottom > r.top &&
                e.top < r.bottom
              );
            })
            .map((element) => element.dataset.path!.split("/").at(-1)!)
            .sort();
          const selected = Array.from(
            document.querySelectorAll<HTMLElement>(".entry-item.selected"),
          )
            .map((element) => element.dataset.path!.split("/").at(-1)!)
            .sort();
          return {
            expected,
            selected,
            scroll: document.querySelector(".virtual-viewport")!.scrollTop,
            band: {
              left: r.left,
              top: r.top,
              right: r.right,
              bottom: r.bottom,
            },
            dpr: devicePixelRatio,
          };
        });
        fs.writeFileSync(
          reportPath(`${mode}-live-scroll.json`),
          JSON.stringify({ points, observed }, null, 2),
        );
        await pointer([{ type: "pointerUp", button: 0 }]);
        await browser.releaseActions();
        expect(observed.expected.length).toBeGreaterThan(0);
        expect(observed.selected).toEqual(observed.expected);
        const committed = await browser.execute(() =>
          Array.from(
            document.querySelectorAll<HTMLElement>(".entry-item.selected"),
          )
            .map((element) => element.dataset.path!.split("/").at(-1)!)
            .sort(),
        );
        expect(committed).toEqual(observed.expected);
        await assertSelection(observed.expected);
      });
    for (const mode of ["list", "tiles"])
      it(`${mode}: downward drags select exact intersecting entries`, async () => {
        await navigateTo(directory);
        await setAppZoom(150);
        await command(`${mode[0].toUpperCase() + mode.slice(1)} View`);
        const geometry = await browser.execute(() => {
          const content = document.querySelector(".file-list .content")!;
          const entries = Array.from(
            content.querySelectorAll<HTMLElement>(".entry-item"),
          ).map((element) => {
            const r = element.getBoundingClientRect();
            return {
              name: element.dataset.path!.split("/").at(-1)!,
              left: r.left,
              right: r.right,
              top: r.top,
              bottom: r.bottom,
            };
          });
          const first = entries[0];
          const start = {
            x: Math.round(first.left - 4),
            y: Math.round(first.top + 5),
          };
          const end = {
            x: Math.round(first.right - 5),
            y: Math.round(first.bottom - 5),
          };
          return {
            start,
            end,
            entries,
            background: !document
              .elementFromPoint(start.x, start.y)
              ?.closest(".entry-item"),
          };
        });
        expect(geometry.background).toBe(true);
        const expected = geometry.entries
          .filter(
            (e) =>
              e.right > geometry.start.x &&
              e.left < geometry.end.x &&
              e.bottom > geometry.start.y &&
              e.top < geometry.end.y,
          )
          .map((e) => e.name)
          .sort();
        await pointer([
          {
            type: "pointerMove",
            duration: 0,
            origin: "viewport",
            ...geometry.start,
          },
          { type: "pointerDown", button: 0 },
          {
            type: "pointerMove",
            duration: 250,
            origin: "viewport",
            ...geometry.end,
          },
          { type: "pointerUp", button: 0 },
        ]);
        await browser.releaseActions();
        await assertSelection(expected);
      });
    for (const mode of ["details", "list", "tiles"])
      it(`${mode}: resize, additive marquee, toggle and native blur preserve selection contracts`, async () => {
        await navigateTo(directory);
        ipc(`output HEADLESS-2 mode 2000x1250 scale 1.25`);
        ipc(
          `[pid=${appPid}] move container to output HEADLESS-2, floating enable, resize set width 1200 px height 950 px`,
        );
        await setAppZoom(150);
        await command(`${mode[0].toUpperCase() + mode.slice(1)} View`);
        await $(`.${mode}-view`).waitForDisplayed();
        await browser.executeAsync((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done())),
        );
        const geometry = await measureDrag();
        expect(geometry.appZoom).toBe("150%");
        const expected = intersecting(geometry);
        fs.writeFileSync(
          reportPath(`${mode}-resize-geometry.json`),
          JSON.stringify(geometry, null, 2),
        );
        const seed = geometry.entries.find(
          (entry) => !expected.includes(entry.name),
        )!.name;
        const seedEntry = $(entryPathSelector(path.join(directory, seed)));
        await seedEntry.click();
        expect(await selectedNames()).toEqual([seed]);
        expect(expected.length).toBeGreaterThan(0);
        await browser.performActions([
          {
            type: "key",
            id: "modifier",
            actions: [{ type: "keyDown", value: "\uE009" }],
          },
        ]);
        await pointer([
          {
            type: "pointerMove",
            duration: 0,
            origin: "viewport",
            ...geometry.start,
          },
          { type: "pointerDown", button: 0 },
          {
            type: "pointerMove",
            duration: 250,
            origin: "viewport",
            ...geometry.end,
          },
        ]);
        await $(".marquee-rect").waitForDisplayed();
        await pointer([{ type: "pointerUp", button: 0 }]);
        await browser.performActions([
          {
            type: "key",
            id: "modifier",
            actions: [{ type: "keyUp", value: "\uE009" }],
          },
        ]);
        await browser.releaseActions();
        expect(await selectedNames()).toEqual([seed, ...expected].sort());
        await browser.performActions([
          {
            type: "key",
            id: "modifier",
            actions: [{ type: "keyDown", value: "\uE009" }],
          },
        ]);
        await seedEntry.click();
        await browser.performActions([
          {
            type: "key",
            id: "modifier",
            actions: [{ type: "keyUp", value: "\uE009" }],
          },
        ]);
        await browser.releaseActions();
        await assertSelection(expected);
        await pointer([
          {
            type: "pointerMove",
            duration: 0,
            origin: "viewport",
            ...geometry.start,
          },
          { type: "pointerDown", button: 0 },
          {
            type: "pointerMove",
            duration: 250,
            origin: "viewport",
            ...geometry.end,
          },
        ]);
        await $(".marquee-rect").waitForDisplayed();
        const beforeBlur = await selectedNames();
        expect(await browser.execute(() => document.hasFocus())).toBe(true);
        ipc('workspace "issue756-private-empty"');
        await $(".marquee-rect").waitForExist({ reverse: true });
        expect(await browser.execute(() => document.hasFocus())).toBe(false);
        ipc(`[pid=${appPid}] focus`);
        await browser.waitUntil(async () =>
          browser.execute(() => document.hasFocus()),
        );
        await pointer([
          {
            type: "pointerMove",
            duration: 250,
            origin: "viewport",
            x: geometry.end.x - 30,
            y: geometry.end.y - 30,
          },
          { type: "pointerUp", button: 0 },
        ]);
        await browser.releaseActions();
        expect(await selectedNames()).toEqual(beforeBlur);
        await $(".marquee-rect").waitForExist({ reverse: true });
        ipc(`[pid=${appPid}] floating disable`);
      });
    for (const downward of [false, true])
      it(`details: scrolling through newly virtualized rows updates stationary and final selection (${downward ? "downward" : "upward"})`, async () => {
        const changingDirectory = createNativeFixtureDirectory(
          "scaled-details-virtual-",
        );
        for (let i = 0; i < 8; i++)
          fs.writeFileSync(
            path.join(
              changingDirectory,
              `virtual-${String(i).padStart(3, "0")}.txt`,
            ),
            "entry",
          );
        await navigateTo(changingDirectory);
        await setAppZoom(150);
        await command("Details View");
        const measured = await measureDrag();
        const geometry = downward
          ? { ...measured, end: { ...measured.end, y: measured.start.y + 54 } }
          : measured;
        await pointer([
          {
            type: "pointerMove",
            duration: 0,
            origin: "viewport",
            ...geometry.start,
          },
          { type: "pointerDown", button: 0 },
          {
            type: "pointerMove",
            duration: 250,
            origin: "viewport",
            ...geometry.end,
          },
        ]);
        await $(".marquee-rect").waitForDisplayed();
        for (let i = 8; i < 500; i++)
          fs.writeFileSync(
            path.join(
              changingDirectory,
              `virtual-${String(i).padStart(3, "0")}.txt`,
            ),
            "entry",
          );
        await browser.waitUntil(
          async () => (await domText(".status-bar")).includes("500"),
          { timeout: 15000 },
        );
        await browser.execute(
          () =>
            (document.querySelector(".file-list .virtual-viewport")!.scrollTop =
              500),
        );
        await browser.waitUntil(async () =>
          browser.execute(() =>
            Array.from(
              document.querySelectorAll<HTMLElement>(".entry-item"),
            ).some((e) => Number(e.dataset.index) > 25),
          ),
        );
        await browser.executeAsync((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done())),
        );
        const expected = await browser.execute(() => {
          const r = document
            .querySelector(".marquee-rect")!
            .getBoundingClientRect();
          return Array.from(
            document.querySelectorAll<HTMLElement>(".entry-item"),
          )
            .filter((element) => {
              const e = element.getBoundingClientRect();
              return (
                e.right > r.left &&
                e.left < r.right &&
                e.bottom > r.top &&
                e.top < r.bottom
              );
            })
            .map((element) => element.dataset.path!.split("/").at(-1)!)
            .sort();
        });
        expect(expected.length).toBeGreaterThan(0);
        await assertSelection(expected);
        await capture(
          `details-virtual-scroll-${downward ? "downward-" : ""}125-monitor-150-app-active`,
        );
        await pointer([{ type: "pointerUp", button: 0 }]);
        await browser.releaseActions();
        await assertSelection(expected);
        fs.writeFileSync(
          reportPath(
            downward
              ? "details-downward-live-scroll.json"
              : "details-live-scroll.json",
          ),
          JSON.stringify(
            { expected, selected: await selectedNames() },
            null,
            2,
          ),
        );
      });
    after(async () => {
      await browser.releaseActions();
    });
  },
);

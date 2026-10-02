import { browser, $, expect } from "@wdio/globals";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createNativeFixtureDirectory } from "../native-qualification";
import { domText, navigateTo, entryPathSelector } from "./helpers";

const isLinux = process.platform === "linux";
// Windows interactive admission is confined to the disposable hosted runner.
const isHostedWindows = process.platform === "win32" && process.env.GITHUB_ACTIONS === "true" && process.env.RUNNER_ENVIRONMENT === "github-hosted";
const enabled = (isLinux && !!process.env.TAURI_NATIVE_SELECTION_PROFILE) || isHostedWindows;
const swaymsg = process.env.TAURI_NATIVE_SWAYMSG ?? "swaymsg";
const artifacts = path.resolve(
  process.env.TAURI_NATIVE_SELECTION_ARTIFACT_DIR ??
    "e2e-tauri/logs/pdf-preview",
);
const screenshots = path.resolve(
  "screenshots/fix/728-zooming-in-pdf-in-preview-isnt-centred",
);
const report = (name: string, value: unknown) => {
  fs.mkdirSync(artifacts, { recursive: true });
  fs.writeFileSync(path.join(artifacts, name), JSON.stringify(value, null, 2));
};
async function installPdfDiagnostics() {
  await browser.execute(() => {
    const root = document.documentElement;
    root.dataset.pdfDiagnosticCsp = "[]";
    root.dataset.pdfDiagnosticErrors = "[]";
    root.dataset.pdfDiagnosticWorkers = "[]";
    window.addEventListener("securitypolicyviolation", (event) => {
      const rows = JSON.parse(root.dataset.pdfDiagnosticCsp || "[]");
      rows.push({
        blockedURI: event.blockedURI,
        effectiveDirective: event.effectiveDirective,
        violatedDirective: event.violatedDirective,
        originalPolicy: event.originalPolicy,
        sourceFile: event.sourceFile,
        lineNumber: event.lineNumber,
        disposition: event.disposition,
      });
      root.dataset.pdfDiagnosticCsp = JSON.stringify(rows.slice(-128));
    });
    window.addEventListener("error", (event) => {
      const rows = JSON.parse(root.dataset.pdfDiagnosticErrors || "[]");
      rows.push({
        message: event.message,
        filename: event.filename,
        lineNumber: event.lineno,
      });
      root.dataset.pdfDiagnosticErrors = JSON.stringify(rows.slice(-128));
    });
    new MutationObserver((records) => {
      if (
        !records.some((item) => item.attributeName === "data-e2e-pdf-workers")
      )
        return;
      const rows = JSON.parse(root.dataset.pdfDiagnosticWorkers || "[]");
      rows.push({
        at: performance.now(),
        receipts: JSON.parse(root.dataset.e2ePdfWorkers || "[]"),
      });
      root.dataset.pdfDiagnosticWorkers = JSON.stringify(rows.slice(-128));
    }).observe(root, {
      attributes: true,
      attributeFilter: ["data-e2e-pdf-workers"],
    });
  });
}
async function pdfDiagnostics() {
  return browser.execute(() => ({
    href: location.href,
    origin: location.origin,
    baseURI: document.baseURI,
    workers: JSON.parse(document.documentElement.dataset.e2ePdfWorkers || "[]"),
    workerTimeline: JSON.parse(
      document.documentElement.dataset.pdfDiagnosticWorkers || "[]",
    ),
    csp: JSON.parse(document.documentElement.dataset.pdfDiagnosticCsp || "[]"),
    errors: JSON.parse(
      document.documentElement.dataset.pdfDiagnosticErrors || "[]",
    ),
    previewMarkup: document.querySelector(".pdf-preview")?.outerHTML ?? null,
    messages: Array.from(document.querySelectorAll(".pdf-message")).map(
      (item) => item.textContent,
    ),
    previewText: document.querySelector(".preview-pane")?.textContent ?? null,
    resources: performance
      .getEntriesByType("resource")
      .map((entry) => ({ name: entry.name, duration: entry.duration })),
  }));
}
function sway(type: string) {
  return JSON.parse(
    execFileSync(swaymsg, ["-s", process.env.SWAYSOCK!, "-t", type, "-r"], {
      encoding: "utf8",
    }),
  );
}
function ipc(command: string) {
  const result = JSON.parse(
    execFileSync(swaymsg, ["-s", process.env.SWAYSOCK!, "-r", command], {
      encoding: "utf8",
    }),
  );
  if (!result.every((item: { success: boolean }) => item.success))
    throw new Error(`Owned compositor command failed: ${command}`);
}
async function chord(key: string, modifiers = ["\uE009"]) {
  await browser.performActions([
    {
      type: "key",
      id: "pdf-shortcut",
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
async function command(label: string) {
  await chord("p", ["\uE009", "\uE008"]);
  const input = $(".command-palette-dialog .search-input");
  await input.waitForDisplayed();
  await input.setValue(label);
  await browser.waitUntil(async () =>
    (await domText(".command-palette-dialog")).includes(label),
  );
  await browser.keys("Enter");
  await $(".command-palette-dialog").waitForExist({ reverse: true });
}
async function appZoom(percent: number) {
  await command("Reset Zoom");
  for (let zoom = 110; zoom <= percent; zoom += 10) await command("Zoom In");
  expect(await browser.execute(() => document.documentElement.style.zoom)).toBe(
    `${percent}%`,
  );
}
async function geometry() {
  return browser.execute(() => {
    const v = document.querySelector(".pdf-viewport")!.getBoundingClientRect();
    const p = document.querySelector(".pdf-page")!.getBoundingClientRect();
    return {
      x: p.x,
      y: p.y,
      width: p.width,
      height: p.height,
      cx: p.x + p.width / 2,
      cy: p.y + p.height / 2,
      vx: v.x,
      vy: v.y,
      vw: v.width,
      vh: v.height,
      vcx: v.x + v.width / 2,
      vcy: v.y + v.height / 2,
    };
  });
}
async function color() {
  return browser.execute(() => {
    const canvas =
      document.querySelector<HTMLCanvasElement>(".pdf-canvas canvas")!;
    return [
      ...canvas
        .getContext("2d")!
        .getImageData(
          Math.floor(canvas.width / 2),
          Math.floor(canvas.height / 2),
          1,
          1,
        ).data,
    ];
  });
}
async function ready(expected = [255, 0, 0, 255]) {
  await $(".pdf-page.ready").waitForDisplayed({ timeout: 20000 });
  await browser.waitUntil(
    async () => JSON.stringify(await color()) === JSON.stringify(expected),
  );
}
async function zoomTo(percent: number) {
  await $(".pdf-controls .fit-button").click();
  for (let zoom = 100; zoom < percent; zoom += 10)
    await $('[aria-label="Zoom PDF in"]').click();
  await browser.waitUntil(
    async () => (await domText(".pdf-zoom")).trim() === `${percent}%`,
  );
  await $(".pdf-page.ready").waitForDisplayed();
}
async function drag(
  start: { x: number; y: number },
  end: { x: number; y: number },
  release = true,
) {
  await browser.performActions([
    {
      type: "pointer",
      id: "pdf-pointer",
      parameters: { pointerType: "mouse" },
      actions: [
        {
          type: "pointerMove",
          duration: 0,
          origin: "viewport",
          x: Math.round(start.x),
          y: Math.round(start.y),
        },
        { type: "pointerDown", button: 0 },
        {
          type: "pointerMove",
          duration: 200,
          origin: "viewport",
          x: Math.round(end.x),
          y: Math.round(end.y),
        },
        ...(release ? [{ type: "pointerUp" as const, button: 0 }] : []),
      ],
    },
  ]);
  if (release) await browser.releaseActions();
}
async function capture(name: string) {
  fs.mkdirSync(screenshots, { recursive: true });
  await browser.executeAsync((done) =>
    requestAnimationFrame(() => requestAnimationFrame(() => done())),
  );
  if (isLinux) execFileSync("grim", ["-o", "HEADLESS-2", path.join(screenshots, name)]);
  else await browser.saveScreenshot(path.join(screenshots, name.replace("native-125-output", "native-windows")));
}

(enabled ? describe : describe.skip)(
  "native PDF preview (#728/#729/#730)",
  function () {
    this.bail(true);
    let directory: string, pdf: string, appPid: number, originalHash: string;
    let linkViewerPid: number | undefined;
    const linkReceipt = path.join(artifacts, "external-link-receipt.json");
    function stopLinkViewer() {
      if (linkViewerPid === undefined) return;
      const env = fs.readFileSync(`/proc/${linkViewerPid}/environ`, "utf8");
      if (
        !env
          .split("\0")
          .includes(`XDG_CONFIG_HOME=${process.env.XDG_CONFIG_HOME}`)
      )
        throw new Error(
          "Refusing to stop a URL handler outside the private profile",
        );
      process.kill(linkViewerPid, "SIGTERM");
      linkViewerPid = undefined;
    }
    before(async () => {
      if (isLinux) {
        const profile = process.env.TAURI_NATIVE_SELECTION_PROFILE!;
        if (
          process.env.DISPLAY ||
          process.env.GDK_BACKEND !== "wayland" ||
          !process.env.WAYLAND_DISPLAY ||
          !process.env.SWAYSOCK?.startsWith(process.env.XDG_RUNTIME_DIR!) ||
          !process.env.XDG_CONFIG_HOME?.startsWith(profile)
        )
          throw new Error(
            "PDF native tests require the private headless Wayland/D-Bus/XDG runner",
          );
        fs.mkdirSync(artifacts, { recursive: true });
        fs.rmSync(linkReceipt, { force: true });
        process.env.TAURI_NATIVE_PDF_LINK_RECEIPT = linkReceipt;
        // The app was launched before this hook: the private handler reads its receipt location
        // from its own desktop entry, while every display/profile alias stays inherited.
        const applications = path.join(
          process.env.XDG_DATA_HOME!,
          "applications",
        );
        fs.mkdirSync(applications, { recursive: true });
        const desktopQuote = (value: string) =>
          `"${value.replace(/[\\"`$]/g, "\\$&")}"`;
        fs.writeFileSync(
          path.join(applications, "acceptance-pdf-link.desktop"),
          `[Desktop Entry]\nType=Application\nName=Acceptance PDF Link Viewer\nExec=/usr/bin/env TAURI_NATIVE_PDF_LINK_RECEIPT=${desktopQuote(linkReceipt)} /usr/bin/python3 ${desktopQuote(path.resolve("e2e-tauri/fixtures/pdf-link-viewer.py"))} %u\nTerminal=false\nMimeType=x-scheme-handler/http;x-scheme-handler/https;\n`,
        );
        fs.writeFileSync(
          path.join(process.env.XDG_CONFIG_HOME!, "mimeapps.list"),
          "[Default Applications]\nx-scheme-handler/http=acceptance-pdf-link.desktop\nx-scheme-handler/https=acceptance-pdf-link.desktop\n",
        );
        expect(
          execFileSync(
            "xdg-mime",
            ["query", "default", "x-scheme-handler/https"],
            { encoding: "utf8" },
          ).trim(),
        ).toBe("acceptance-pdf-link.desktop");
      } else if (!isHostedWindows) {
        throw new Error("Windows PDF native qualification requires a disposable hosted runner");
      }
      directory = createNativeFixtureDirectory("native-pdf-proof-");
      pdf = path.join(directory, "0-landmarks.pdf");
      fs.copyFileSync(
        path.resolve("src/lib/api/fixtures/preview-landmarks.pdf"),
        pdf,
      );
      originalHash = createHash("sha256")
        .update(fs.readFileSync(pdf))
        .digest("hex");
      fs.writeFileSync(
        path.join(directory, "1-corrupt.pdf"),
        "invalid PDF fixture",
      );
      fs.writeFileSync(
        path.join(directory, "2-image.svg"),
        '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800"><rect width="600" height="800" fill="white"/><rect x="20" y="20" width="80" height="80" fill="#00b300"/><rect x="500" y="700" width="80" height="80" fill="blue"/><rect x="265" y="365" width="70" height="70" fill="red"/></svg>',
      );
      await navigateTo(directory);
      if (isLinux) {
        const pids: number[] = [];
        function collect(node: any) {
          if (node.app_id === "tauri-explorer" && node.pid) pids.push(node.pid);
          for (const child of [
            ...(node.nodes ?? []),
            ...(node.floating_nodes ?? []),
          ])
            collect(child);
        }
        collect(sway("get_tree"));
        if (pids.length !== 1)
          throw new Error("Owned PDF app identity is ambiguous");
        appPid = pids[0];
        const env = Object.fromEntries(
          fs
            .readFileSync(`/proc/${appPid}/environ`, "utf8")
            .split("\0")
            .filter((item) => item.includes("="))
            .map((item) => {
              const index = item.indexOf("=");
              return [item.slice(0, index), item.slice(index + 1)];
            }),
        );
        for (const key of [
          "GDK_BACKEND",
          "WAYLAND_DISPLAY",
          "XDG_RUNTIME_DIR",
          "XDG_CONFIG_HOME",
          "DBUS_SESSION_BUS_ADDRESS",
        ])
          if (env[key] !== process.env[key])
            throw new Error(`Owned PDF app lost private ${key}`);
        if (env.DISPLAY) throw new Error("PDF app connected to X11");
        report("isolation.json", {
          appPid,
          environment: Object.fromEntries(
            [
              "GDK_BACKEND",
              "WAYLAND_DISPLAY",
              "XDG_RUNTIME_DIR",
              "XDG_CONFIG_HOME",
              "DBUS_SESSION_BUS_ADDRESS",
            ].map((key) => [key, env[key]]),
          ),
        });
        ipc(`[pid=${appPid}] move container to output HEADLESS-2, focus`);
      } else {
        await browser.setWindowSize(1200, 900);
        report("hosted-admission.json", { platform: process.platform, githubActions: process.env.GITHUB_ACTIONS, sourceCommit: process.env.GITHUB_SHA, runnerEnvironment: process.env.RUNNER_ENVIRONMENT });
      }
      await browser.waitUntil(async () =>
        browser.execute(() => document.hasFocus()),
      );
      if (await $(".preview-pane").isDisplayed())
        await command("Toggle Preview Pane");
      await appZoom(100);
      await installPdfDiagnostics();
      await $(entryPathSelector(pdf)).click();
      await command("Dock Preview Pane Right");
      expect(await browser.execute(() => document.documentElement.style.zoom)).toBe("100%");
      await expect($(".preview-pane.dock-top, .preview-pane.dock-bottom")).not.toExist();
    });

    it("uses a real module worker to render known bytes in the native WebView", async () => {
      try {
        await ready();
      } catch (error) {
        report("pdf-startup-failure.json", await pdfDiagnostics());
        if (isLinux) {
          report("pdf-failure-compositor.json", {
            appPid,
            outputs: sway("get_outputs"),
            tree: sway("get_tree"),
          });
          execFileSync("grim", [
            "-o",
            "HEADLESS-2",
            path.join(artifacts, "pdf-startup-failure.png"),
          ]);
        } else await browser.saveScreenshot(path.join(artifacts, "pdf-startup-failure.png"));
        throw error;
      }
      const receipts = await browser.execute(() =>
        JSON.parse(document.documentElement.dataset.e2ePdfWorkers || "[]"),
      );
      expect(
        receipts.some(
          (item: { path: string; phase: string }) =>
            item.path === pdf && item.phase === "ready",
        ),
      ).toBe(true);
      report("worker-startup.json", {
        receipts,
        location: await browser.execute(() => ({
          href: location.href,
          origin: location.origin,
        })),
        color: await color(),
      });
      await capture("pdf-fit-native-125-output-100-app.png");
    });
    for (const zoom of [100, 150])
      for (const fullscreen of [false, true]) {
        it(`centers 130%, follows pan and preserves wheel anchor at app ${zoom}% fullscreen ${fullscreen}`, async () => {
          if (await $(".preview-pane.fullscreen").isExisting())
            await browser.keys("Escape");
          await appZoom(zoom);
          await ready();
          if (fullscreen) await $('[aria-label="View PDF fullscreen"]').click();
          await zoomTo(130);
          const centered = await geometry();
          expect(Math.abs(centered.cx - centered.vcx)).toBeLessThan(2);
          expect(Math.abs(centered.cy - centered.vcy)).toBeLessThan(2);
          if (zoom === 150 && !fullscreen)
            await capture("pdf-130-native-125-output-150-app.png");
          await zoomTo(400);
          const before = await geometry();
          const start = { x: before.vcx, y: before.vcy },
            end = { x: start.x - 60, y: start.y - 50 };
          await drag(start, end, false);
          await $(".pdf-viewport.panning").waitForExist();
          expect(
            await browser.execute(
              () =>
                getComputedStyle(document.querySelector(".pdf-viewport")!)
                  .cursor,
            ),
          ).toBe("grabbing");
          if (zoom === 150 && !fullscreen)
            await capture("pdf-active-pan-native-125-output-150-app.png");
          await browser.performActions([
            {
              type: "pointer",
              id: "pdf-pointer",
              parameters: { pointerType: "mouse" },
              actions: [{ type: "pointerUp", button: 0 }],
            },
          ]);
          await browser.releaseActions();
          const panned = await geometry();
          expect(Math.abs(panned.cx - before.cx + 60)).toBeLessThan(2);
          expect(Math.abs(panned.cy - before.cy + 50)).toBeLessThan(2);
          const anchor = {
            x: Math.round(start.x + 20),
            y: Math.round(start.y + 20),
          };
          const normalized = {
            x: (anchor.x - panned.x) / panned.width,
            y: (anchor.y - panned.y) / panned.height,
          };
          // DOM wheel delivery exercises the native renderer's measured coordinates;
          // actual device-wheel dispatch is additionally covered by browser Playwright.
          await browser.execute(
            (point) =>
              document.querySelector(".pdf-viewport")!.dispatchEvent(
                new WheelEvent("wheel", {
                  bubbles: true,
                  cancelable: true,
                  ctrlKey: true,
                  clientX: point.x,
                  clientY: point.y,
                  deltaY: -100,
                }),
              ),
            anchor,
          );
          await browser.waitUntil(
            async () => (await domText(".pdf-zoom")).trim() === "460%",
          );
          const wheeled = await geometry();
          expect(
            Math.abs(wheeled.x + normalized.x * wheeled.width - anchor.x),
          ).toBeLessThan(2);
          expect(
            Math.abs(wheeled.y + normalized.y * wheeled.height - anchor.y),
          ).toBeLessThan(2);
          if (zoom === 150)
            await capture(
              `pdf-panned-${fullscreen ? "fullscreen" : "pane"}-native-125-output-150-app.png`,
            );
          await $(".pdf-controls .fit-button").click();
          const fit = await geometry();
          expect(Math.abs(fit.cx - fit.vcx)).toBeLessThan(2);
          expect(fit.width).toBeLessThan(fit.vw);
          expect(fit.height).toBeLessThan(fit.vh);
          report(`geometry-${zoom}-${fullscreen}.json`, {
            appZoom: zoom,
            nativeMetrics: await browser.execute(() => ({ devicePixelRatio: window.devicePixelRatio, outerWidth: window.outerWidth, outerHeight: window.outerHeight, innerWidth: window.innerWidth, innerHeight: window.innerHeight })),
            fullscreen,
            centered,
            before,
            panned,
            anchor,
            wheeled,
            fit,
            nativeWheelDelivery: "DOM",
            heldPointerCursor: "grabbing",
          });
        });
      }
    it("navigates all mixed-size pages and internal links without changing bytes", async () => {
      if (await $(".preview-pane.fullscreen").isExisting())
        await browser.keys("Escape");
      await appZoom(150);
      await zoomTo(130);
      await $('a.pdf-link[href="#"]').click();
      await ready([153, 0, 204, 255]);
      expect((await domText(".page-count")).trim()).toBe("2 / 3");
      await capture("pdf-page-2-native-125-output-150-app.png");
      await $('[aria-label="Next PDF page"]').click();
      await ready([255, 128, 0, 255]);
      await $('[aria-label="Previous PDF page"]').click();
      await ready([153, 0, 204, 255]);
      await $('[aria-label="Previous PDF page"]').click();
      await ready();
      expect(
        createHash("sha256").update(fs.readFileSync(pdf)).digest("hex"),
      ).toBe(originalHash);
      report("source-preservation.json", {
        sha256: originalHash,
        unchanged: true,
        pageColors: [
          [255, 0, 0, 255],
          [153, 0, 204, 255],
          [255, 128, 0, 255],
        ],
      });
    });
    (isLinux ? it : it.skip)("a link drag launches nothing; an ordinary zoomed click dispatches the intact URL to an owned native handler", async () => {
      await ready();
      await zoomTo(400);
      await $(".pdf-controls .fit-button").click();
      await zoomTo(130);
      const link = $('a.pdf-link[href="https://example.com/pdf-proof"]');
      const box = await browser.execute(() => {
        const rect = document
          .querySelector('a.pdf-link[href="https://example.com/pdf-proof"]')!
          .getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      });
      await drag(box, { x: box.x + 30, y: box.y - 30 });
      expect(fs.existsSync(linkReceipt)).toBe(false);
      await link.click();
      await browser.waitUntil(() => fs.existsSync(linkReceipt), {
        timeoutMsg: "Owned URL handler did not receive the PDF link",
      });
      const received = JSON.parse(fs.readFileSync(linkReceipt, "utf8"));
      linkViewerPid = received.pid;
      expect(received.url).toBe("https://example.com/pdf-proof");
      const actualEnv = Object.fromEntries(
        fs
          .readFileSync(`/proc/${linkViewerPid}/environ`, "utf8")
          .split("\0")
          .filter((row) => row.includes("="))
          .map((row) => {
            const i = row.indexOf("=");
            return [row.slice(0, i), row.slice(i + 1)];
          }),
      );
      for (const key of [
        "GDK_BACKEND",
        "WAYLAND_DISPLAY",
        "XDG_RUNTIME_DIR",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "DBUS_SESSION_BUS_ADDRESS",
      ])
        expect(actualEnv[key]).toBe(process.env[key]);
      expect(actualEnv.DISPLAY).toBeUndefined();
      ipc(`[pid=${linkViewerPid}] move container to output HEADLESS-2, focus`);
      const tree = sway("get_tree");
      function isFocused(node: any): boolean {
        return (
          (node.pid === linkViewerPid && node.focused) ||
          [...(node.nodes ?? []), ...(node.floating_nodes ?? [])].some(
            isFocused,
          )
        );
      }
      expect(isFocused(tree)).toBe(true);
      execFileSync("grim", [
        "-o",
        "HEADLESS-2",
        path.join(screenshots, "pdf-external-link-native-owned-handler.png"),
      ]);
      report("external-link-isolation.json", {
        ...received,
        actualEnvironment: Object.fromEntries(
          [
            "GDK_BACKEND",
            "WAYLAND_DISPLAY",
            "XDG_RUNTIME_DIR",
            "XDG_CONFIG_HOME",
            "XDG_DATA_HOME",
            "DBUS_SESSION_BUS_ADDRESS",
          ].map((key) => [key, actualEnv[key]]),
        ),
        nativeTree: tree,
      });
      stopLinkViewer();
      ipc(`[pid=${appPid}] focus`);
      await browser.waitUntil(async () =>
        browser.execute(() => document.hasFocus()),
      );
    });
    it("reaches off-screen corners, resets to fit, and navigates pages by keyboard", async () => {
      await zoomTo(400);
      const before = await geometry();
      await capture("pdf-corner-before-native-125-output-150-app.png");
      for (let index = 0; index < 15; index++)
        await drag(
          { x: before.vcx, y: before.vcy },
          { x: before.vcx + 120, y: before.vcy + 120 },
        );
      const topLeft = await geometry();
      expect(topLeft.x + topLeft.width * 0.1).toBeGreaterThan(topLeft.vx);
      expect(topLeft.x + topLeft.width * 0.1).toBeLessThan(
        topLeft.vx + topLeft.vw,
      );
      expect(topLeft.y + topLeft.height * 0.075).toBeGreaterThan(topLeft.vy);
      expect(topLeft.y + topLeft.height * 0.075).toBeLessThan(
        topLeft.vy + topLeft.vh,
      );
      await capture("pdf-corner-top-left-native-125-output-150-app.png");
      for (let index = 0; index < 30; index++)
        await drag(
          { x: before.vcx, y: before.vcy },
          { x: before.vcx - 120, y: before.vcy - 120 },
        );
      const bottomRight = await geometry();
      expect(bottomRight.x + bottomRight.width * 0.9).toBeGreaterThan(
        bottomRight.vx,
      );
      expect(bottomRight.x + bottomRight.width * 0.9).toBeLessThan(
        bottomRight.vx + bottomRight.vw,
      );
      expect(bottomRight.y + bottomRight.height * 0.925).toBeGreaterThan(
        bottomRight.vy,
      );
      expect(bottomRight.y + bottomRight.height * 0.925).toBeLessThan(
        bottomRight.vy + bottomRight.vh,
      );
      await capture("pdf-corner-bottom-right-native-125-output-150-app.png");
      await $(".pdf-controls .fit-button").click();
      await ready();
      await capture("pdf-reset-after-pan-native-125-output-150-app.png");
      await $(".pdf-viewport").click();
      await browser.keys("PageDown");
      await ready([153, 0, 204, 255]);
      await browser.keys("End");
      await ready([255, 128, 0, 255]);
      await browser.keys("Home");
      await ready();
      await browser.keys("Escape");
      report("corner-reach-and-keyboard.json", {
        before,
        topLeft,
        bottomRight,
        trustedDrag: true,
        keyboardPageColors: [
          [153, 0, 204, 255],
          [255, 128, 0, 255],
          [255, 0, 0, 255],
        ],
      });
    });
    it("keeps fit centered when docking and narrowing the native preview at app150", async () => {
      await appZoom(150);
      const initialWindow = await browser.execute(() => ({ width: window.innerWidth, height: window.innerHeight }));
      if (isLinux) ipc(
        `[pid=${appPid}] floating enable, resize set width 1000px height 750px`,
      );
      else {
        await browser.setWindowSize(1000, 750);
        await browser.waitUntil(async () => browser.execute((initial: { width: number; height: number }) => window.innerWidth < initial.width && window.innerHeight < initial.height, initialWindow));
      }
      for (const dock of ["Top", "Bottom", "Right"]) {
        await command(`Dock Preview Pane ${dock}`);
        if (dock === "Right") await expect($(".preview-pane.dock-top, .preview-pane.dock-bottom")).not.toExist();
        else await expect($(`.preview-pane.dock-${dock.toLowerCase()}`)).toBeDisplayed();
        await $(".pdf-controls .fit-button").click();
        await ready();
        await browser.waitUntil(async () => {
          const g = await geometry();
          return (
            Math.abs(g.cx - g.vcx) < 2 &&
            Math.abs(g.cy - g.vcy) < 2 &&
            g.width < g.vw &&
            g.height < g.vh
          );
        });
        const fit = await geometry();
        await capture(
          `pdf-narrow-${dock.toLowerCase()}-native-125-output-150-app.png`,
        );
        const layout = await browser.execute(() => {
          const pane = document.querySelector(".preview-pane")!.getBoundingClientRect();
          const explorer = document.querySelector(".pane-container")!.getBoundingClientRect();
          const viewport = document.querySelector(".pdf-viewport")!.getBoundingClientRect();
          const controls = Array.from(document.querySelectorAll(".pdf-controls button")).map(button => {
            const rect = button.getBoundingClientRect();
            return { label: button.getAttribute("aria-label") ?? button.textContent, x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
          });
          return { pane: { x: pane.x, y: pane.y, right: pane.right, bottom: pane.bottom }, explorer: { x: explorer.x, y: explorer.y, right: explorer.right, bottom: explorer.bottom }, viewport: { width: viewport.width, height: viewport.height }, window: { width: innerWidth, height: innerHeight }, controls };
        });
        if (dock === "Right") expect(layout.pane.x).toBeGreaterThanOrEqual(layout.explorer.right - 1);
        else if (dock === "Top") expect(layout.pane.bottom).toBeLessThanOrEqual(layout.explorer.y + 1);
        else expect(layout.pane.y).toBeGreaterThanOrEqual(layout.explorer.bottom - 1);
        expect(layout.viewport.width).toBeLessThan(layout.window.width);
        expect(layout.viewport.height).toBeLessThan(layout.window.height);
        expect(layout.controls.length).toBeGreaterThan(0);
        for (const control of layout.controls) {
          expect(control.width).toBeGreaterThanOrEqual(20);
          expect(control.height).toBeGreaterThanOrEqual(20);
          expect(control.x).toBeGreaterThanOrEqual(layout.pane.x - 1);
          expect(control.right).toBeLessThanOrEqual(layout.pane.right + 1);
          expect(control.y).toBeGreaterThanOrEqual(layout.pane.y - 1);
          expect(control.bottom).toBeLessThanOrEqual(layout.pane.bottom + 1);
          expect(control.right).toBeLessThanOrEqual(layout.window.width + 1);
          expect(control.bottom).toBeLessThanOrEqual(layout.window.height + 1);
        }
        report(`narrow-${dock.toLowerCase()}.json`, { fit, layout });
      }
      if (isLinux) ipc(`[pid=${appPid}] floating disable`);
      else await browser.setWindowSize(1200, 900);
      await ready();
    });
    (isLinux ? it : it.skip)("real native blur ends a held pan and later movement cannot continue it", async () => {
      await zoomTo(400);
      const initial = await geometry();
      const start = { x: initial.vcx, y: initial.vcy };
      await drag(start, { x: start.x - 30, y: start.y - 30 }, false);
      await $(".pdf-viewport.panning").waitForExist();
      expect(await browser.execute(() => document.hasFocus())).toBe(true);
      ipc("workspace pdf-private-empty");
      await browser.waitUntil(
        async () => !(await browser.execute(() => document.hasFocus())),
      );
      await $(".pdf-viewport.panning").waitForExist({ reverse: true });
      const blurred = await geometry();
      ipc(`[pid=${appPid}] focus`);
      await browser.waitUntil(async () =>
        browser.execute(() => document.hasFocus()),
      );
      await browser.performActions([
        {
          type: "pointer",
          id: "pdf-pointer",
          parameters: { pointerType: "mouse" },
          actions: [
            {
              type: "pointerMove",
              duration: 100,
              origin: "viewport",
              x: Math.round(start.x - 60),
              y: Math.round(start.y - 60),
            },
            { type: "pointerUp", button: 0 },
          ],
        },
      ]);
      await browser.releaseActions();
      const after = await geometry();
      expect(Math.abs(after.cx - blurred.cx)).toBeLessThan(2);
      expect(Math.abs(after.cy - blurred.cy)).toBeLessThan(2);
      report("blur-cancellation.json", {
        blurred,
        after,
        nativeFocusLoss: true,
      });
    });
    it("shows image-consistent framing and a truthful corrupt-document error; stops departed workers", async () => {
      await $(entryPathSelector(path.join(directory, "2-image.svg"))).click();
      await $(".preview-image").waitForDisplayed();
      await capture("image-comparison-native-125-output-150-app.png");
      await $(entryPathSelector(path.join(directory, "1-corrupt.pdf"))).click();
      await $(".pdf-message[role=alert]").waitForDisplayed();
      expect(await domText(".pdf-message[role=alert]")).toContain(
        "Cannot preview PDF",
      );
      await capture("pdf-error-native-125-output-150-app.png");
      await $(entryPathSelector(path.join(directory, "2-image.svg"))).click();
      await $(".preview-image").waitForDisplayed();
      await browser.waitUntil(
        async () =>
          browser.execute(() => {
            const events = JSON.parse(
              document.documentElement.dataset.e2ePdfWorkers || "[]",
            ) as Array<{ id: string; phase: string }>;
            return (
              events
                .filter((e) => e.phase === "created")
                .every((e) =>
                  events.some((t) => t.id === e.id && t.phase === "terminated"),
                ) &&
              [...document.fonts].every((font) => !/^g_d\d+_/.test(font.family))
            );
          }),
        { timeoutMsg: "Departed PDF retained a worker or document FontFace" },
      );
      const receipts = await browser.execute(() =>
        JSON.parse(document.documentElement.dataset.e2ePdfWorkers || "[]"),
      );
      expect(
        receipts
          .filter((item: { phase: string }) => item.phase === "ready")
          .every((item: { id: string }) =>
            receipts.some(
              (ended: { id: string; phase: string }) =>
                ended.id === item.id && ended.phase === "terminated",
            ),
          ),
      ).toBe(true);
      report("worker-lifetime.json", receipts);
    });
    after(async () => {
      stopLinkViewer();
      await browser.releaseActions();
      report("suite-cleanup.json", { sourceCommit: process.env.GITHUB_SHA ?? null, completed: true });
    });
  },
);

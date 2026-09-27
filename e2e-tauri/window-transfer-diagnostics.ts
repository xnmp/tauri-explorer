import { browser } from "@wdio/globals";
import fs from "node:fs";
import path from "node:path";

export async function captureDiagnostics(
  reason: string,
  context: Record<string, unknown> = {},
): Promise<void> {
  const diagnostics: unknown[] = [];
  const slug = reason.replace(/[^a-z0-9-]/gi, "-");
  const logDirectory = path.resolve("e2e-tauri", "logs");
  const artifact = {
    reason,
    capturedAt: new Date().toISOString(),
    commit: process.env.GITHUB_SHA ?? null,
    platform: process.platform,
    runtime: browser.capabilities,
    context,
    windows: diagnostics,
  };
  fs.mkdirSync(logDirectory, { recursive: true });
  const persist = () => fs.writeFileSync(
    path.join(logDirectory, `window-transfer-${slug}.json`),
    JSON.stringify(artifact, null, 2),
  );
  // Leave metadata behind even if a later driver request never returns.
  persist();
  const original = await browser.getWindowHandle().catch(() => null);
  // Capture the failing window before inspecting any unrelated window.
  await browser.saveScreenshot(path.join(logDirectory, `window-transfer-${slug}.png`))
    .catch((error) => diagnostics.push({ handle: original, screenshotError: String(error) }));
  persist();
  const handles: string[] = await browser.getWindowHandles().catch((error) => {
    diagnostics.push({ captureError: String(error) });
    return [];
  });
  persist();
  for (const handle of handles) {
    try {
      await browser.switchToWindow(handle);
      diagnostics.push(await browser.execute((windowHandle, failureReason) => ({
        reason: failureReason,
        handle: windowHandle,
        label: document.documentElement.dataset.e2eWindowLabel ?? null,
        url: location.href,
        title: document.title,
        bodyText: document.body?.textContent?.slice(0, 4_000) ?? null,
        statusPaths: [...document.querySelectorAll(".status-path")].map((node) => ({
          text: node.textContent, title: node.getAttribute("title"),
        })),
        panes: [...document.querySelectorAll(".explorer-pane")].map((pane) => ({
          classes: pane.className,
          text: pane.textContent?.slice(0, 1_500),
          html: pane.innerHTML.slice(0, 3_000),
          entries: [...pane.querySelectorAll(".entry-name")].map((node) => node.textContent),
          error: pane.querySelector(".error-state")?.textContent ?? null,
          loading: !!pane.querySelector(".loading"),
        })),
        activeElement: document.activeElement
          ? { tag: document.activeElement.tagName, classes: document.activeElement.className }
          : null,
        tabCount: document.querySelectorAll(".tab-area > .tab").length,
        storage: Object.keys(localStorage).filter((key) => key.includes("seed") || key.includes("tabs"))
          .map((key) => ({ key, value: localStorage.getItem(key)?.slice(0, 2_000) })),
        operationResult: document.documentElement.dataset.e2eWindowResult ?? null,
      }), handle, reason));
    } catch (captureError) {
      diagnostics.push({ reason, handle, captureError: String(captureError) });
    }
    persist();
  }
  console.error(`[window-transfer-diagnostics] ${JSON.stringify(artifact, null, 2)}`);
  if (original && handles.includes(original)) {
    await browser.switchToWindow(original).catch(() => {});
  }
}

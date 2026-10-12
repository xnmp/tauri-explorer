/** Real browser stripping/sanitization, independent of synthetic DOM drops.
 * OS application acceptance is outside a headless in-page test's contract. */
import { test, expect } from "@playwright/test";
import { html5DragHtml, html5DragUriList } from "../src/lib/domain/file-drop";

for (const policy of ["modifier", "link"] as const) {
  test(`standard HTML session carrier survives real browser drag (${policy})`, async ({ page }) => {
    const source = { sessionId: "webkit-carrier-probe", path: "/tmp/a b.png", nativeCopyPolicy: policy };
    await page.setContent('<div id="source" draggable="true" style="width:100px;height:100px">Source</div><div id="target" style="margin-top:100px;width:200px;height:100px">Target</div>');
    await page.evaluate(({ uri, html }) => {
      document.querySelector("#source")!.addEventListener("dragstart", event => {
        const data = (event as DragEvent).dataTransfer!;
        data.setData("application/x-explorer-session", "webkit-carrier-probe");
        data.setData("text/uri-list", uri); data.setData("text/html", html);
      });
      document.querySelector("#target")!.addEventListener("dragover", event => event.preventDefault());
      document.querySelector("#target")!.addEventListener("drop", event => {
        event.preventDefault();
        const data = (event as DragEvent).dataTransfer!;
        document.querySelector("#target")!.textContent = data.getData("text/html");
      });
    }, { uri: html5DragUriList(source), html: html5DragHtml(source) });
    await page.locator("#source").dragTo(page.locator("#target"));
    await expect(page.locator("#target")).toHaveText(html5DragHtml(source));
  });
}

import { test, expect } from "./fixtures";

test("Recycle Bin uses a distinct amber sidebar icon (#660)", async ({ page }) => {
  await page.goto("/");

  const recycleBinIcon = page.getByRole("button", { name: "Open Recycle Bin" }).locator("svg");
  await expect(recycleBinIcon).toHaveCSS("color", "rgb(217, 119, 6)");
  await page.screenshot({ path: "evidence/ac-4-recycle-bin-icon.png" });
});

test("Recycle Bin surfaces a launcher failure (#660)", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("mock-open-recycle-bin-error", "No trash folder handler is available");
  });
  await page.goto("/");

  await page.getByRole("button", { name: "Open Recycle Bin" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Could not open Recycle Bin: No trash folder handler is available",
  );
});

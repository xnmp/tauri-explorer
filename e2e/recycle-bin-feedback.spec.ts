import { test, expect } from "./fixtures";
import { MOCK_LOCAL_KEYS } from "../src/lib/api/mock-control";

test("Recycle Bin uses a distinct amber sidebar icon (#660)", async ({ page }) => {
  await page.goto("/");

  const recycleBinIcon = page.getByRole("button", { name: "Open Recycle Bin" }).locator("svg");
  await expect(recycleBinIcon).toHaveCSS("color", "rgb(217, 119, 6)");
  await page.screenshot({ path: "evidence/ac-4-recycle-bin-icon.png" });
});

test("Recycle Bin surfaces a system launcher failure (#660)", async ({ page }) => {
  await page.addInitScript((key) => {
    localStorage.setItem(key, "No trash folder handler is available");
  }, MOCK_LOCAL_KEYS.openRecycleBinError);
  await page.goto("/");

  // The sidebar opens the in-app Trash (#863); the system launcher remains
  // available from the Trash view's context menu.
  await page.getByRole("button", { name: "Open Recycle Bin" }).click();
  await page.getByText("The Trash is empty").click({ button: "right" });
  await page.locator(".context-menu .menu-item", { hasText: "Open in System File Manager" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Could not open Recycle Bin: No trash folder handler is available",
  );
});

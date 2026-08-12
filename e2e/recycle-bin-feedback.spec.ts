import { test, expect } from "./fixtures";

test("Recycle Bin uses a distinct amber sidebar icon (#660)", async ({ page }) => {
  await page.goto("/");

  const recycleBinIcon = page.getByRole("button", { name: "Open Recycle Bin" }).locator("svg");
  await expect(recycleBinIcon).toHaveCSS("color", "rgb(217, 119, 6)");
});

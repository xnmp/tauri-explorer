/** #731: hide the unwanted shortcut without hiding or changing its mount. */
import fs from "node:fs";
import path from "node:path";
import { test, expect } from "./fixtures";
import { HOME_URL, waitForEntries } from "./helpers";
import type { MockControl } from "../src/lib/api/mock-control";
import type { Drive } from "../src/lib/api/drives";

type Fixture = { __mockControl?: MockControl };
const [google, remote] = JSON.parse(fs.readFileSync("tests/fixtures/sidebar-cloud-mounts.json", "utf8")) as Drive[];
const usb = { name: "USB Backup", path: "/media/user/USB_DRIVE", kind: "removable" as const };
const proof = "screenshots/fix/731-remnove-this-gdrive";

async function capture(page: import("@playwright/test").Page, name: string): Promise<void> {
  if (process.env.CAPTURE_731 !== "1") return;
  fs.mkdirSync(proof, { recursive: true });
  await page.screenshot({ path: path.join(proof, name) });
}

test("sidebar refresh and restart omit Google Drive while other drives and its direct path work", async ({ page }) => {
  await page.addInitScript((drives) => {
    ((window as unknown as Fixture).__mockControl ??= {}).linuxVolumes = drives;
  }, [google, usb, remote]);
  await page.goto(HOME_URL);
  await waitForEntries(page);
  const drive = (name: string) => page.locator(".drive-item").filter({ hasText: name });
  await expect(drive("Documents")).toBeVisible();
  await expect(drive("USB Backup")).toBeVisible();
  await expect(drive("Google Drive")).toHaveCount(0);
  await drive("Documents").click();
  await expect(page.locator('.entry-item[data-path="/home/user/Documents/report.pdf"]')).toBeVisible();
  await drive("USB Backup").click();
  await expect(page.locator('.entry-item[data-path="/media/user/USB_DRIVE/photo.jpg"]')).toBeVisible();
  await page.evaluate(({ google, usb, remote }) => {
    ((window as unknown as Fixture).__mockControl ??= {}).linuxVolumes = [google, usb, { ...remote, name: "Remote refreshed" }];
  }, { google, usb, remote });
  await expect(drive("Remote refreshed")).toBeVisible();
  await expect(drive("Google Drive")).toHaveCount(0);
  await capture(page, "sidebar-after-discovery-refresh.png");
  await page.getByRole("button", { name: "Cloud & Remote" }).click();
  await page.getByRole("button", { name: "Cloud & Remote" }).click();
  await expect(drive("Remote refreshed")).toBeVisible();
  await expect(drive("Google Drive")).toHaveCount(0);
  await page.reload();
  await waitForEntries(page);
  await expect(drive("Documents")).toBeVisible();
  await expect(drive("Google Drive")).toHaveCount(0);
  await page.keyboard.press("Control+l");
  await page.locator(".path-input").fill(google.path!);
  await page.locator(".path-input").press("Enter");
  const child = page.locator(`.entry-item[data-path="${google.path}/My Drive"]`);
  await expect(child).toBeVisible();
  await child.dblclick();
  await expect(page.locator(`.entry-item[data-path="${google.path}/My Drive/doc.gdoc"]`)).toBeVisible();
  await expect(drive("Google Drive")).toHaveCount(0);
  await capture(page, "existing-google-mount-direct-navigation.png");
});

test("no empty cloud heading or divider remains when Google Drive is the only cloud location", async ({ page }) => {
  await page.addInitScript((drives) => {
    ((window as unknown as Fixture).__mockControl ??= {}).linuxVolumes = drives;
  }, [google, usb]);
  await page.goto(HOME_URL);
  await waitForEntries(page);
  await expect(page.locator(".drive-item").filter({ hasText: "USB Backup" })).toBeVisible();
  await expect(page.locator(".drive-item").filter({ hasText: "Google Drive" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Cloud & Remote" })).toHaveCount(0);
  await capture(page, "no-empty-cloud-section.png");
});

import { test, expect } from "./fixtures";
import { HOME_URL, waitForEntries } from "./helpers";
import type { MockControl } from "../src/lib/api/mock-control";

type VolumeFixture = { __mockControl?: MockControl };
const volume = { name: "USB Backup", path: null, kind: "removable" as const, deviceId: "/org/freedesktop/UDisks2/block_devices/sdb1" };

test("Linux volume sidebar discovers, mounts, reports errors and removes volumes", async ({ page }) => {
  // addInitScript runs before mock-invoke.ts creates window.__mockControl, so
  // this writer must create it (`??=`) rather than assume it exists.
  await page.addInitScript(({ volume }) => {
    ((window as unknown as VolumeFixture).__mockControl ??= {}).linuxVolumes = [volume,
      { name: "Google Drive", path: "/media/user/GoogleDrive", kind: "cloud", provider: "googledrive" },
    ];
  }, { volume });
  await page.goto(HOME_URL);
  await waitForEntries(page);
  const usb = page.locator(".drive-item").filter({ hasText: "USB Backup" });
  await expect(usb).toHaveCount(1);
  await expect(usb).toContainText("Not mounted");
  await page.evaluate(() => (((window as unknown as VolumeFixture).__mockControl ??= {}).linuxVolumes ??= []).push({
    name: "SD Card", path: null, kind: "removable", deviceId: "/org/freedesktop/UDisks2/block_devices/sdc1",
  }));
  await expect(page.locator(".drive-item").filter({ hasText: "SD Card" })).toBeVisible();

  await page.evaluate(() => { ((window as unknown as VolumeFixture).__mockControl ??= {}).mountError = "Not authorized to mount USB Backup"; });
  await usb.click();
  await expect(page.locator(".toast").filter({ hasText: "Not authorized" })).toBeVisible();
  await expect(usb).toContainText("Not mounted");
  await expect(page.locator(".entry-item").filter({ hasText: "Documents" }).first()).toBeVisible();
  await page.screenshot({ animations: "disabled", path: "evidence/ac-2-linux-mount-error.png" });
  await page.evaluate(() => { delete ((window as unknown as VolumeFixture).__mockControl ??= {}).mountError; });
  await usb.click();
  await expect(usb).not.toContainText("Not mounted");
  await expect(page.locator(".entry-item").filter({ hasText: "photo.jpg" })).toBeVisible();
  await expect(usb).toHaveCount(1);
  const mounts = await page.evaluate(() => (window as unknown as VolumeFixture).__mockControl?.invokeCounts?.mount_drive);
  await usb.click();
  expect(await page.evaluate(() => (window as unknown as VolumeFixture).__mockControl?.invokeCounts?.mount_drive)).toBe(mounts);
  await expect(page.locator(".toast").filter({ hasText: "Not authorized" })).toBeHidden({ timeout: 10000 });
  await page.evaluate(() => {
    const w = ((window as unknown as VolumeFixture).__mockControl ??= {});
    w.linuxVolumes = (w.linuxVolumes ?? []).filter(d => d.name !== "USB Backup");
  });
  await expect(usb).toHaveCount(0);
  await expect(page.locator(".drive-gone-state")).toContainText("Removable drive removed");
  await expect(page.locator(".drive-item").filter({ hasText: "Google Drive" })).toHaveCount(0);
  await page.screenshot({ animations: "disabled", path: "evidence/ac-3-linux-volume-removal.png" });
});

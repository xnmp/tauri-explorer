import { test, expect } from "./fixtures";
import { HOME_URL, waitForEntries } from "./helpers";
import type { Drive } from "../src/lib/api/drives";

type VolumeFixture = { __mockLinuxVolumes: Drive[]; __mockMountError?: string; __mockInvokeCounts?: Record<string, number> };
const volume = { name: "USB Backup", path: "", kind: "removable" as const, device_id: "/org/freedesktop/UDisks2/block_devices/sdb1" };

test("Linux volume sidebar discovers, mounts, reports errors and removes volumes", async ({ page }) => {
  await page.addInitScript(({ volume }) => {
    (window as unknown as VolumeFixture).__mockLinuxVolumes = [volume,
      { name: "Google Drive", path: "/media/user/GoogleDrive", kind: "cloud", provider: "googledrive" },
    ];
  }, { volume });
  await page.goto(HOME_URL);
  await waitForEntries(page);
  const usb = page.locator(".drive-item").filter({ hasText: "USB Backup" });
  await expect(usb).toHaveCount(1);
  await expect(usb).toContainText("Not mounted");
  await page.evaluate(() => (window as unknown as VolumeFixture).__mockLinuxVolumes.push({
    name: "SD Card", path: "", kind: "removable", device_id: "/org/freedesktop/UDisks2/block_devices/sdc1",
  }));
  await expect(page.locator(".drive-item").filter({ hasText: "SD Card" })).toBeVisible();
  await page.screenshot({ path: "evidence/ac-1-linux-unmounted-volumes.png" });

  await page.evaluate(() => { (window as unknown as VolumeFixture).__mockMountError = "Not authorized to mount USB Backup"; });
  await usb.click();
  await expect(page.locator(".toast").filter({ hasText: "Not authorized" })).toBeVisible();
  await expect(usb).toContainText("Not mounted");
  await expect(page.locator(".breadcrumbs-container")).toContainText("user");
  await page.screenshot({ path: "evidence/ac-2-linux-mount-error.png" });
  await page.evaluate(() => { delete (window as unknown as VolumeFixture).__mockMountError; });
  await usb.click();
  await expect(usb).not.toContainText("Not mounted");
  await expect(page.locator(".entry-item").filter({ hasText: "backup.zip" })).toBeVisible();
  await expect(usb).toHaveCount(1);
  const mounts = await page.evaluate(() => (window as unknown as VolumeFixture).__mockInvokeCounts?.mount_drive);
  await usb.click();
  expect(await page.evaluate(() => (window as unknown as VolumeFixture).__mockInvokeCounts?.mount_drive)).toBe(mounts);
  await page.evaluate(() => {
    const w = window as unknown as VolumeFixture;
    w.__mockLinuxVolumes = w.__mockLinuxVolumes.filter(d => d.name !== "USB Backup");
  });
  await expect(usb).toHaveCount(0);
  await expect(page.locator(".drive-gone-state")).toContainText("Removable drive removed");
  await expect(page.locator(".drive-item").filter({ hasText: "Google Drive" })).toBeVisible();
  await page.screenshot({ path: "evidence/ac-3-linux-volume-removal.png" });
});

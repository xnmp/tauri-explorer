import { test, expect } from "./fixtures";
import { HOME_URL, waitForEntries } from "./helpers";
import type { Drive } from "../src/lib/api/drives";

type VolumeFixture = {
  __mockLinuxVolumes: Drive[];
  __mockUDisksUnavailable?: boolean;
  __mockInvokeCounts?: Record<string, number>;
};
const usb: Drive = { name: "USB Backup", path: "", kind: "removable", device_id: "/org/freedesktop/UDisks2/block_devices/sdb1" };
const sd: Drive = { name: "SD Card", path: "", kind: "removable", device_id: "/org/freedesktop/UDisks2/block_devices/sdc1" };
const cloud: Drive = { name: "Google Drive", path: "/media/user/GoogleDrive", kind: "cloud", provider: "googledrive" };

test("AC 1 shows startup and inserted volumes with spaces and literal escape text", async ({ page }) => {
  await page.addInitScript(({ usb, cloud }) => {
    (window as unknown as VolumeFixture).__mockLinuxVolumes = [usb,
      { name: "Raw\\x20", path: "", kind: "removable", device_id: "/org/freedesktop/UDisks2/block_devices/sdd1" }, cloud];
  }, { usb, cloud });
  await page.goto(HOME_URL);
  await waitForEntries(page);
  await expect(page.locator(".drive-name").filter({ hasText: /^USB Backup$/ })).toBeVisible();
  await expect(page.locator(".drive-name").filter({ hasText: "Raw\\x20" })).toHaveText("Raw\\x20");
  await page.evaluate(sd => (window as unknown as VolumeFixture).__mockLinuxVolumes.push(sd), sd);
  await expect(page.locator(".drive-item").filter({ hasText: "SD Card" })).toContainText("Not mounted");
  await expect(page.locator(".drive-item").filter({ hasText: "Raw\\x20" })).toContainText("Not mounted");
  expect(await page.evaluate(() => (window as unknown as VolumeFixture).__mockInvokeCounts?.mount_drive ?? 0)).toBe(0);
  await page.screenshot({ animations: "disabled", path: "evidence/ac-1-linux-literal-labels.png" });
});

test("AC 3 shows one mounted row after refresh and mounted fallback during UDisks outage", async ({ page }) => {
  await page.addInitScript(volumes => { (window as unknown as VolumeFixture).__mockLinuxVolumes = volumes; }, [usb, sd, cloud]);
  await page.goto(HOME_URL);
  await waitForEntries(page);
  const backup = page.locator(".drive-item").filter({ hasText: "USB Backup" });
  await expect(backup).toContainText("Not mounted");
  await backup.click();
  await expect(page.locator(".entry-item").filter({ hasText: "photo.jpg" })).toBeVisible();
  const polls = await page.evaluate(() => (window as unknown as VolumeFixture).__mockInvokeCounts?.list_drives ?? 0);
  await expect.poll(() => page.evaluate(() => (window as unknown as VolumeFixture).__mockInvokeCounts?.list_drives ?? 0)).toBeGreaterThan(polls + 1);
  await expect(backup).toHaveCount(1);
  await expect(backup).not.toContainText("Not mounted");
  await page.screenshot({ animations: "disabled", path: "evidence/ac-3-linux-mounted-single-entry.png" });

  // The service disappears while opening a previously discovered volume. Change
  // the fixture and click in one browser task so polling cannot remove it first.
  await page.locator(".drive-item").filter({ hasText: "SD Card" }).evaluate(button => {
    (window as unknown as VolumeFixture).__mockUDisksUnavailable = true;
    (button as HTMLButtonElement).click();
  });
  const unavailable = page.locator(".toast").filter({ hasText: "Linux storage service (UDisks2) unavailable" });
  await expect(unavailable).toBeVisible();
  await expect(page.locator(".drive-item").filter({ hasText: "SD Card" })).toHaveCount(0);
  await expect(backup).toHaveCount(1);
  await expect(page.locator(".drive-item").filter({ hasText: "Google Drive" })).toBeVisible();
  const mountCalls = await page.evaluate(() => (window as unknown as VolumeFixture).__mockInvokeCounts?.mount_drive);
  await backup.click();
  await expect(page.locator(".entry-item").filter({ hasText: "photo.jpg" })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as VolumeFixture).__mockInvokeCounts?.mount_drive)).toBe(mountCalls);
  await expect(unavailable).toBeVisible();
  await page.screenshot({ animations: "disabled", path: "evidence/ac-3-linux-udisks-unavailable.png" });
});

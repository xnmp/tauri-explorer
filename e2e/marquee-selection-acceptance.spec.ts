import { test, expect } from "./fixtures";
import { waitForEntries, pressShortcut } from "./helpers";

test.use({ viewport: { width: 1600, height: 1000 } });
for (const mode of ["details", "list", "tiles"] as const) {
  for (const zoom of [100, 150]) {
    for (const reverse of [false, true]) {
      test(`${mode} at ${zoom}%: exact ${reverse ? "reverse" : "forward"} marquee and fast release (#756)`, async ({
        page,
      }) => {
        await page.goto("/?path=/home/user/Downloads");
        await waitForEntries(page);
        await pressShortcut(page, "p", { ctrlKey: true, shiftKey: true });
        await page
          .locator(".command-palette-dialog .search-input")
          .fill(`${mode[0].toUpperCase()}${mode.slice(1)} View`);
        await page.keyboard.press("Enter");
        await expect(page.locator(`.${mode}-view`)).toBeVisible();
        for (let value = 100; value < zoom; value += 10)
          await pressShortcut(page, "=", { ctrlKey: true });
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() =>
                requestAnimationFrame(() => resolve()),
              ),
            ),
        );
        const geometry = await page.evaluate((reverse) => {
          const content = document.querySelector(".file-list .content")!;
          const box = content.getBoundingClientRect();
          const entries = Array.from(
            content.querySelectorAll<HTMLElement>(".entry-item"),
          ).map((element) => {
            const rect = element.getBoundingClientRect();
            return {
              name: element.dataset.path!.split("/").at(-1)!,
              left: rect.left,
              top: rect.top,
              right: rect.right,
              bottom: rect.bottom,
            };
          });
          const bottom = Math.max(...entries.map((entry) => entry.bottom));
          const last = entries
            .filter((entry) => Math.abs(entry.bottom - bottom) < 2)
            .sort((a, b) => a.left - b.left)
            .slice(0, 2);
          const start = {
            x: Math.round(Math.min(...last.map((entry) => entry.left)) + 5),
            y: Math.round(bottom + 12),
          };
          const end = {
            x: Math.round(
              Math.min(
                box.right,
                Math.max(...last.map((entry) => entry.right)),
              ) - 5,
            ),
            y: Math.round(Math.min(...last.map((entry) => entry.top)) + 6),
          };
          if (reverse) [start.x, end.x] = [end.x, start.x];
          return {
            start,
            end,
            entries,
            background: !document
              .elementFromPoint(start.x, start.y)
              ?.closest(".entry-item"),
          };
        }, reverse);
        expect(geometry.background).toBe(true);
        const expected = geometry.entries
          .filter(
            (entry) =>
              entry.right > Math.min(geometry.start.x, geometry.end.x) &&
              entry.left < Math.max(geometry.start.x, geometry.end.x) &&
              entry.bottom > Math.min(geometry.start.y, geometry.end.y) &&
              entry.top < Math.max(geometry.start.y, geometry.end.y),
          )
          .map((entry) => entry.name)
          .sort();
        expect(expected.length).toBeGreaterThan(0);
        expect(expected.length).toBeLessThan(geometry.entries.length);
        await page.mouse.move(geometry.start.x, geometry.start.y);
        await page.mouse.down();
        await page.mouse.move(geometry.end.x, geometry.end.y, { steps: 8 });
        const band = page.locator(".marquee-rect");
        await expect
          .poll(async () => (await band.boundingBox())?.width)
          .toBeGreaterThan(0);
        const rect = (await band.boundingBox())!;
        expect(
          Math.abs(rect.x - Math.min(geometry.start.x, geometry.end.x)),
        ).toBeLessThan(3);
        expect(
          Math.abs(rect.y - Math.min(geometry.start.y, geometry.end.y)),
        ).toBeLessThan(3);
        expect(
          Math.abs(
            rect.x + rect.width - Math.max(geometry.start.x, geometry.end.x),
          ),
        ).toBeLessThan(3);
        expect(
          Math.abs(
            rect.y + rect.height - Math.max(geometry.start.y, geometry.end.y),
          ),
        ).toBeLessThan(3);
        await page.mouse.up();
        const selected = () =>
          page
            .locator(".entry-item.selected")
            .evaluateAll((elements) =>
              elements
                .map(
                  (element) =>
                    (element as HTMLElement).dataset.path!.split("/").at(-1)!,
                )
                .sort(),
            );
        await expect.poll(selected).toEqual(expected);

        // Freeze animation frames so mouseup must commit the final pending move.
        await page.keyboard.press("Escape");
        await expect(page.locator(".entry-item.selected")).toHaveCount(0);
        await page.clock.install();
        await page.clock.pauseAt(new Date());
        await page.mouse.move(geometry.start.x, geometry.start.y);
        await page.mouse.down();
        await page.mouse.move(geometry.end.x, geometry.end.y, { steps: 8 });
        await page.mouse.up();
        await expect.poll(selected).toEqual(expected);
        await expect(band).toHaveCount(0);
        await page.clock.resume();
      });
    }
  }
}

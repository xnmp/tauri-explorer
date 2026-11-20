/**
 * The tab outline matrix (`./tab-outline-matrix.ts`) for the Hairline Ledger layout (#1871).
 * One spec file per layout, so CI shards can place them apart; the tests are
 * registered here because Playwright selects a test by the file that calls
 * `test()` (#1866).
 */
import { test } from "./fixtures";
import { atRestAndHover, cellsFor, label, openingAndClosing, zoomed } from "./tab-outline-matrix";

const cells = cellsFor("hairline-ledger");

for (const cell of cells) {
  test.describe(`Tab outline matrix: ${label(cell)} (#1734, #1785)`, () => {
    // 1x explicitly: the WebKit project otherwise renders at 2x (covered below).
    test.use({ deviceScaleFactor: 1 });
    test.describe.configure({ timeout: 120_000 });
    test("at rest with 1, 3 and 12 tabs, and on hover", ({ page }) => atRestAndHover(page, cell));
    test("opening and closing a tab, held at 15%, 50% and 85% of the slide", ({ page }) => openingAndClosing(page, cell));
  });
}

test.describe("Tab outline matrix at 125% zoom on a 2x display (#1734, #1785)", () => {
  test.use({ deviceScaleFactor: 2 });
  test.describe.configure({ timeout: 120_000 });
  for (const cell of cells) {
    test(`at rest, opening and closing: ${label(cell)}`, ({ page }) => zoomed(page, cell));
  }
});

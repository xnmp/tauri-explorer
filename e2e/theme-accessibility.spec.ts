/**
 * Theme accessibility (#785): every built-in theme, with and without the
 * premium surfaces, passes an axe WCAG 2.1 A/AA scan of the main window in
 * each view mode. The scan includes a selected and a hovered entry, so it
 * measures those backgrounds as well as ordinary text.
 *
 * axe computes contrast against the background that actually composites
 * beneath each text node. Three things in this page defeat that computation
 * without changing what a user sees, so the scan neutralises them first:
 *
 * - `<html>` has no in-flow content (the body is absolutely positioned), so
 *   its box is zero pixels tall. Browsers propagate its `overflow: hidden` to
 *   the viewport, but axe treats the zero-height root as clipping every
 *   element, and skips all text as invisible. The root gets the viewport's
 *   height.
 * - The background-animation canvas sits under the whole window. axe cannot
 *   read pixels, so any text above an image is "incomplete". Reduced motion
 *   keeps the canvas blank, and it is then removed.
 * - The theme backdrop is a solid base colour under a radial glow of at most
 *   5% alpha. axe gives up on gradients, so it is removed and the base colour
 *   kept.
 * - The active tab paints its surface as stacked translucent layers, which
 *   axe does not composite. They are replaced by the colour they produce.
 * - Each tab draws a faint hover/active overlay and a 1px separator as
 *   pseudo-elements. axe cannot composite pseudo-element backgrounds, and
 *   neither sits behind the tab's text at a visible alpha, so both are
 *   removed.
 * - The title bar's sheen is a pseudo-element gradient from a translucent
 *   highlight to transparent, and it does sit behind the tab titles. Its two
 *   ends are the two worst cases: the plain bar for text darker than the bar,
 *   and the highlight at full strength for text lighter than it. The main
 *   scan sees the plain bar; a second scan of the title bar alone sees the
 *   highlight folded into the bar's solid colour.
 *
 * File-type icons draw their extension label as SVG text, or a Nerd Font
 * glyph. Either is part of the icon's picture, which WCAG 1.4.3 exempts, and
 * the file name and Type column carry the same information as real text, so
 * icon text is excluded.
 */
import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page } from "./fixtures";
import { VIEW_MODES, HOME_URL, switchViewMode, waitForEntries } from "./helpers";

const THEMES = [
  "aurora", "catppuccin", "dark", "desert", "gruvbox", "hacker",
  "horizon", "light", "nord", "ocean-blue", "solarized-light", "tahoe",
] as const;

async function prepareForContrast(page: Page) {
  await page.addStyleTag({
    content: `
      html { height: 100%; }
      canvas.animated-background { display: none !important; }
      .theme-background-layer { background-image: none !important; }
      .tab::before, .tab::after, .titlebar::before { content: none !important; }
    `,
  });
  await paintComposites(page, "active-tab");
}

/**
 * Replace translucent layer stacks with the one colour they composite to,
 * which axe can measure.
 * - `active-tab`: the active tab paints --background-card over
 *   --background-solid as background layers (its 1px side strokes sit at the
 *   edges, away from its text).
 * - `titlebar-sheen`: the title bar at its sheen's strongest stop. The sheen is
 *   read from the live rule; the style tag only hides it from axe.
 */
async function paintComposites(page: Page, target: "active-tab" | "titlebar-sheen") {
  await page.evaluate((which) => {
    type Rgba = [number, number, number, number];
    // The first colour in a computed value: rgb()/rgba() in 0-255, or the
    // color(srgb ...) form (0-1 channels) that color-mix() serialises to.
    const parse = (value: string): Rgba => {
      const match = value.match(/(rgba?|color)\(([^)]+)\)/);
      const channels = match?.[2].replace(/^srgb\s+/, "").split(/[\s,/]+/).filter(Boolean).map(Number);
      if (!match || !channels || channels.length < 3 || channels.some(Number.isNaN)) throw new Error(`unparsed colour ${value}`);
      const scale = match[1] === "color" ? 255 : 1;
      return [channels[0] * scale, channels[1] * scale, channels[2] * scale, channels[3] ?? 1];
    };
    const resolve = (token: string, scope: Element): Rgba => {
      const probe = document.createElement("span");
      probe.style.color = `var(${token})`;
      scope.append(probe);
      const colour = parse(getComputedStyle(probe).color);
      probe.remove();
      return colour;
    };
    const over = ([tr, tg, tb, ta]: Rgba, [br, bg, bb, ba]: Rgba) => {
      const alpha = ta + ba * (1 - ta);
      const mix = (top: number, bottom: number) => (top * ta + bottom * ba * (1 - ta)) / alpha;
      return `rgba(${mix(tr, br)}, ${mix(tg, bg)}, ${mix(tb, bb)}, ${alpha})`;
    };
    if (which === "active-tab") {
      for (const tab of document.querySelectorAll<HTMLElement>(".tab.active")) {
        tab.style.setProperty("background", over(resolve("--background-card", tab), resolve("--background-solid", tab)), "important");
      }
      return;
    }
    const bar = document.querySelector<HTMLElement>(".titlebar");
    if (!bar) throw new Error("no title bar");
    const sheen = getComputedStyle(bar, "::before");
    const [r, g, b, a] = parse(sheen.backgroundImage);
    bar.style.backgroundColor = over([r, g, b, a * Number(sheen.opacity)], parse(getComputedStyle(bar).backgroundColor));
  }, target);
}

type AxeResults = Awaited<ReturnType<AxeBuilder["analyze"]>>;

/** Every contrast check axe could not complete, and every violation. */
function contrastProblems(results: AxeResults) {
  const unmeasured = results.incomplete
    .filter((rule) => rule.id === "color-contrast")
    .flatMap((rule) => rule.nodes.map((node) => `unmeasured: ${node.target.join(" ")}: ${node.any[0]?.message}`));
  return [...unmeasured, ...describeViolations(results)];
}

const measuredCount = (results: AxeResults) =>
  results.passes.find((rule) => rule.id === "color-contrast")?.nodes.length ?? 0;

function describeViolations(results: AxeResults) {
  return results.violations.flatMap((violation) => violation.nodes.map((node) => {
    const data = node.any[0]?.data as { fgColor?: string; bgColor?: string; contrastRatio?: number } | undefined;
    const measured = data?.contrastRatio ? ` ${data.fgColor} on ${data.bgColor} = ${data.contrastRatio}:1` : "";
    return `${violation.id}: ${node.target.join(" ")}${measured}`;
  }));
}

for (const viewMode of VIEW_MODES) {
  for (const premium of [false, true]) {
    for (const theme of THEMES) {
      test(`${theme}${premium ? " (premium)" : ""} passes WCAG AA in ${viewMode} view`, async ({ page }) => {
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.addInitScript(([id, surfaces]) => {
          localStorage.setItem("explorer-settings", JSON.stringify({ theme: id, premiumTheme: surfaces }));
        }, [theme, premium] as const);
        await page.goto(HOME_URL);
        await waitForEntries(page);
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        if (premium) await expect(page.locator("html")).toHaveAttribute("data-premium", "true");
        else await expect(page.locator("html")).not.toHaveAttribute("data-premium");
        if (viewMode !== "details") await switchViewMode(page, viewMode);

        await page.locator(".entry-item").nth(1).click();
        await expect(page.locator(".entry-item.selected")).toHaveCount(1);
        // Row hover is its own background; keep the pointer on another entry.
        await page.locator(".entry-item").nth(3).hover();
        await prepareForContrast(page);

        const results = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
          .exclude("svg text").exclude(".nf-icon")
          .analyze();
        // A contrast rule that matched nothing proves nothing: the scan must
        // actually have measured this window's text.
        expect(measuredCount(results), "text nodes whose contrast axe measured").toBeGreaterThan(10);
        expect(contrastProblems(results)).toEqual([]);

        await paintComposites(page, "titlebar-sheen");
        const titlebar = await new AxeBuilder({ page })
          .include(".titlebar")
          .exclude("svg text").exclude(".nf-icon")
          .withRules(["color-contrast"])
          .analyze();
        expect(measuredCount(titlebar), "title-bar text measured under the sheen").toBeGreaterThan(0);
        expect(contrastProblems(titlebar)).toEqual([]);
      });
    }
  }
}

// The recovery notice's error state is drawn in the critical colour, which the
// main scan never shows. Fail the recovery subscription to reach it.
for (const premium of [false, true]) {
  for (const theme of THEMES) {
    test(`${theme}${premium ? " (premium)" : ""} recovery error notice passes WCAG AA`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.addInitScript(([id, surfaces]) => {
        localStorage.setItem("explorer-settings", JSON.stringify({ theme: id, premiumTheme: surfaces }));
        (globalThis as { __MOCK_FAILURES__?: Record<string, string> }).__MOCK_FAILURES__ = {
          file_recovery_subscribe: "recovery store unavailable",
        };
      }, [theme, premium] as const);
      await page.goto(HOME_URL);
      await waitForEntries(page);
      await expect(page.getByTestId("file-recovery-notice")).toHaveText("Recovery needs attention");
      await prepareForContrast(page);

      const results = await new AxeBuilder({ page })
        .include('[data-testid="file-recovery-notice"]')
        .withRules(["color-contrast"])
        .analyze();
      expect(measuredCount(results) + results.violations.length, "notice text measured").toBeGreaterThan(0);
      expect(contrastProblems(results)).toEqual([]);
    });
  }
}

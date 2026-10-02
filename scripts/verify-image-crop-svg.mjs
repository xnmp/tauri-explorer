// Native encoder -> independent browser pixel/animation outcomes. No dev server,
// desktop display or clipboard access. Temporary outputs are always removed.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { chromium, webkit } from '@playwright/test';

const directory = mkdtempSync(join(tmpdir(), 'explorer-svg-crop-'));
const fixtures = join(directory, 'fixtures.json');
try {
  const cargo = spawnSync('cargo', [
    'test', '--offline', '--manifest-path', 'src-tauri/Cargo.toml', '--lib',
    'image_crop::tests::svg_renderer_fixtures', '--', '--exact',
  ], { stdio: 'inherit', env: { ...process.env, EXPLORER_SVG_RENDER_FIXTURES: fixtures } });
  assert.equal(cargo.status, 0, 'production encoder fixture generation failed');
  const cases = JSON.parse(readFileSync(fixtures, 'utf8'));
  const failures = [];
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage();
      for (const fixture of cases) {
        const failureCount = failures.length;
        const result = await page.evaluate(async ({ fixture }) => {
          const load = async (bytes) => {
            const image = new Image();
            image.src = `data:image/svg+xml;base64,${bytes}`;
            // Attach so image animation participates in the rendering timeline.
            document.body.append(image);
            await image.decode();
            return image;
          };
          const images = await Promise.all([
            load(fixture.original), load(fixture.output), load(fixture.repeated),
          ]);
          const sizes = images.map(image => [image.naturalWidth, image.naturalHeight]);
          const canvas = document.createElement('canvas');
          const render = (image, width, height, scale) => {
            canvas.width = width * scale; canvas.height = height * scale;
            const context = canvas.getContext('2d', { willReadFrequently: true });
            context.drawImage(image, 0, 0, canvas.width, canvas.height);
            return context.getImageData(0, 0, canvas.width, canvas.height).data;
          };
          if (fixture.animated) {
            const samples = images.map(() => new Set());
            for (let sample = 0; sample < 16; sample++) {
              await new Promise(requestAnimationFrame);
              images.forEach((image, index) => {
                const [width, height] = sizes[index];
                const pixels = render(image, width, height, 1);
                const center = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4;
                samples[index].add(Array.from(pixels.slice(center, center + 4)).join(','));
              });
              await new Promise(resolve => setTimeout(resolve, 40));
            }
            images.forEach(image => image.remove());
            return { sizes, animatedColors: samples.map(sample => [...sample]) };
          }
          const checks = [];
          for (const scale of [1, 2, 4]) {
            const { width, height } = fixture.viewport;
            const original = render(images[0], width, height, scale);
            for (const [index, rectangle] of [[1, fixture.crop], [2, {
              left: fixture.crop.left + fixture.second.left,
              top: fixture.crop.top + fixture.second.top,
              right: fixture.crop.left + fixture.second.right,
              bottom: fixture.crop.top + fixture.second.bottom,
            }]]) {
              const w = rectangle.right - rectangle.left;
              const h = rectangle.bottom - rectangle.top;
              const actual = render(images[index], w, h, scale);
              let differences = 0, maxError = 0, nontransparent = 0, outsideTolerance = 0;
              const examples = [];
              for (let y = 0; y < h * scale; y++) for (let x = 0; x < w * scale; x++) {
                const offset = (y * w * scale + x) * 4;
                const expected = ((y + rectangle.top * scale) * width * scale + x + rectangle.left * scale) * 4;
                nontransparent += original[expected + 3] > 0 ? 1 : 0;
                for (let c = 0; c < 4; c++) {
                  // Compare premultiplied RGBA: RGB under zero alpha is invisible.
                  const pixel = (data, at, channel) => channel === 3 ? data[at + 3] : Math.round(data[at + channel] * data[at + 3] / 255);
                  const error = Math.abs(pixel(actual, offset, c) - pixel(original, expected, c));
                  if (error) { differences++; if (examples.length < 5) examples.push({ x, y, c, actual: [...actual.slice(offset,offset+4)], expected: [...original.slice(expected,expected+4)] }); }
                  maxError = Math.max(maxError, error);
                  // Curves and filter buffers are re-rasterized by the engine.
                  // Require the same silhouette within one device pixel, with
                  // <=8/255 filter color-rounding difference; solid fixtures
                  // below still require exact pixels.
                  let minimum = 255, maximum = 0;
                  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                    const sx = x + rectangle.left * scale + dx, sy = y + rectangle.top * scale + dy;
                    if (sx < 0 || sy < 0 || sx >= width * scale || sy >= height * scale) continue;
                    const value = pixel(original, (sy * width * scale + sx) * 4, c);
                    minimum = Math.min(minimum, value); maximum = Math.max(maximum, value);
                  }
                  const value = pixel(actual, offset, c);
                  if (value < minimum - 8 || value > maximum + 8) outsideTolerance++;
                }
              }
              checks.push({ scale, index, differences, maxError, nontransparent, outsideTolerance, examples });
            }
          }
          images.forEach(image => image.remove());
          return { sizes, checks };
        }, { fixture });
        assert.deepEqual(result.sizes, [[200, 100], [155, 70], [135, 54]], `${engine.name()} ${fixture.name} crop dimensions`);
        if (fixture.animated) {
          result.animatedColors.forEach((colors, index) => {
            if (colors.length <= 2) failures.push(`${engine.name()} ${fixture.name} image ${index} froze: ${colors}`);
            assert.ok(colors.every(color => color.endsWith(',255')), 'animation became transparent');
          });
        } else {
          for (const check of result.checks) {
            assert.ok(check.nontransparent > 0, `${fixture.name} reference was blank`);
            const curved = ['stretch', 'gradient-mask-filter'].includes(fixture.name.replace(/^smil-/, ''));
            if (curved ? check.outsideTolerance : check.differences) failures.push(`${engine.name()} ${fixture.name} ${JSON.stringify(check)}`);
          }
        }
        console.log(`${engine.name()}: ${fixture.name} ${failures.length === failureCount ? 'PASS' : 'FAIL'} ${fixture.animated ? 'animation after two crops' : 'ROI at 1x, 2x and 4x after two crops'}`);
      }
    } finally { await browser.close(); }
  }
  assert.deepEqual(failures, [], 'SVG crop rendering mismatches');
} finally { rmSync(directory, { recursive: true, force: true }); }

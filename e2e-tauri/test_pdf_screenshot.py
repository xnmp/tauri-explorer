"""Negative controls for the native pixel oracle (not application evidence)."""
import unittest
from PIL import Image, ImageDraw
from pdf_screenshot import measure


class PixelOracleTests(unittest.TestCase):
    def fixture(self, scale=1):
        image = Image.new("RGB", (400 * scale, 300 * scale), "white")
        ImageDraw.Draw(image).rectangle((190 * scale, 140 * scale, 210 * scale - 1, 160 * scale - 1), fill="red")
        display = dict(id=1, x=0, y=0, width=400, height=300, pixelWidth=image.width, pixelHeight=image.height)
        viewport = dict(x=100, y=50, width=200, height=200)
        return image, display, viewport

    def test_retina_and_regular_pixels_have_same_native_center(self):
        for scale in (1, 2):
            result = measure(*self.fixture(scale), (255, 0, 0))
            self.assertEqual((result["cx"], result["cy"], result["width"]), (200, 150, 20))
            self.assertEqual(result["pixels"], 400 * scale * scale)

    def test_wrong_page_blank_canvas_and_off_viewport_color_fail(self):
        image, display, viewport = self.fixture()
        for candidate, region, color in (
            (image, viewport, (153, 0, 204)),
            (Image.new("RGB", image.size, "white"), viewport, (255, 0, 0)),
            (image, dict(x=0, y=0, width=100, height=100), (255, 0, 0)),
        ):
            with self.assertRaisesRegex(ValueError, "landmark"):
                measure(candidate, display, region, color)

    def test_screenshot_crop_cannot_be_mistaken_for_display(self):
        image, display, viewport = self.fixture()
        with self.assertRaisesRegex(ValueError, "full native display"):
            measure(image.crop((0, 0, 300, 200)), display, viewport, (255, 0, 0))

    def test_geometry_outside_display_and_non_finite_geometry_fail(self):
        image, display, viewport = self.fixture()
        for region in (dict(viewport, x=300), dict(viewport, width=0), dict(viewport, x=float("nan"))):
            with self.assertRaises(ValueError):
                measure(image, display, region, (255, 0, 0))

    def test_scattered_color_cannot_qualify_a_solid_landmark(self):
        image, display, viewport = self.fixture()
        ImageDraw.Draw(image).rectangle((110, 60, 113, 63), fill="red")
        with self.assertRaisesRegex(ValueError, "solid landmark"):
            measure(image, display, viewport, (255, 0, 0))

    def antialiased_fixture(self, width, height, color=(153, 0, 204), scale=1):
        image = Image.new("RGB", (400 * scale, 300 * scale), "white")
        left, top = 194.23 * scale, 143.41 * scale
        right, bottom = left + width * scale, top + height * scale
        for y in range(int(top), int(bottom) + 1):
            for x in range(int(left), int(right) + 1):
                covered = max(0, min(x + 1, right) - max(x, left)) * max(0, min(y + 1, bottom) - max(y, top))
                image.putpixel((x, y), tuple(round(255 * (1 - covered) + channel * covered) for channel in color))
        display = dict(id=1, x=-400, y=75, width=400, height=300, pixelWidth=image.width, pixelHeight=image.height)
        viewport = dict(x=-300, y=125, width=200, height=200)
        return image, display, viewport

    def test_fractional_edges_recover_extent_on_regular_and_retina_displays(self):
        for scale in (1, 2):
            for color in ((255, 0, 0), (153, 0, 204), (255, 128, 0)):
                with self.subTest(scale=scale, color=color):
                    result = measure(*self.antialiased_fixture(12.25, 12.25, color, scale), color)
                    # Existing strict-color tolerance classifies nearly full
                    # boundary pixels as solid: at most16/255 per edge plus
                    # RGB quantization, well below the native2px fit gate.
                    self.assertAlmostEqual(result["width"], 12.25, delta=34 / (255 * scale))
                    self.assertAlmostEqual(result["height"], 12.25, delta=34 / (255 * scale))
                    self.assertAlmostEqual(result["cx"], -400 + 194.23 + 12.25 / 2, delta=0.03)
                    self.assertAlmostEqual(result["cy"], 75 + 143.41 + 12.25 / 2, delta=0.03)

    def test_measurement_preserves_rectangular_aspect_and_detects_wrong_size(self):
        result = measure(*self.antialiased_fixture(18.5, 12.25), (153, 0, 204))
        self.assertAlmostEqual(result["width"], 18.5, delta=0.02)
        self.assertAlmostEqual(result["height"], 12.25, delta=0.02)
        self.assertGreater(abs(result["width"] - 12.25), 2)

    def test_disconnected_antialias_noise_and_gray_pixels_do_not_enlarge_landmark(self):
        image, display, viewport = self.antialiased_fixture(12.25, 12.25)
        baseline = measure(image, display, viewport, (153, 0, 204))
        for y in range(143, 155):
            image.putpixel((192, y), (204, 128, 230))
            image.putpixel((207, y), (160, 160, 160))
        result = measure(image, display, viewport, (153, 0, 204))
        self.assertEqual(result, baseline)

    def test_antialiasing_does_not_replace_minimum_solid_presence(self):
        with self.assertRaisesRegex(ValueError, "fewer than 16"):
            measure(*self.antialiased_fixture(4.2, 3.5), (153, 0, 204))

    def test_in_tolerance_solid_tint_does_not_shrink_oversized_square(self):
        for target, tint in (((255, 0, 0), (255, 13, 13)),
                             ((153, 0, 204), (137, 16, 188)),
                             ((255, 128, 0), (239, 112, 16))):
            with self.subTest(target=target):
                image, display, viewport = self.fixture()
                image.paste("white", (0, 0, image.width, image.height))
                ImageDraw.Draw(image).rectangle((150, 100, 233, 183), fill=tint)
                result = measure(image, display, viewport, target)
                self.assertEqual((result["width"], result["height"]), (84, 84))
                self.assertGreater(abs(result["width"] - 80), 2)

    def test_interior_gap_does_not_change_rectangular_extent(self):
        image, display, viewport = self.fixture()
        image.paste("white", (0, 0, image.width, image.height))
        draw = ImageDraw.Draw(image)
        draw.rectangle((180, 130, 214, 159), fill="red")
        draw.rectangle((195, 130, 199, 159), fill="white")
        result = measure(image, display, viewport, (255, 0, 0))
        self.assertEqual((result["width"], result["height"]), (35, 30))
        self.assertGreater(abs(result["width"] - 30), 2)

    def test_sheared_landmark_keeps_global_extent_instead_of_line_width(self):
        image, display, viewport = self.fixture()
        image.paste("white", (0, 0, image.width, image.height))
        draw = ImageDraw.Draw(image)
        for row in range(30):
            start = 180 + row // 5
            draw.line((start, 130 + row, start + 29, 130 + row), fill="red")
        result = measure(image, display, viewport, (255, 0, 0))
        self.assertEqual((result["width"], result["height"]), (35, 30))
        self.assertGreater(abs(result["width"] - 30), 2)


if __name__ == "__main__":
    unittest.main()

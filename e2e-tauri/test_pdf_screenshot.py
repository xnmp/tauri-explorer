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


if __name__ == "__main__":
    unittest.main()

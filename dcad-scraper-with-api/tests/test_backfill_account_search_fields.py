import importlib.util
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "tools" / "backfill_account_search_fields.py"
SPEC = importlib.util.spec_from_file_location("backfill_account_search_fields", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class AccountSearchNormalizationTests(unittest.TestCase):
    def test_normalizes_city_county_annotation(self):
        self.assertEqual(MODULE.normalize_city("GARLAND (DALLAS CO)"), "GARLAND")

    def test_preserves_multiword_city(self):
        self.assertEqual(MODULE.normalize_city("  GRAND   PRAIRIE  "), "GRAND PRAIRIE")

    def test_normalizes_street_whitespace(self):
        self.assertEqual(MODULE.normalize_text("  W  MAIN ST  "), "W MAIN ST")

    def test_uses_five_digit_postal_code(self):
        self.assertEqual(MODULE.normalize_postal_code("750446751"), "75044")

    def test_rejects_blank_postal_code(self):
        self.assertIsNone(MODULE.normalize_postal_code("      "))


if __name__ == "__main__":
    unittest.main()


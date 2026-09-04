import importlib.util
from pathlib import Path
import tempfile
import unittest

from fastapi import HTTPException

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = REPOSITORY_ROOT / "dcad-backend" / "app" / "main.py"
SPEC = importlib.util.spec_from_file_location("legacy_dcad_backend", MODULE_PATH)
LEGACY_BACKEND = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LEGACY_BACKEND)


class LegacyBackendPathSecurityTests(unittest.TestCase):
    def test_resolves_only_a_direct_numeric_account_fixture(self):
        with tempfile.TemporaryDirectory() as directory:
            data_dir = Path(directory) / "data"
            data_dir.mkdir()
            expected = data_dir / "26272500060150000.json"
            expected.write_text("{}", encoding="utf-8")

            resolved = LEGACY_BACKEND._detail_file_path(
                "26272500060150000",
                data_dir,
            )

            self.assertEqual(resolved, expected.resolve())

            missing = LEGACY_BACKEND._detail_file_path(
                "26272500060150001",
                data_dir,
            )
            self.assertIsNone(missing)

    def test_rejects_traversal_absolute_and_encoded_path_inputs(self):
        with tempfile.TemporaryDirectory() as directory:
            data_dir = Path(directory) / "data"
            data_dir.mkdir()
            for account_id in (
                "../outside",
                r"..\outside",
                r"C:\temp\outside",
                "%2e%2e%5coutside",
                "2627250006015000/0",
                "2627250006015000A",
                " 26272500060150000",
                "26272500060150000 ",
            ):
                with self.subTest(account_id=account_id):
                    with self.assertRaisesRegex(ValueError, "invalid_account_id"):
                        LEGACY_BACKEND._detail_file_path(account_id, data_dir)

    def test_rejects_a_valid_named_symlink_that_escapes_the_data_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data_dir = root / "data"
            data_dir.mkdir()
            outside = root / "outside.json"
            outside.write_text("{}", encoding="utf-8")
            link = data_dir / "26272500060150000.json"
            try:
                link.symlink_to(outside)
            except OSError as error:
                self.skipTest(f"symlink unavailable: {error}")

            resolved = LEGACY_BACKEND._detail_file_path("26272500060150000", data_dir)
            self.assertIsNone(resolved)

    def test_endpoint_returns_a_generic_client_error_for_an_invalid_path(self):
        with self.assertRaises(HTTPException) as raised:
            LEGACY_BACKEND.get_detail(r"..\outside")

        self.assertEqual(raised.exception.status_code, 400)
        self.assertEqual(raised.exception.detail, "Invalid account ID")


if __name__ == "__main__":
    unittest.main()

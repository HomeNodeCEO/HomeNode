import importlib.util
import sys
import unittest
from pathlib import Path


MODULE_PATH = (
    Path(__file__).resolve().parents[1]
    / "tools"
    / "backfill_sales_addresses.py"
)
SPEC = importlib.util.spec_from_file_location("backfill_sales_addresses", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class AddressFormattingTests(unittest.TestCase):
    def test_builds_standard_situs_address(self):
        row = {
            "STREET_NUM": " 1909 ",
            "STREET_HALF_NUM": "",
            "FULL_STREET_NAME": "SNOWMASS LN",
            "BLDG_ID": "",
            "UNIT_ID": "",
        }
        self.assertEqual(MODULE.build_situs_address(row), "1909 SNOWMASS LN")

    def test_includes_half_number_building_and_unit(self):
        row = {
            "STREET_NUM": "123",
            "STREET_HALF_NUM": "1/2",
            "FULL_STREET_NAME": "W MAIN ST",
            "BLDG_ID": "B",
            "UNIT_ID": "12",
        }
        self.assertEqual(
            MODULE.build_situs_address(row),
            "123 1/2 W MAIN ST BLDG B UNIT 12",
        )

    def test_does_not_duplicate_existing_unit_label(self):
        row = {
            "STREET_NUM": "500",
            "STREET_HALF_NUM": "",
            "FULL_STREET_NAME": "OAK DR",
            "BLDG_ID": "BLDG 2",
            "UNIT_ID": "#14",
        }
        self.assertEqual(
            MODULE.build_situs_address(row),
            "500 OAK DR BLDG 2 #14",
        )

    def test_requires_street_number_and_name(self):
        self.assertIsNone(
            MODULE.build_situs_address(
                {
                    "STREET_NUM": "",
                    "STREET_HALF_NUM": "",
                    "FULL_STREET_NAME": "MAIN ST",
                    "BLDG_ID": "",
                    "UNIT_ID": "",
                }
            )
        )
        self.assertIsNone(
            MODULE.build_situs_address(
                {
                    "STREET_NUM": "100",
                    "STREET_HALF_NUM": "",
                    "FULL_STREET_NAME": "",
                    "BLDG_ID": "",
                    "UNIT_ID": "",
                }
            )
        )

    def test_builds_typed_record(self):
        record = MODULE.address_record(
            {
                "ACCOUNT_NUM": "26272500060150000",
                "STREET_NUM": "1909",
                "STREET_HALF_NUM": "",
                "FULL_STREET_NAME": "SNOWMASS LN",
                "BLDG_ID": "",
                "UNIT_ID": "",
                "PROPERTY_CITY": "GARLAND",
                "PROPERTY_ZIPCODE": "75044  ",
            }
        )
        self.assertIsNotNone(record)
        self.assertEqual(record.account_id, "26272500060150000")
        self.assertEqual(record.address, "1909 SNOWMASS LN")
        self.assertEqual(record.city, "GARLAND")
        self.assertEqual(record.state, "TX")
        self.assertEqual(record.zip_code, "75044")


if __name__ == "__main__":
    unittest.main()

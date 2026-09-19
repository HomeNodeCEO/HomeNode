from decimal import Decimal
from pathlib import Path
import sys
import unittest
from unittest.mock import MagicMock, patch

from bs4 import BeautifulSoup


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scraper"))

from dcad import upsert  # noqa: E402
from dcad.parse_detail import parse_land_area, parse_land_detail  # noqa: E402


def land_page(area, state_code="SFR - VACANT LOTS/TRACTS"):
    return BeautifulSoup(f"""
        <table id="Land1_dgLand">
          <tr><th>Number</th><th>State Code</th><th>Zoning</th><th>Frontage</th>
            <th>Depth</th><th>Area</th><th>Pricing Method</th><th>Unit Price</th>
            <th>Market Adjustment</th><th>Adjusted Price</th><th>Ag Land</th></tr>
          <tr><td>1</td><td>{state_code}</td><td>RES</td><td>65</td><td>125</td>
            <td>{area}</td><td>FLAT PRICE</td><td>100</td><td>100%</td>
            <td>100</td><td>NONE</td></tr>
        </table>
    """, "html.parser")


class LandAreaParsingTests(unittest.TestCase):
    def test_acre_cell_preserves_source_units_and_converts_to_square_feet(self):
        row = parse_land_detail(land_page("<span>1.0000</span><span>ACRE</span>"))[0]
        self.assertEqual(row["area_raw"], "1.0000 ACRE")
        self.assertEqual(row["area_value"], Decimal("1.0000"))
        self.assertEqual(row["area_unit"], "ACRE")
        self.assertEqual(row["area_sqft"], Decimal("43560"))

    def test_fractional_acres_preserve_decimal_precision(self):
        self.assertEqual(parse_land_area("0.1234 ACRES")["area_sqft"], Decimal("5375.3040"))

    def test_explicit_square_feet_keep_existing_value(self):
        for source in ("8,125 SQUARE FEET", "8125 sqft", "8125 SQ. FT.", "8125 SF"):
            with self.subTest(source=source):
                self.assertEqual(parse_land_area(source)["area_sqft"], Decimal("8125"))

    def test_literal_zero_area_is_not_replaced_by_frontage_times_depth(self):
        row = parse_land_detail(land_page("0.0000 SQUARE FEET", "SFR - RESIDENCE"))[0]
        self.assertEqual(row["frontage_ft"], Decimal("65"))
        self.assertEqual(row["depth_ft"], Decimal("125"))
        self.assertEqual(row["area_sqft"], Decimal("0.0000"))
        self.assertEqual(row["area_raw"], "0.0000 SQUARE FEET")

    def test_unknown_or_absent_units_are_not_assumed_to_mean_square_feet(self):
        for source in ("1.0000 HECTARE", "1.0000", "", "N/A", "--", "-1 ACRE", "NaN ACRE"):
            with self.subTest(source=source):
                self.assertIsNone(parse_land_area(source)["area_sqft"])
        unknown = parse_land_area("1.0000 HECTARE")
        self.assertEqual(unknown["area_value"], Decimal("1.0000"))
        self.assertEqual(unknown["area_unit"], "HECTARE")

    def test_upsert_uses_converted_area_without_reinterpreting_original_units(self):
        land = parse_land_detail(land_page("1.0000 ACRE"))
        session = MagicMock()
        with patch.object(upsert, "_SCHEMA", "core"), \
             patch.object(upsert, "get_engine", return_value=object()), \
             patch.object(upsert, "get_session", return_value=session):
            upsert.upsert_parsed("12345678901234567", {"tax_year": 2026, "land_detail": land}, {})
        writes = [call for call in session.__enter__.return_value.execute.call_args_list
                  if "INSERT INTO core.land_detail" in str(call.args[0])]
        self.assertEqual(len(writes), 1)
        self.assertEqual(writes[0].args[1]["area_sqft"], Decimal("43560"))


if __name__ == "__main__":
    unittest.main()

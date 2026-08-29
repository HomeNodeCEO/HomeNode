import sys
import unittest
from pathlib import Path


SCRAPER_PATH = Path(__file__).resolve().parents[1] / "scraper"
sys.path.insert(0, str(SCRAPER_PATH))

from dcad.field_completeness import (  # noqa: E402
    assess_field_completeness,
    repair_request_fields,
)


def complete_row(**overrides):
    row = {
        "address": "1402 AARON PL",
        "tax_year": 2026,
        "market_value": 250_000,
        "land_value": 50_000,
        "land_area": 7_500,
        "improvement_value": 200_000,
        "owner_name": "LAM DUNG LY",
        "mailing_address": "1402 AARON PL",
        "ownership_percentage": 100,
        "state_codes": "SFR - RESIDENCE",
        "deed_transfer": "2020-02-24",
        "has_primary_improvement": True,
        "building_class": "14",
        "gla": 1_331,
        "explicit_vacant_state_code": False,
    }
    row.update(overrides)
    return row


class FieldCompletenessTests(unittest.TestCase):
    def test_complete_improved_property_does_not_need_repair(self):
        result = assess_field_completeness(complete_row())
        self.assertEqual(result.property_classification, "improved")
        self.assertEqual(result.missing_fields, ())
        self.assertFalse(result.repair_required)

    def test_incomplete_improved_property_is_queued(self):
        result = assess_field_completeness(
            complete_row(owner_name=None, building_class=None, gla=None)
        )
        self.assertEqual(result.property_classification, "improved")
        self.assertEqual(
            result.missing_fields,
            ("owner_name", "building_class", "gla"),
        )
        self.assertTrue(result.repair_required)

    def test_state_code_vacant_property_does_not_require_improvement_fields(self):
        result = assess_field_completeness(
            complete_row(
                state_codes="SFR - Vacant Lots/Tracts",
                explicit_vacant_state_code=True,
                has_primary_improvement=False,
                improvement_value=0,
                land_value=100_000,
                market_value=100_000,
                building_class=None,
                gla=None,
            )
        )
        self.assertEqual(result.property_classification, "vacant")
        self.assertEqual(result.vacant_reason, "state_code")
        self.assertFalse(result.repair_required)
        self.assertNotIn("building_class", result.missing_fields)
        self.assertNotIn("gla", result.missing_fields)

    def test_equal_land_and_market_without_main_improvement_is_vacant(self):
        result = assess_field_completeness(
            complete_row(
                state_codes="COMMERCIAL",
                explicit_vacant_state_code=False,
                has_primary_improvement=False,
                improvement_value=None,
                land_value=175_000,
                market_value=175_000,
                building_class=None,
                gla=None,
            )
        )
        self.assertEqual(result.property_classification, "vacant")
        self.assertEqual(
            result.vacant_reason,
            "land_equals_market_without_main_improvement",
        )
        self.assertFalse(result.repair_required)

    def test_unknown_property_is_audited_but_not_automatically_queued(self):
        result = assess_field_completeness(
            complete_row(
                has_primary_improvement=False,
                improvement_value=None,
                land_value=None,
                market_value=None,
                building_class=None,
                gla=None,
            )
        )
        self.assertEqual(result.property_classification, "indeterminate")
        self.assertFalse(result.repair_required)
        self.assertIn("market_value", result.missing_fields)

    def test_detailed_missing_fields_map_to_existing_worker_lanes(self):
        self.assertEqual(
            repair_request_fields(
                ("owner_name", "land_area", "building_class", "deed_transfer")
            ),
            ("owner", "land", "gla"),
        )

    def test_general_detail_omission_uses_complete_detail_lane(self):
        self.assertEqual(repair_request_fields(("deed_transfer",)), ("gla",))


if __name__ == "__main__":
    unittest.main()

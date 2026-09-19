from decimal import Decimal
from pathlib import Path
import sys
import unittest


SCRAPER_PATH = Path(__file__).resolve().parents[1] / "scraper"
sys.path.insert(0, str(SCRAPER_PATH))

from dcad.field_completeness import (  # noqa: E402
    COMMON_REQUIRED_FIELDS,
    IMPROVED_REQUIRED_FIELDS,
    PRIMARY_STRUCTURE_FIELDS,
    classify_property,
    parsed_verification_row,
    primary_structure_present,
    primary_structure_sql,
    verification_not_applicable,
    verification_presence,
)


def synthetic_detail():
    return {
        "tax_year": 2026,
        "property_location": {"address": "100 EXAMPLE WAY"},
        "owner": {
            "owner_name": "SYNTHETIC OWNER A / SYNTHETIC OWNER B",
            "mailing_address": "200 EXAMPLE AVENUE, SAMPLE CITY, TX 75000",
            "multi_owner": [
                {"owner_name": "SYNTHETIC OWNER A", "ownership_pct": "40%"},
                {"owner_name": "SYNTHETIC OWNER B", "ownership_pct": "60%"},
            ],
        },
        "value_summary": {
            "certified_year": 2026,
            "market_value": "$250,000",
            "land_value": "$50,000",
            "improvement_value": "$200,000",
        },
        "land_detail": [
            {"state_code": "SFR - RESIDENCE", "area_sqft": "7,500"},
            {"state_code": "SFR - RESIDENCE", "area_sqft": "500"},
        ],
        "primary_improvements": {
            "building_class": "14",
            "living_area_sqft": "1,500",
        },
        "legal_description": {"deed_transfer_date": "2024-01-15"},
    }


class ParsedVerificationRowTests(unittest.TestCase):
    def test_healthy_source_fields_are_flattened_without_losing_detail(self):
        row = parsed_verification_row(synthetic_detail())
        self.assertEqual(row["address"], "100 EXAMPLE WAY")
        self.assertEqual(row["tax_year"], 2026)
        self.assertEqual(row["owner_name"], "SYNTHETIC OWNER A / SYNTHETIC OWNER B")
        self.assertEqual(
            row["mailing_address"], "200 EXAMPLE AVENUE, SAMPLE CITY, TX 75000"
        )
        self.assertEqual(row["ownership_percentage"], Decimal("100"))
        self.assertEqual(row["land_area"], Decimal("7500"))
        self.assertEqual(row["state_codes"], ["SFR - RESIDENCE", "SFR - RESIDENCE"])
        self.assertEqual(row["building_class"], "14")
        self.assertEqual(row["gla"], "1,500")
        self.assertEqual(row["market_value"], "$250,000")
        self.assertEqual(row["land_value"], "$50,000")
        self.assertEqual(row["improvement_value"], "$200,000")
        self.assertEqual(row["deed_transfer"], "2024-01-15")
        self.assertTrue(row["has_land_details"])
        self.assertTrue(row["has_primary_improvement"])
        presence = verification_presence(row)
        for field in COMMON_REQUIRED_FIELDS + IMPROVED_REQUIRED_FIELDS:
            with self.subTest(field=field):
                self.assertTrue(presence[f"missing_{field}"])

    def test_alternative_source_address_and_primary_area_are_supported(self):
        detail = synthetic_detail()
        detail["property_location"] = {"subject_address": "300 EXAMPLE COURT"}
        detail["main_improvement"] = {
            "building_class": "12",
            "living_area_sqft": "N/A",
            "total_living_area": 1800,
            "total_area_sqft": 2200,
        }
        del detail["primary_improvements"]
        row = parsed_verification_row(detail)
        self.assertEqual(row["address"], "300 EXAMPLE COURT")
        self.assertEqual(row["building_class"], "12")
        self.assertEqual(row["gla"], 1800)

    def test_empty_source_does_not_manufacture_values_or_tax_year(self):
        row = parsed_verification_row({})
        presence = verification_presence(row)
        for field in COMMON_REQUIRED_FIELDS + IMPROVED_REQUIRED_FIELDS:
            with self.subTest(field=field):
                self.assertFalse(presence[f"missing_{field}"])
        self.assertFalse(presence["owner"])
        self.assertFalse(presence["land"])
        self.assertFalse(presence["gla"])

    def test_missing_owner_collection_does_not_imply_full_ownership(self):
        for parties in (None, [], [{}]):
            with self.subTest(parties=parties):
                detail = synthetic_detail()
                detail["owner"]["multi_owner"] = parties
                row = parsed_verification_row(detail)
                self.assertIsNone(row["ownership_percentage"])
                presence = verification_presence(row)
                self.assertTrue(presence["owner"])
                self.assertFalse(presence["missing_ownership_percentage"])

    def test_one_missing_percentage_invalidates_the_collection_total(self):
        for missing in (None, "", "N/A", "NaN"):
            with self.subTest(missing=missing):
                detail = synthetic_detail()
                detail["owner"]["multi_owner"][1]["ownership_pct"] = missing
                row = parsed_verification_row(detail)
                self.assertIsNone(row["ownership_percentage"])
                self.assertFalse(verification_presence(row)["missing_ownership_percentage"])

    def test_fractional_percentages_are_summed_without_inference(self):
        detail = synthetic_detail()
        detail["owner"]["multi_owner"] = [
            {"owner_name": "SYNTHETIC OWNER A", "ownership_pct": "33.33%"},
            {"owner_name": "SYNTHETIC OWNER B", "ownership_pct": "66.67%"},
        ]
        self.assertEqual(
            parsed_verification_row(detail)["ownership_percentage"], Decimal("100.00")
        )

    def test_certified_year_does_not_fill_missing_parsed_tax_year(self):
        detail = synthetic_detail()
        detail.pop("tax_year")
        row = parsed_verification_row(detail)
        self.assertIsNone(row["tax_year"])
        self.assertFalse(verification_presence(row)["missing_tax_year"])


class VerificationPresenceTests(unittest.TestCase):
    def test_owner_lane_does_not_satisfy_missing_mailing_or_percentages(self):
        row = parsed_verification_row(synthetic_detail())
        row.update(mailing_address=None, ownership_percentage=None)
        presence = verification_presence(row)
        self.assertTrue(presence["owner"])
        self.assertTrue(presence["missing_owner_name"])
        self.assertFalse(presence["missing_mailing_address"])
        self.assertFalse(presence["missing_ownership_percentage"])

    def test_gla_lane_does_not_satisfy_missing_building_class_or_deed(self):
        row = parsed_verification_row(synthetic_detail())
        row.update(building_class=None, deed_transfer=None)
        presence = verification_presence(row)
        self.assertTrue(presence["gla"])
        self.assertTrue(presence["missing_gla"])
        self.assertFalse(presence["missing_building_class"])
        self.assertFalse(presence["missing_deed_transfer"])

    def test_land_lane_does_not_satisfy_missing_area_code_or_value(self):
        row = parsed_verification_row(synthetic_detail())
        row.update(land_area=None, state_codes=[], land_value=None)
        presence = verification_presence(row)
        self.assertTrue(presence["land"])
        self.assertFalse(presence["missing_land_area"])
        self.assertFalse(presence["missing_state_code"])
        self.assertFalse(presence["missing_land_value"])

    def test_placeholder_and_truncated_owner_names_remain_missing(self):
        for owner_name in (None, "", "   ", "N/A", "n/a", "NONE", "--", "SAMPLE OWNER & "):
            with self.subTest(owner_name=owner_name):
                row = parsed_verification_row(synthetic_detail())
                row["owner_name"] = owner_name
                presence = verification_presence(row)
                self.assertFalse(presence["owner"])
                self.assertFalse(presence["missing_owner_name"])

    def test_complete_joint_owner_name_is_not_rejected_for_an_internal_ampersand(self):
        row = parsed_verification_row(synthetic_detail())
        row["owner_name"] = "SYNTHETIC OWNER A & SYNTHETIC OWNER B"
        self.assertTrue(verification_presence(row)["missing_owner_name"])

    def test_text_placeholders_do_not_satisfy_exact_fields(self):
        for field in ("address", "mailing_address", "building_class", "deed_transfer"):
            for value in (None, "   ", "N/A", "--"):
                with self.subTest(field=field, value=value):
                    row = parsed_verification_row(synthetic_detail())
                    row[field] = value
                    self.assertFalse(verification_presence(row)[f"missing_{field}"])

    def test_vacant_state_code_only_satisfies_the_legacy_gla_lane(self):
        row = parsed_verification_row(synthetic_detail())
        row.update(
            state_codes=["SFR - Vacant Lots/Tracts"],
            has_primary_improvement=False,
            gla=None,
            building_class=None,
            improvement_value=0,
        )
        presence = verification_presence(row)
        self.assertTrue(presence["gla"])
        self.assertFalse(presence["missing_gla"])
        self.assertFalse(presence["missing_building_class"])

    def test_equal_land_and_market_only_satisfy_the_legacy_gla_lane(self):
        row = parsed_verification_row(synthetic_detail())
        row.update(
            state_codes=["RESIDENTIAL"],
            has_primary_improvement=False,
            gla=None,
            building_class=None,
            land_value=100000,
            market_value=100000,
            improvement_value=0,
        )
        presence = verification_presence(row)
        self.assertTrue(presence["gla"])
        self.assertFalse(presence["missing_gla"])

    def test_mixed_vacant_and_improved_codes_do_not_satisfy_missing_gla(self):
        row = parsed_verification_row(synthetic_detail())
        row.update(state_codes=["SFR - Vacant Lots/Tracts", "SFR - RESIDENCE"], gla=None)
        presence = verification_presence(row)
        self.assertFalse(presence["gla"])
        self.assertFalse(presence["missing_gla"])

    def test_equal_values_do_not_override_mixed_codes_without_a_primary_improvement(self):
        row = parsed_verification_row(synthetic_detail())
        row.update(
            state_codes=["SFR - Vacant Lots/Tracts", "SFR - RESIDENCE"],
            has_primary_improvement=False,
            gla=None,
            land_value=100000,
            market_value=100000,
            improvement_value=0,
        )
        presence = verification_presence(row)
        self.assertFalse(presence["gla"])
        self.assertFalse(presence["missing_gla"])

    def test_equal_values_do_not_override_positive_improvement_value(self):
        row = parsed_verification_row(synthetic_detail())
        row.update(
            state_codes=["RESIDENTIAL"],
            has_primary_improvement=False,
            gla=None,
            land_value=100000,
            market_value=100000,
            improvement_value=25000,
        )
        presence = verification_presence(row)
        self.assertFalse(presence["gla"])
        self.assertFalse(presence["missing_gla"])

    def test_indeterminate_property_does_not_satisfy_missing_gla(self):
        row = parsed_verification_row(synthetic_detail())
        row.update(
            state_codes=[], has_primary_improvement=False, gla=None,
            land_value=None, market_value=None, improvement_value=None,
        )
        presence = verification_presence(row)
        self.assertFalse(presence["gla"])
        self.assertFalse(presence["missing_gla"])

    def test_nan_and_infinite_numeric_values_remain_missing(self):
        numeric_fields = (
            "tax_year", "market_value", "land_value", "land_area",
            "ownership_percentage", "improvement_value", "gla",
        )
        for value in (float("nan"), Decimal("NaN"), "NaN", Decimal("Infinity")):
            for field in numeric_fields:
                with self.subTest(field=field, value=value):
                    row = parsed_verification_row(synthetic_detail())
                    row[field] = value
                    self.assertFalse(verification_presence(row)[f"missing_{field}"])

    def test_zero_area_does_not_count_as_gla_or_land_area(self):
        row = parsed_verification_row(synthetic_detail())
        row.update(gla=0, land_area=0)
        presence = verification_presence(row)
        self.assertFalse(presence["gla"])
        self.assertFalse(presence["missing_gla"])
        self.assertFalse(presence["missing_land_area"])

    def test_unsupported_field_has_no_satisfied_presence(self):
        presence = verification_presence(parsed_verification_row(synthetic_detail()))
        self.assertFalse(presence.get("missing_unsupported_field", False))
        self.assertFalse(presence.get("unsupported_field", False))


class VacantApplicabilityTests(unittest.TestCase):
    def vacant_row(self, **changes):
        row = parsed_verification_row(synthetic_detail())
        row.update(state_codes=["SFR - VACANT LOTS/TRACTS"], has_primary_improvement=False,
                   improvement_value=0, market_value=100, land_value=100,
                   building_class=None, gla=None)
        row.update(changes)
        return row

    def test_vacant_waives_only_improvement_obligations_not_claiming_field_presence(self):
        row = self.vacant_row()
        self.assertEqual(verification_not_applicable(row), frozenset({
            "gla", "missing_gla", "building_class", "missing_building_class",
            "improvement_value", "missing_improvement_value",
        }))
        self.assertFalse(verification_presence(row)["missing_building_class"])
        self.assertFalse(verification_presence(row)["missing_gla"])

    def test_equal_positive_values_without_main_improvement_support_vacancy(self):
        row = self.vacant_row(state_codes=["RESIDENTIAL"], improvement_value=None)
        self.assertIn("missing_building_class", verification_not_applicable(row))

    def test_empty_main_parser_defaults_do_not_establish_a_structure(self):
        from bs4 import BeautifulSoup
        from dcad.parse_detail import parse_main_improvement
        detail = synthetic_detail()
        primary = parse_main_improvement(BeautifulSoup("<html><body></body></html>", "html.parser"))
        detail["primary_improvements"] = primary
        detail["land_detail"] = [{"state_code": "RESIDENTIAL", "area_sqft": 7500}]
        detail["value_summary"].update(market_value=100, land_value=100, improvement_value=0)
        row = parsed_verification_row(detail)
        self.assertFalse(row["has_primary_improvement"])
        self.assertEqual(classify_property(row), ("vacant", "land_equals_market_without_main_improvement"))
        self.assertIn("missing_building_class", verification_not_applicable(row))

    def test_mixed_state_codes_and_coarse_vacant_flag_do_not_waive_fields(self):
        for codes in (["SFR - VACANT LOTS/TRACTS", "SFR - RESIDENCE"],
                      "SFR - VACANT LOTS/TRACTS | SFR - RESIDENCE"):
            row = self.vacant_row(state_codes=codes, explicit_vacant_state_code=True)
            self.assertEqual(classify_property(row)[0], "indeterminate")
            self.assertFalse(verification_not_applicable(row))

    def test_main_or_positive_improvement_evidence_overrides_vacant_code(self):
        for changes in ({"has_primary_improvement": True}, {"improvement_value": 1},
                        {"building_class": "14"}, {"gla": 100}):
            with self.subTest(changes=changes):
                row = self.vacant_row(**changes)
                self.assertEqual(classify_property(row)[0], "improved")
                self.assertFalse(verification_not_applicable(row))

    def test_zero_or_unknown_values_do_not_prove_value_only_vacancy(self):
        for value in (0, None, "N/A", "NaN", -1):
            with self.subTest(value=value):
                row = self.vacant_row(state_codes=[], market_value=value, land_value=value)
                self.assertEqual(classify_property(row)[0], "indeterminate")
                self.assertFalse(verification_not_applicable(row))

    def test_actual_structure_only_fields_prevent_false_vacancy(self):
        structures = {
            "foundation": "SLAB", "roof_type": "GABLE", "roof_material": "COMPOSITION",
            "exterior_material": "BRICK", "baths_full": 2, "baths_half": 1,
            "kitchens": 1, "heating": "CENTRAL", "air_conditioning": "CENTRAL",
            "wetbars": 1, "fireplaces": 1,
        }
        for field, value in structures.items():
            for codes in (["RESIDENTIAL"], ["SFR - VACANT LOTS/TRACTS"],
                          ["SFR - VACANT LOTS/TRACTS", "SFR - RESIDENCE"]):
                with self.subTest(field=field, codes=codes):
                    detail = synthetic_detail()
                    detail["primary_improvements"] = {field: value}
                    detail["value_summary"].update(market_value=100, land_value=100, improvement_value=0)
                    detail["land_detail"] = [{"state_code": code, "area_sqft": 500} for code in codes]
                    row = parsed_verification_row(detail)
                    self.assertTrue(row["has_primary_improvement"])
                    self.assertEqual(classify_property(row)[0], "improved")
                    self.assertFalse(verification_not_applicable(row))
                    self.assertFalse(verification_presence(row)["missing_gla"])
                    self.assertFalse(verification_presence(row)["missing_building_class"])

    def test_structural_nullish_values_and_amenity_defaults_are_not_buildings(self):
        for value in (None, "", "  N/A ", "UNKNOWN", "NONE", "--", "NaN", False):
            with self.subTest(value=value):
                primary = dict.fromkeys(PRIMARY_STRUCTURE_FIELDS, value)
                primary.update(basement="NONE", pool="NONE", spa="NONE", sauna="NONE",
                               sprinkler="NONE", deck="NONE")
                self.assertFalse(primary_structure_present(primary))
        self.assertTrue(primary_structure_present({"baths_full": 0}))

    def test_normalized_sql_and_raw_predicate_share_fields_and_nullish_rules(self):
        sql = primary_structure_sql("improvement")
        for field in PRIMARY_STRUCTURE_FIELDS:
            self.assertIn(f"improvement.{field}::text", sql)
        self.assertIn("'N/A'", sql)
        self.assertIn("'UNKNOWN'", sql)
        self.assertIn("upper(btrim(COALESCE(", sql)
        self.assertNotIn("improvement.pool", sql)
        with self.assertRaisesRegex(ValueError, "Invalid primary-improvement table alias"):
            primary_structure_sql("p); DROP TABLE accounts; --")


if __name__ == "__main__":
    unittest.main()

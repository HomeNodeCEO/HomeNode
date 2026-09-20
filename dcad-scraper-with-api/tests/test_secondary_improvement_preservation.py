"""Whole-group validation must finish before any destructive secondary write."""
from copy import deepcopy
from decimal import Decimal
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scraper"))
from dcad import upsert
import test_primary_cleanup as cleanup_fixtures


def row(number="1", **changes):
    return {"imp_num": number, "imp_type": "DETACHED GARAGE", "imp_desc": None,
            "year_built": 1995, "construction": "WOOD", "floor_type": "CONCRETE",
            "ext_wall": "BRICK", "num_stories": Decimal("1"), "area_size": Decimal("440"),
            "value": "$5,500", "depreciation": "10%", **changes}


def payload(status="present", rows=None):
    return {"improvement_sections": {"main": "present", "additional": status},
            "secondary_improvements": [row()] if rows is None else rows,
            "property_location": {"address": "100 SYNTHETIC TEST RD"}}


def secondary_calls(calls):
    return [(sql, params) for sql, params in calls if "secondary_improvements" in sql]


class SecondaryImprovementPreservationTests(unittest.TestCase):
    def calls(self, detail):
        return cleanup_fixtures.CleanupPersistenceTests().capture_upsert(detail)

    def assert_preserved(self, detail):
        original = deepcopy(detail)
        actual = self.calls(detail)
        self.assertEqual(secondary_calls(actual), [], "No DELETE or partial INSERT is permitted")
        with patch.object(upsert, "_secondary_replacement_is_verified", return_value=False):
            baseline = self.calls(detail)
        self.assertEqual(actual, baseline, "Unrelated writes are unchanged")
        self.assertEqual(detail, original, "Fresh source evidence must not be rewritten")

    def test_unresolved_unknown_and_malformed_status_preserve_all_existing_rows(self):
        for status in ("unresolved", "unknown", None, "", "PRESENT", [], {}):
            for rows in ([], [row()]):
                with self.subTest(status=status, rows=rows):
                    self.assert_preserved(payload(status, rows))
        for sections in (None, [], {}, "present", {"main": "present"}):
            detail = payload()
            detail["improvement_sections"] = sections
            self.assert_preserved(detail)

    def test_present_but_empty_table_is_not_source_confirmed_absence(self):
        self.assert_preserved(payload("present", []))

    def test_explicit_absence_with_empty_list_performs_original_scoped_clear(self):
        detail = payload("explicitly_absent", [])
        calls = self.calls(detail)
        secondary = secondary_calls(calls)
        self.assertEqual(secondary, [("DELETE FROM core.secondary_improvements WHERE account_id = :account_id",
                                     {"account_id": "12345678901234567"})])
        legacy = {key: value for key, value in detail.items() if key != "improvement_sections"}
        self.assertEqual(calls, self.calls(legacy))

    def test_explicit_absence_with_rows_or_conflicting_alias_preserves(self):
        self.assert_preserved(payload("explicitly_absent", [row()]))
        for alias in ([row()], {}, None, ""):
            detail = payload("explicitly_absent", [])
            detail["additional_improvements"] = alias
            self.assert_preserved(detail)

    def test_valid_complete_group_retains_exact_original_sql_and_bind_values(self):
        detail = payload(rows=[row(), row("2", year_built=None, area_size="500.75", depreciation=None)])
        detail["additional_improvements"] = deepcopy(detail["secondary_improvements"])
        original = deepcopy(detail)
        legacy = {key: value for key, value in detail.items() if key != "improvement_sections"}
        actual = self.calls(detail)
        self.assertEqual(actual, self.calls(legacy))
        writes = secondary_calls(actual)
        self.assertEqual(len(writes), 3)
        self.assertTrue(writes[0][0].startswith("DELETE"))
        self.assertEqual(writes[1][1]["sec_imp_value"], Decimal("5500"))
        self.assertEqual(writes[1][1]["sec_imp_depreciation"], Decimal("10"))
        self.assertEqual(writes[2][1]["sec_imp_number"], 2)
        self.assertEqual(detail, original)

    def test_invalid_row_at_any_position_blocks_entire_replacement_before_delete(self):
        bad_rows = (None, [], "malformed", {}, row(None), row("N/A"), row("1.5"), row("1%"), row(True),
                    row("0"), row("-1"), row("2147483648"), row("NaN"), row("Infinity"),
                    row("3", imp_type=["GARAGE"]), row("3", area_size={"sqft": 400}),
                    row("3", year_built=True), row("3", value="unknown nonnumeric"),
                    row("3", value=Decimal("NaN")), row("3", tax_obj_id=float("inf")),
                    row("3", year_built=10 ** 100), row("3", area_size=10 ** 100))
        for bad in bad_rows:
            for rows in ([bad, row("2")], [row("2"), bad]):
                with self.subTest(bad=bad, invalid_index=0 if rows[0] is bad else 1):
                    # NaN does not compare equal to itself; test nonmutation by
                    # identity plus write absence for these non-JSON cases.
                    detail = payload(rows=rows)
                    self.assertFalse(upsert._secondary_replacement_is_verified(detail))
                    self.assertEqual(secondary_calls(self.calls(detail)), [])
                    self.assertIs(detail["secondary_improvements"], rows)

    def test_duplicate_normalized_identifiers_preserve_instead_of_partially_replacing(self):
        for duplicate in (1, "1.0", Decimal("1"), "01"):
            self.assert_preserved(payload(rows=[row("1"), row(duplicate)]))

    def test_missing_or_malformed_row_collection_preserves_with_new_metadata(self):
        for value in (None, {}, "", "rows", (row(),)):
            detail = payload()
            detail["secondary_improvements"] = value
            self.assert_preserved(detail)
        detail = payload()
        del detail["secondary_improvements"]
        self.assert_preserved(detail)

    def test_legacy_payloads_retain_prior_clear_and_replacement_semantics(self):
        for detail, expected_writes in (({}, 1), ({"secondary_improvements": []}, 1),
                                        ({"secondary_improvements": [row()]}, 2),
                                        ({"secondary_improvements": [{"imp_num": None}]}, 1)):
            self.assertTrue(upsert._secondary_replacement_is_verified(detail))
            self.assertEqual(len(secondary_calls(self.calls(detail))), expected_writes)

    def test_new_optional_nullish_numeric_cells_remain_supported(self):
        for value in (None, "", "N/A", "NA", "NONE", "NULL", "UNASSIGNED"):
            detail = payload(rows=[row(year_built=value, num_stories=value,
                                       area_size=value, value=value, depreciation=value)])
            self.assertTrue(upsert._secondary_replacement_is_verified(detail))
            self.assertEqual(len(secondary_calls(self.calls(detail))), 2)


if __name__ == "__main__":
    unittest.main()

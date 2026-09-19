from copy import deepcopy
from decimal import Decimal
from pathlib import Path
import re
import sys
import unittest
from unittest.mock import MagicMock, patch

from sqlalchemy import text
from sqlalchemy.dialects import postgresql

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scraper"))

from dcad import upsert  # noqa: E402
from dcad.field_completeness import (  # noqa: E402
    PRIMARY_NUMERIC_STRUCTURE_FIELDS, PRIMARY_STORY_FIELDS, PRIMARY_STRUCTURE_FIELDS,
    STRUCTURE_POSITIVE_PATTERN, STRUCTURE_ZERO_PATTERN, classify_property,
    primary_structure_present, primary_structure_sql,
)
from dcad.primary_cleanup import (  # noqa: E402
    EXTRA_AMENITY_FIELDS, vacant_zero_cleanup_sql, vacant_zero_cleanup_year,
)
from primary_cleanup_postgres_fixtures import build_sql, fixture_cases  # noqa: E402


def vacant_detail():
    return {
        "tax_year": 2026,
        "primary_improvements": {},
        "main_improvement": {},
        "secondary_improvements": [],
        "land_detail": [{"state_code": "SFR - VACANT LOTS/TRACTS", "area_sqft": 43560}],
        "value_summary": {"certified_year": 2026, "revaluation_year": 2025,
                          "market_value": 100, "land_value": 100, "improvement_value": 0},
    }


class StructureNumericEvidenceTests(unittest.TestCase):
    def test_numeric_and_numeric_text_placeholders_never_prove_structure(self):
        for field in PRIMARY_NUMERIC_STRUCTURE_FIELDS | PRIMARY_STORY_FIELDS:
            for value in (0, 0.0, Decimal("0.0000"), "0", " +00.000e-3 ", "-0",
                          -1, Decimal("-0.01"), "-1.0", None, False, "NaN",
                          float("nan"), float("inf"), float("-inf"), "Infinity",
                          "+Infinity", Decimal("-Infinity"), Decimal("sNaN")):
                with self.subTest(field=field, value=value):
                    self.assertFalse(primary_structure_present({field: value}))

    def test_finite_positive_numbers_and_real_text_still_prove_structure(self):
        for field in PRIMARY_NUMERIC_STRUCTURE_FIELDS | PRIMARY_STORY_FIELDS:
            for value in (1, Decimal("0.01"), " +1.0 ", "1e-9"):
                with self.subTest(field=field, value=value):
                    self.assertTrue(primary_structure_present({field: value}))
        for field, value in (("foundation", "SLAB"), ("roof_type", "GABLE"),
                             ("stories_raw", "ONE STORY"), ("building_class", "14")):
            self.assertTrue(primary_structure_present({field: value}))
        # Do not erase ambiguous identifiers by applying numeric rules to text.
        self.assertTrue(primary_structure_present({"building_class": "0"}))

    def test_sql_uses_same_positive_zero_grammar_without_numeric_casts(self):
        sql = primary_structure_sql("p")
        for field in PRIMARY_NUMERIC_STRUCTURE_FIELDS:
            value = f"btrim(COALESCE(p.{field}::text, ''))"
            self.assertIn(f"{value} ~ '{STRUCTURE_POSITIVE_PATTERN}'", sql)
            self.assertIn(f"{value} !~ '{STRUCTURE_ZERO_PATTERN}'", sql)
        self.assertNotIn("::numeric", sql)
        for value in ("0", "0.00", "-0", "0e200", "0.01", "+1", "-1", "NaN", "Infinity"):
            # The generated SQL embeds these exact regexes, not a second numeric
            # normalization with different zero/negative/non-finite behavior.
            sql_predicate = bool(re.fullmatch(STRUCTURE_POSITIVE_PATTERN, value)) and not bool(
                re.fullmatch(STRUCTURE_ZERO_PATTERN, value))
            self.assertEqual(primary_structure_present({"baths_full": value}), sql_predicate)

    def test_legacy_positive_age_stays_improved_until_source_backed_cleanup(self):
        row = {field: 0 for field in PRIMARY_NUMERIC_STRUCTURE_FIELDS}
        row.update(actual_age=2025, state_codes=["SFR - VACANT LOTS/TRACTS"],
                   improvement_value=0, land_value=100, market_value=100)
        self.assertEqual(classify_property(row)[0], "improved")
        # Shared presence checks do not normalize or mutate the legacy row.
        self.assertEqual(row["actual_age"], 2025)


class FreshVacantCleanupGateTests(unittest.TestCase):
    def test_requires_all_fresh_source_corroboration_and_does_not_mutate_it(self):
        detail = vacant_detail()
        original = deepcopy(detail)
        self.assertEqual(vacant_zero_cleanup_year(detail), 2025)
        self.assertEqual(detail, original)

    def test_no_cleanup_for_missing_partial_or_nonempty_main(self):
        for value in (None, [], {"year_built": 0}, {"foundation": "SLAB"}, {"baths_full": 1}):
            detail = vacant_detail()
            detail["primary_improvements"] = value
            self.assertIsNone(vacant_zero_cleanup_year(detail))
        detail = vacant_detail()
        del detail["primary_improvements"], detail["main_improvement"]
        self.assertIsNone(vacant_zero_cleanup_year(detail))
        for alias in ("primary", "main_improvements"):
            detail = vacant_detail()
            detail[alias] = {"roof_type": "GABLE"}
            self.assertIsNone(vacant_zero_cleanup_year(detail))

    def test_missing_mixed_and_value_only_vacancy_do_not_authorize_cleanup(self):
        for land in (None, [], [{"state_code": None}], [{"state_code": "RESIDENTIAL"}],
                     [{"state_code": "SFR - VACANT"}, {"state_code": "SFR - RESIDENCE"}]):
            detail = vacant_detail()
            detail["land_detail"] = land
            self.assertIsNone(vacant_zero_cleanup_year(detail))

    def test_secondary_improvements_block_cleanup(self):
        for alias in ("secondary_improvements", "additional_improvements"):
            detail = vacant_detail()
            detail[alias] = [{"description": "DETACHED STRUCTURE"}]
            self.assertIsNone(vacant_zero_cleanup_year(detail))

    def test_ambiguous_values_and_source_years_block_cleanup(self):
        changes = (
            {"market_value": 0, "land_value": 0}, {"land_value": 99},
            {"improvement_value": None}, {"improvement_value": 1},
            {"improvement_value": -1}, {"market_value": "NaN"},
            {"revaluation_year": None}, {"revaluation_year": 0},
            {"revaluation_year": 2027}, {"revaluation_year": "2025.5"},
            {"certified_year": 2025}, {"certified_year": "Infinity"},
        )
        for values in changes:
            with self.subTest(values=values):
                detail = vacant_detail()
                detail["value_summary"].update(values)
                self.assertIsNone(vacant_zero_cleanup_year(detail))
        detail = vacant_detail()
        del detail["tax_year"]
        self.assertIsNone(vacant_zero_cleanup_year(detail))

    def test_only_exact_normalized_source_code_authorizes_cleanup(self):
        for code in ("NOT VACANT", "NON-VACANT", "SFR - NOT VACANT LOTS/TRACTS",
                     "SFR - VACANT LOTS/TRACTS IMPROVED", "VACANT", "LOTS/TRACTS"):
            with self.subTest(code=code):
                detail = vacant_detail()
                detail["land_detail"][0]["state_code"] = code
                self.assertIsNone(vacant_zero_cleanup_year(detail))
        detail = vacant_detail()
        detail["land_detail"][0]["state_code"] = "  sfr  -  vacant lots/tracts  "
        self.assertEqual(vacant_zero_cleanup_year(detail), 2025)


class CleanupPersistenceTests(unittest.TestCase):
    def test_postgres_fixtures_are_table_free_and_use_exact_generated_predicates(self):
        sql = build_sql()
        self.assertGreater(len(fixture_cases()), 80)
        self.assertIn(primary_structure_sql("p"), sql)
        self.assertIn(primary_structure_sql("cleaned"), sql)
        self.assertIn("actual_age = 2025", sql)
        self.assertNotRegex(sql, r"\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b")
        self.assertNotIn("core.", sql)
        self.assertNotIn("app.", sql)

    def capture_upsert(self, detail, cleanup_enabled=True):
        session = MagicMock()
        with patch.object(upsert, "_SCHEMA", "core"), \
             patch.object(upsert, "get_engine", return_value=object()), \
             patch.object(upsert, "get_session", return_value=session), \
             patch.object(upsert, "vacant_zero_cleanup_year", wraps=vacant_zero_cleanup_year
                          if cleanup_enabled else lambda _detail: None):
            upsert.upsert_parsed("12345678901234567", detail, {})
        session.__enter__.return_value.commit.assert_called_once_with()
        calls = [(str(call.args[0]), call.args[1])
                 for call in session.__enter__.return_value.execute.call_args_list]
        return calls

    def test_cleanup_adds_only_one_account_scoped_guarded_update(self):
        detail = vacant_detail()
        detail["owner"] = {"owner_name": "SYNTHETIC OWNER", "mailing_address": "100 EXAMPLE RD",
                           "multi_owner": [{"owner_name": "SYNTHETIC OWNER", "ownership_pct": 100}]}
        original = deepcopy(detail)
        baseline = self.capture_upsert(detail, cleanup_enabled=False)
        actual = self.capture_upsert(detail)
        cleanup = [call for call in actual if call[0].startswith("UPDATE core.primary_improvements AS p")]
        self.assertEqual(len(cleanup), 1)
        self.assertEqual(cleanup[0][1], {"account_id": "12345678901234567", "vacant_revaluation_year": 2025})
        # Owner/value/history/land writes are byte-for-byte the same calls. There
        # is no added deletion, source rewrite, queue action, or schema operation.
        self.assertEqual([call for call in actual if call not in cleanup], baseline)
        self.assertEqual(detail, original)
        self.assertFalse(any("INSERT INTO core.primary_improvements" in sql for sql, _ in actual))

    def test_empty_or_ambiguous_main_does_not_insert_a_new_placeholder_row(self):
        for detail in ({}, {"primary_improvements": {}}, {"primary_improvements": {}, "tax_year": 2026}):
            calls = self.capture_upsert(detail)
            self.assertFalse(any("primary_improvements" in sql for sql, _ in calls))

    def test_real_current_primary_retains_normal_upsert_and_no_cleanup(self):
        detail = vacant_detail()
        detail["primary_improvements"] = {"foundation": "SLAB", "year_built": 1999,
                                           "living_area_sqft": 1500, "baths_full": 2}
        calls = self.capture_upsert(detail)
        writes = [(sql, params) for sql, params in calls if "primary_improvements" in sql]
        self.assertEqual(len(writes), 1)
        self.assertIn("INSERT INTO core.primary_improvements", writes[0][0])
        self.assertEqual(writes[0][1]["foundation"], "SLAB")
        self.assertEqual(writes[0][1]["living_area_sqft"], 1500)

    def test_truthy_main_with_only_normalized_absences_does_not_insert(self):
        for primary in ({"foundation": None}, {"foundation": " ", "year_built": "bad"},
                        {"building_class": "N/A", "living_area_sqft": "--"}):
            calls = self.capture_upsert({"primary_improvements": primary})
            self.assertFalse(any("primary_improvements" in sql for sql, _ in calls))

    def test_explicit_zero_or_false_normalized_values_remain_valid_upsert_inputs(self):
        for primary, field, expected in (({"baths_full": 0}, "baths_full", 0),
                                         ({"basement": False}, "basement", False)):
            calls = self.capture_upsert({"primary_improvements": primary})
            writes = [(sql, params) for sql, params in calls if "INSERT INTO core.primary_improvements" in sql]
            self.assertEqual(len(writes), 1)
            self.assertEqual(writes[0][1][field], expected)
            self.assertEqual(set(text(writes[0][0]).compile(dialect=postgresql.dialect()).params),
                             set(writes[0][1]), "Every original INSERT bind is still supplied")

    def test_sql_rechecks_entire_stored_signature_and_preserves_ambiguous_values(self):
        sql = vacant_zero_cleanup_sql("core.primary_improvements")
        compiled = text(sql).compile(dialect=postgresql.dialect())
        self.assertEqual(set(compiled.params), {"account_id", "vacant_revaluation_year"})
        self.assertIn("p.year_built = 0", sql)
        self.assertIn("p.effective_year_built = 0", sql)
        self.assertIn("p.actual_age = :vacant_revaluation_year", sql)
        self.assertIn("p.account_id = :account_id", sql)
        where = sql.split(" WHERE ", 1)[1]
        for field in PRIMARY_NUMERIC_STRUCTURE_FIELDS - {"actual_age"}:
            # Negative, NaN and every nonzero value block, not just values the
            # shared structural-presence predicate considers valid evidence.
            self.assertIn(f"(p.{field} IS NULL OR p.{field} = 0)", where)
        for field in set(PRIMARY_STRUCTURE_FIELDS) - PRIMARY_NUMERIC_STRUCTURE_FIELDS:
            self.assertIn(f"COALESCE(p.{field}::text, '')", where)
        for field in EXTRA_AMENITY_FIELDS:
            self.assertIn(f"COALESCE(p.{field}::text, '')", where)
        self.assertNotIn("'TRUE'", where)
        self.assertIn("actual_age = NULL", sql)
        self.assertNotIn("DELETE", sql)
        self.assertNotIn("owner", sql)
        self.assertNotIn("value_summary", sql)


if __name__ == "__main__":
    unittest.main()

import sys
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import Mock, patch

from sqlalchemy.dialects import postgresql


SCRAPER_ROOT = Path(__file__).resolve().parents[1] / "scraper"
sys.path.insert(0, str(SCRAPER_ROOT))

from dcad import worker  # noqa: E402
from dcad.data_quality import CompletenessAssessment  # noqa: E402
from dcad.field_completeness import parsed_verification_row, primary_structure_sql  # noqa: E402
from test_field_verification import synthetic_detail  # noqa: E402
from tools import audit_dcad_field_completeness as audit  # noqa: E402


class FakeResult:
    def __init__(self, row=None, scalar=None):
        self.row, self.scalar = row, scalar

    def mappings(self):
        return self

    def first(self):
        return self.row

    def scalar_one_or_none(self):
        return self.scalar


class FakeEngine:
    def __init__(self, row=None, current_fields=()):
        self.row, self.current_fields = row, current_fields
        self.calls = []

    def begin(self):
        return self

    def connect(self):
        return self

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def execute(self, statement, parameters):
        # Catch missing bind parameters without opening a database connection.
        compiled = statement.compile(dialect=postgresql.dialect())
        missing = set(compiled.params) - set(parameters)
        if missing:
            raise AssertionError(f"Missing SQL parameters: {sorted(missing)}")
        self.calls.append((str(statement), parameters))
        return FakeResult(self.row, self.current_fields)


class WorkerFieldVerificationTests(unittest.TestCase):
    def setUp(self):
        self.config = worker.WorkerConfig.from_env()
        self.account_id = "12345678901234567"
        self.assessment = CompletenessAssessment(True, True, True, False, ())

    def verification_engine(self, source=None):
        source = synthetic_detail() if source is None else source
        normalized = parsed_verification_row(synthetic_detail())
        normalized.update(parsed_detail=source, snapshot_is_fresh=True)
        return FakeEngine(normalized)

    def test_requested_unknown_fields_are_not_silently_dropped(self):
        self.assertEqual(worker.fields_still_missing(
            ("owner", "missing_mailing_address", "future_field", "future_field"),
            {"owner": True},
        ), ("missing_mailing_address", "future_field"))

    def test_all_requested_fields_require_normalized_and_fresh_parsed_presence(self):
        engine = self.verification_engine()
        self.assertEqual(worker.missing_required_fields(
            engine, self.config, self.account_id,
            ("owner", "land", "gla", "missing_mailing_address", "missing_ownership_percentage",
             "missing_building_class", "missing_deed_transfer", "missing_tax_year"),
        ), ())

    def test_retained_normalized_mailing_cannot_mask_a_fresh_parser_gap(self):
        source = synthetic_detail()
        source["owner"]["mailing_address"] = None
        engine = self.verification_engine(source)
        self.assertEqual(worker.missing_required_fields(
            engine, self.config, self.account_id, ("owner", "missing_mailing_address"),
        ), ("missing_mailing_address",))

    def test_parsed_value_does_not_satisfy_a_failed_normalized_write(self):
        engine = self.verification_engine()
        engine.row["building_class"] = None
        self.assertEqual(worker.missing_required_fields(
            engine, self.config, self.account_id, ("gla", "missing_building_class"),
        ), ("missing_building_class",))

    def test_unknown_field_survives_a_healthy_scrape(self):
        self.assertEqual(worker.missing_required_fields(
            self.verification_engine(), self.config, self.account_id, ("missing_future_field",),
        ), ("missing_future_field",))

    def vacant_detail(self):
        detail = synthetic_detail()
        detail["primary_improvements"] = {"building_class": None, "living_area_sqft": None,
                                          "basement": "NONE", "pool": "NONE", "sprinkler": "NONE"}
        detail["value_summary"].update(market_value=100, land_value=100, improvement_value=0)
        detail["land_detail"] = [{"state_code": "SFR - VACANT LOTS/TRACTS", "area_sqft": 43560}]
        return detail

    def vacant_engine(self, detail=None):
        detail = self.vacant_detail() if detail is None else detail
        normalized = parsed_verification_row(detail)
        normalized.update(parsed_detail=detail, snapshot_is_fresh=True)
        return FakeEngine(normalized)

    def test_fresh_raw_and_normalized_vacancy_waive_improvement_only_obligations(self):
        engine = self.vacant_engine()
        self.assertEqual(worker.missing_required_fields(
            engine, self.config, self.account_id,
            ("gla", "missing_gla", "missing_building_class", "missing_improvement_value"),
        ), ())

    def test_equal_positive_values_and_no_main_can_waive_fields_without_vacant_code(self):
        detail = self.vacant_detail()
        detail["land_detail"][0]["state_code"] = "RESIDENTIAL"
        self.assertEqual(worker.missing_required_fields(
            self.vacant_engine(detail), self.config, self.account_id, ("missing_building_class", "missing_gla"),
        ), ())

    def test_one_sided_vacancy_cannot_clear_absent_building_class(self):
        engine = self.vacant_engine()
        engine.row["building_class"] = "14"
        engine.row["has_primary_improvement"] = True
        self.assertEqual(worker.missing_required_fields(
            engine, self.config, self.account_id, ("missing_building_class",),
        ), ("missing_building_class",))
        engine = self.vacant_engine()
        engine.row["parsed_detail"] = synthetic_detail()
        self.assertEqual(worker.missing_required_fields(
            engine, self.config, self.account_id, ("missing_building_class",),
        ), ("missing_building_class",))

    def test_mixed_raw_state_codes_cannot_clear_improvement_obligations(self):
        engine = self.vacant_engine()
        engine.row["parsed_detail"]["land_detail"].append({"state_code": "SFR - RESIDENCE", "area_sqft": 0})
        self.assertEqual(worker.missing_required_fields(
            engine, self.config, self.account_id, ("missing_building_class", "missing_gla"),
        ), ("missing_building_class", "missing_gla"))

    def test_vacancy_does_not_waive_zero_land_area_or_other_missing_fields(self):
        detail = self.vacant_detail()
        detail["land_detail"][0]["area_sqft"] = 0
        detail["legal_description"]["deed_transfer_date"] = None
        self.assertEqual(worker.missing_required_fields(
            self.vacant_engine(detail), self.config, self.account_id,
            ("missing_building_class", "missing_land_area", "missing_deed_transfer", "missing_future_field"),
        ), ("missing_land_area", "missing_deed_transfer", "missing_future_field"))

    def test_vacancy_still_requires_a_fresh_snapshot(self):
        engine = self.vacant_engine()
        engine.row["snapshot_is_fresh"] = False
        with self.assertRaisesRegex(RuntimeError, "fresh parsed snapshot"):
            worker.missing_required_fields(engine, self.config, self.account_id, ("missing_building_class",))

    def test_fresh_foundation_roof_baths_only_do_not_waive_class_or_gla(self):
        engine = self.vacant_engine()
        detail = engine.row["parsed_detail"]
        detail["primary_improvements"] = {"foundation": "SLAB", "roof_type": "GABLE", "baths_full": 2}
        detail["land_detail"][0]["state_code"] = "RESIDENTIAL"
        self.assertEqual(worker.missing_required_fields(
            engine, self.config, self.account_id, ("missing_building_class", "missing_gla"),
        ), ("missing_building_class", "missing_gla"))

    def test_normalized_structure_signal_alone_still_blocks_vacant_waiver(self):
        engine = self.vacant_engine()
        engine.row["has_primary_improvement"] = True
        self.assertEqual(worker.missing_required_fields(
            engine, self.config, self.account_id, ("missing_building_class", "missing_gla"),
        ), ("missing_building_class", "missing_gla"))

    def test_verification_sql_uses_shared_meaningful_structure_predicate(self):
        engine = self.vacant_engine()
        worker.missing_required_fields(engine, self.config, self.account_id, ("missing_building_class",))
        self.assertIn(primary_structure_sql("p") + " AS has_primary_improvement", engine.calls[0][0])

    def test_stale_missing_or_invalid_snapshot_is_a_retryable_error(self):
        for row in (None, {"snapshot_is_fresh": False, "parsed_detail": synthetic_detail()},
                    {"snapshot_is_fresh": True, "parsed_detail": None}):
            with self.subTest(row=row):
                with self.assertRaisesRegex(RuntimeError, "fresh parsed snapshot"):
                    worker.missing_required_fields(FakeEngine(row), self.config, self.account_id,
                                                   ("missing_mailing_address",))

    def test_sql_binds_owners_land_parties_and_values_to_the_fresh_snapshot_year(self):
        engine = self.verification_engine()
        worker.missing_required_fields(engine, self.config, self.account_id, ("owner",))
        sql = engine.calls[0][0]
        for clause in ("ORDER BY fetched_at DESC, tax_year DESC",
                       "r.fetched_at >= q.last_attempt_at", "o.tax_year = r.tax_year",
                       "v.certified_year = r.tax_year", "l.tax_year = r.tax_year"):
            self.assertIn(clause, sql)
        self.assertEqual(sql.count("WHERE account_id = r.account_id AND tax_year = r.tax_year"), 2)

    def test_claim_absorbs_exact_flags_for_existing_legacy_jobs(self):
        engine = FakeEngine({"account_id": self.account_id, "attempts": 0,
                             "requested_fields": ["owner", "missing_mailing_address"]})
        claim = worker.claim_next_field_repair(engine, self.config, "test-worker")
        self.assertEqual(claim, (self.account_id, 0, ("owner", "missing_mailing_address")))
        sql = engine.calls[0][0]
        self.assertIn("SELECT data_quality_flags", sql)
        self.assertIn("left(field, 8) = 'missing_'", sql)
        self.assertIn("requested_fields = c.requested_fields", sql)

    def test_completion_clears_only_verified_exact_flags(self):
        requested = ("owner", "missing_owner_name", "missing_mailing_address")
        engine = FakeEngine(current_fields=requested)
        remaining = worker.mark_field_repair_result(
            engine, self.config, self.account_id, ("missing_mailing_address",), requested,
        )
        self.assertEqual(remaining, ("missing_mailing_address",))
        queue_params = engine.calls[1][1]
        self.assertEqual(queue_params["status"], "source_missing")
        self.assertIn("source absence versus parser gap is undetermined", queue_params["reason"])
        self.assertIn("CASE WHEN :status = 'succeeded'", engine.calls[1][0])
        for sql, params in engine.calls[2:]:
            self.assertEqual(params["cleared_flags"], ["missing_owner_name", "field_repair_unresolved"])
            self.assertEqual(params["quality_flags"], ["missing_mailing_address", "field_repair_unresolved"])
            self.assertIn("WHERE NOT (flag = ANY(CAST(:cleared_flags AS text[])))", sql)

    def test_completion_preserves_requests_added_during_the_fetch(self):
        engine = FakeEngine(current_fields=("owner", "missing_new_field"))
        remaining = worker.mark_field_repair_result(engine, self.config, self.account_id, (), ("owner",))
        self.assertEqual(remaining, ("missing_new_field",))
        self.assertEqual(engine.calls[1][1]["status"], "pending")
        self.assertIn("require another verification", engine.calls[1][1]["reason"])

    def test_fully_verified_completion_records_success(self):
        fields = ("missing_mailing_address",)
        engine = FakeEngine(current_fields=fields)
        self.assertEqual(worker.mark_field_repair_result(
            engine, self.config, self.account_id, (), fields,
        ), ())
        self.assertEqual(engine.calls[1][1]["status"], "succeeded")
        self.assertIn("verified present or not applicable for confirmed vacant land",
                      engine.calls[1][1]["reason"])
        self.assertEqual(engine.calls[2][1]["quality_flags"], [])

    def test_market_updates_only_own_the_market_flags(self):
        for action in ("mark_success", "record_market_value_assessment", "mark_market_value_recheck_failure"):
            with self.subTest(action=action):
                engine = FakeEngine({"recovered": False})
                if action == "mark_market_value_recheck_failure":
                    getattr(worker, action)(engine, self.config, self.account_id, 0, RuntimeError("example"))
                else:
                    getattr(worker, action)(engine, self.config, self.account_id, self.assessment)
                updates = [(sql, params) for sql, params in engine.calls if ":cleared_flags" in sql]
                self.assertTrue(updates)
                for sql, params in updates:
                    expected = list(worker.MARKET_QUALITY_FLAGS)
                    if action == "mark_success":
                        expected += ["scrape_error", "dcad_reported_no_data", "missing_address"]
                    self.assertEqual(params["cleared_flags"], expected)
                    self.assertIn("WHERE NOT (flag = ANY(CAST(:cleared_flags AS text[])))", sql)
                    self.assertIn("THEN 'incomplete'", sql)

    def test_autogenerated_legacy_work_does_not_erase_detailed_obligations(self):
        engine = FakeEngine()
        worker.queue_missing_fields_after_success(engine, self.config, self.account_id)
        self.assertIn("existing.requested_fields || EXCLUDED.requested_fields", engine.calls[0][0])

    def test_audit_queue_merges_requests_and_retains_unrelated_account_flags(self):
        cursor = Mock()
        candidates = [(self.account_id, ["missing_mailing_address"], ["owner", "missing_mailing_address"])]
        with patch.object(audit, "insert_candidates") as insert:
            self.assertEqual(audit.queue_candidates(cursor, candidates), 1)
        insert.assert_called_once_with(cursor, candidates)
        self.assertIn("existing.requested_fields || EXCLUDED.requested_fields",
                      cursor.execute.call_args_list[0].args[0])
        self.assertIn("COALESCE(account.data_quality_flags, ARRAY[]::text[]) || repair.flags",
                      cursor.execute.call_args_list[1].args[0])
        self.assertIn("JOIN latest_owner latest", audit.AUDIT_SQL)
        self.assertIn("JOIN latest_land_year latest USING (account_id, tax_year)", audit.AUDIT_SQL)

    def test_success_does_not_clear_missing_address_without_new_address_evidence(self):
        engine = FakeEngine({"recovered": False})
        assessment = CompletenessAssessment(True, False, True, False, ("missing_address",))
        worker.mark_success(engine, self.config, self.account_id, assessment)
        for sql, params in engine.calls:
            if ":cleared_flags" in sql:
                self.assertNotIn("missing_address", params["cleared_flags"])

    def test_field_completion_uses_the_same_lock_order_as_market_updates(self):
        fields = ("missing_mailing_address",)
        engine = FakeEngine(current_fields=fields)
        worker.mark_field_repair_result(engine, self.config, self.account_id, (), fields)
        self.assertIn('UPDATE "app"."dcad_scrape_state"', engine.calls[2][0])
        self.assertIn('UPDATE "core"."accounts"', engine.calls[3][0])

    def test_pipeline_passes_exact_obligations_to_completion(self):
        requested = ("owner", "missing_mailing_address")
        mocks = {
            "run_for_account": Mock(return_value=self.assessment),
            "missing_required_fields": Mock(return_value=("missing_mailing_address",)),
            "record_market_value_assessment": Mock(),
            "mark_field_repair_result": Mock(return_value=("missing_mailing_address",)),
            "reset_outage_circuit": Mock(return_value=False),
            "mark_field_repair_failure": Mock(),
        }
        with ExitStack() as stack:
            stack.enter_context(patch.object(worker, "_stop_requested", False))
            for name, mock in mocks.items():
                stack.enter_context(patch.object(worker, name, mock))
            worker.process_field_repair_safely(None, self.config, "test-worker", self.account_id, 0, requested)
        mocks["mark_field_repair_result"].assert_called_once_with(
            None, self.config, self.account_id, ("missing_mailing_address",), requested,
        )
        mocks["mark_field_repair_failure"].assert_not_called()


if __name__ == "__main__":
    unittest.main()

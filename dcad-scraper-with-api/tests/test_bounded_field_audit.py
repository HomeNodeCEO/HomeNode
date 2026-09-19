import argparse
from copy import deepcopy
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
import sys
import unittest
from unittest.mock import patch


PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from tools import audit_dcad_field_completeness as audit  # noqa: E402


def setUpModule():
    for target in ("socket.socket", "socket.create_connection", "psycopg2.connect",
                   "sqlalchemy.create_engine"):
        blocker = patch(target, side_effect=AssertionError("Live network/database access is forbidden"))
        blocker.start()
        unittest.addModuleCleanup(blocker.stop)


ACCOUNT_ID = "11111111111111111"
SECOND_ACCOUNT_ID = "22222222222222222"
SYNTHETIC_DATABASE_URL = "postgresql://synthetic.invalid/never-connect"


def healthy_row(**overrides):
    row = {
        "account_id": ACCOUNT_ID,
        "fetched_at": datetime(2026, 9, 1, tzinfo=timezone.utc),
        "parsed_detail": {
            "tax_year": 2026,
            "property_location": {"address": "100 EXAMPLE WAY"},
            "owner": {
                "owner_name": "SYNTHETIC OWNER",
                "mailing_address": "200 EXAMPLE AVENUE",
                "multi_owner": [{"owner_name": "SYNTHETIC OWNER", "ownership_pct": "100%"}],
            },
        },
        "address": "100 EXAMPLE WAY",
        "tax_year": 2026,
        "market_value": Decimal("250000"),
        "land_value": Decimal("50000"),
        "land_area": Decimal("7500"),
        "improvement_value": Decimal("200000"),
        "owner_name": "SYNTHETIC OWNER",
        "mailing_address": "200 EXAMPLE AVENUE",
        "ownership_percentage": Decimal("100"),
        "state_codes": ["SFR - RESIDENCE"],
        "deed_transfer": "2024-01-15",
        "has_primary_improvement": True,
        "has_land_details": True,
        "building_class": "14",
        "gla": 1500,
        "scrape_status": "succeeded",
        "field_repair_status": None,
        "field_repair_requested_fields": [],
        "field_repair_remaining_fields": [],
    }
    row.update(overrides)
    return row


class BoundedAssessmentTests(unittest.TestCase):
    def test_healthy_improved_control_is_not_a_candidate(self):
        result = audit.bounded_assessment(healthy_row())
        self.assertEqual(result.property_classification, "improved")
        self.assertEqual(result.missing_fields, ())
        self.assertFalse(result.repair_required)

    def test_exact_missing_fields_are_reported_independently(self):
        result = audit.bounded_assessment(healthy_row(
            mailing_address=None, ownership_percentage=None,
            building_class=None, deed_transfer=None,
        ))
        self.assertEqual(
            set(result.missing_fields),
            {"mailing_address", "ownership_percentage", "building_class", "deed_transfer"},
        )
        self.assertTrue(result.repair_required)

    def test_zero_and_negative_gla_are_missing(self):
        for gla in (0, -1, Decimal("NaN")):
            with self.subTest(gla=gla):
                result = audit.bounded_assessment(healthy_row(gla=gla))
                self.assertIn("gla", result.missing_fields)
                self.assertTrue(result.repair_required)

    def test_truncated_and_placeholder_owner_names_are_missing(self):
        for owner_name in ("SYNTHETIC OWNER & ", "N/A", "   "):
            with self.subTest(owner_name=owner_name):
                result = audit.bounded_assessment(healthy_row(owner_name=owner_name))
                self.assertIn("owner_name", result.missing_fields)
                self.assertTrue(result.repair_required)

    def test_nonfinite_numeric_values_are_missing(self):
        result = audit.bounded_assessment(healthy_row(
            market_value=Decimal("NaN"), ownership_percentage=Decimal("Infinity"),
        ))
        self.assertIn("market_value", result.missing_fields)
        self.assertIn("ownership_percentage", result.missing_fields)

    def test_historical_parser_gap_does_not_requeue_complete_normalized_fields(self):
        row = healthy_row()
        row["parsed_detail"]["owner"]["mailing_address"] = None
        result = audit.bounded_assessment(row)
        self.assertNotIn("mailing_address", result.missing_fields)
        self.assertFalse(result.repair_required)

    def test_all_vacant_codes_without_improvements_are_not_queued(self):
        result = audit.bounded_assessment(healthy_row(
            state_codes=["SFR - Vacant Lots/Tracts"], has_primary_improvement=False,
            improvement_value=0, land_value=100000, market_value=100000,
            building_class=None, gla=None,
        ))
        self.assertEqual(result.property_classification, "vacant")
        self.assertFalse(result.repair_required)

class CandidateActionTests(unittest.TestCase):
    def test_no_missing_fields_never_change_the_queue(self):
        for status in (None, "pending", "retry", "leased", "succeeded", "source_missing"):
            with self.subTest(status=status):
                self.assertEqual(audit.candidate_action(
                    healthy_row(field_repair_status=status), (),
                ), "none")

    def test_missing_fields_without_a_queue_row_are_inserted(self):
        self.assertEqual(audit.candidate_action(healthy_row(), ("mailing_address",)), "insert")

    def test_primary_or_repair_lease_is_deferred_without_reclaim(self):
        for overrides in (
            {"scrape_status": "leased"},
            {"field_repair_status": "leased"},
            {"field_repair_status": "leased", "field_repair_lease_expires_at":
             datetime(2000, 1, 1, tzinfo=timezone.utc)},
        ):
            with self.subTest(overrides=overrides):
                self.assertEqual(audit.candidate_action(
                    healthy_row(**overrides), ("mailing_address",),
                ), "defer_active")

    def test_primary_work_not_yet_succeeded_is_deferred(self):
        for status in (None, "pending", "retry"):
            with self.subTest(status=status):
                self.assertEqual(audit.candidate_action(
                    healthy_row(scrape_status=status), ("mailing_address",),
                ), "defer_primary")

    def test_missing_or_unusable_snapshot_is_deferred(self):
        for overrides in ({"fetched_at": None}, {"parsed_detail": None},
                          {"parsed_detail": []}, {"parsed_detail": "invalid"}):
            with self.subTest(overrides=overrides):
                self.assertEqual(audit.candidate_action(
                    healthy_row(**overrides), ("mailing_address",),
                ), "defer_snapshot")

    def test_pending_and_retry_with_identical_exact_obligations_are_noops(self):
        for status in ("pending", "retry"):
            with self.subTest(status=status):
                row = healthy_row(
                    field_repair_status=status,
                    field_repair_requested_fields=["owner", "missing_mailing_address"],
                    field_repair_remaining_fields=["owner", "missing_mailing_address"],
                )
                self.assertEqual(audit.candidate_action(row, ("mailing_address",)), "none")

    def test_pending_and_retry_merge_new_exact_fields(self):
        for status in ("pending", "retry"):
            with self.subTest(status=status):
                row = healthy_row(
                    field_repair_status=status,
                    field_repair_requested_fields=["owner", "missing_owner_name"],
                    field_repair_remaining_fields=["missing_owner_name"],
                )
                self.assertEqual(audit.candidate_action(row, ("mailing_address",)), "merge")

    def test_missing_exact_field_is_restored_to_remaining_fields(self):
        row = healthy_row(
            field_repair_status="retry",
            field_repair_requested_fields=["owner", "missing_mailing_address"],
            field_repair_remaining_fields=["owner"],
        )
        self.assertEqual(audit.candidate_action(row, ("mailing_address",)), "merge")

    def test_source_missing_is_never_automatically_reopened(self):
        row = healthy_row(
            field_repair_status="source_missing",
            field_repair_requested_fields=["owner", "missing_owner_name"],
            field_repair_remaining_fields=["missing_owner_name"],
        )
        for missing in (("owner_name",), ("mailing_address",)):
            with self.subTest(missing=missing):
                self.assertEqual(audit.candidate_action(row, missing), "defer_terminal")

    def test_succeeded_known_exact_obligation_requires_review_before_reopening(self):
        row = healthy_row(
            field_repair_status="succeeded",
            field_repair_requested_fields=["owner", "missing_mailing_address"],
            field_repair_remaining_fields=[],
        )
        self.assertEqual(audit.candidate_action(row, ("mailing_address",)), "defer_terminal")

    def test_succeeded_new_exact_obligation_can_reopen(self):
        row = healthy_row(
            field_repair_status="succeeded",
            field_repair_requested_fields=["owner", "missing_owner_name"],
        )
        self.assertEqual(audit.candidate_action(row, ("mailing_address",)), "reopen")

    def test_legacy_lane_is_not_a_previously_verified_exact_obligation(self):
        row = healthy_row(
            field_repair_status="succeeded", field_repair_requested_fields=["owner"],
        )
        self.assertEqual(audit.candidate_action(row, ("mailing_address",)), "reopen")

    def test_deciding_an_action_does_not_mutate_retry_metadata(self):
        row = healthy_row(
            field_repair_status="retry", field_repair_requested_fields=["owner"],
            field_repair_attempts=7, field_repair_last_error="Synthetic prior error",
            field_repair_next_attempt_at=datetime(2026, 10, 1, tzinfo=timezone.utc),
        )
        original = deepcopy(row)
        self.assertEqual(audit.candidate_action(row, ("mailing_address",)), "merge")
        self.assertEqual(row, original)


class BoundedScopeValidationTests(unittest.TestCase):
    def test_invalid_scope_is_rejected_before_any_database_connection(self):
        invalid_arguments = (
            {}, {"limit": 1}, {"batch_size": 0}, {"batch_size": -1},
            {"batch_size": 501}, {"account_ids": []}, {"account_ids": [""]},
            {"account_ids": ["not-an-account"]},
            {"account_ids": ["A" * 65]}, {"account_ids": ["１２３"]},
            {"account_ids": [str(number) for number in range(501)]},
            {"account_ids": [ACCOUNT_ID], "batch_size": 1},
            {"account_ids": [ACCOUNT_ID], "full_scan": True},
            {"batch_size": 1, "full_scan": True},
            {"after_account_id": ACCOUNT_ID},
            {"account_ids": [ACCOUNT_ID], "after_account_id": SECOND_ACCOUNT_ID},
            {"batch_size": 1, "after_account_id": "not-an-account"},
            {"batch_size": 1, "limit": 0}, {"batch_size": 1, "limit": 501},
            {"full_scan": True, "apply": True},
            {"account_ids": [ACCOUNT_ID], "full_scan_statement_timeout_seconds": 120},
            {"batch_size": 1, "full_scan_statement_timeout_seconds": 120},
            *({"full_scan": True, "full_scan_statement_timeout_seconds": value}
              for value in (0, -1, 121, True, 15.5, "120")),
        )
        with patch.dict(audit.os.environ, {"DATABASE_URL": SYNTHETIC_DATABASE_URL}):
            for arguments in invalid_arguments:
                with self.subTest(arguments=arguments):
                    with patch.object(audit.psycopg2, "connect") as connect:
                        with self.assertRaises((ValueError, argparse.ArgumentTypeError)):
                            audit.run(**arguments)
                        connect.assert_not_called()


class BoundedSqlTests(unittest.TestCase):
    def test_detail_query_is_scoped_to_one_bound_account(self):
        sql = audit.ACCOUNT_AUDIT_SQL
        self.assertIn("WHERE t.account_id = %(account_id)s", sql)
        self.assertNotIn("GROUP BY", sql.upper())
        self.assertNotIn("SELECT DISTINCT ON", sql.upper())
        self.assertIn("WHERE r.account_id = t.account_id", sql)
        self.assertEqual(
            sql.count("WHERE account_id = t.account_id AND tax_year = raw.tax_year"), 2,
        )

    def test_owner_value_legal_land_and_parties_share_the_snapshot_year(self):
        sql = audit.ACCOUNT_AUDIT_SQL
        self.assertIn("owner.tax_year = raw.tax_year", sql)
        self.assertIn("value.certified_year = raw.tax_year", sql)
        self.assertIn("legal.tax_year = raw.tax_year", sql)
        self.assertIn("ORDER BY r.fetched_at DESC, r.tax_year DESC LIMIT 1", sql)

    def test_page_selection_is_bounded_keyset_not_offset(self):
        sql = audit.KEYSET_SQL
        self.assertIn("account_id > %(after_account_id)s", sql)
        self.assertIn("ORDER BY account_id", sql)
        self.assertIn("LIMIT %(page_size)s", sql)
        self.assertNotIn("OFFSET", sql.upper())

    def test_parameterized_detail_sql_has_no_unescaped_percent_wildcards(self):
        # psycopg2 uses this placeholder syntax; a literal LIKE '%...%' in a
        # parameterized query can be mistaken for an extra bind placeholder.
        rendered = audit.ACCOUNT_AUDIT_SQL % {"account_id": "synthetic-bind-marker"}
        self.assertIn("synthetic-bind-marker", rendered)

    def test_audit_uses_the_same_complete_structure_predicate_as_the_worker(self):
        from scraper.dcad.field_completeness import PRIMARY_STRUCTURE_FIELDS, primary_structure_sql

        self.assertIn(primary_structure_sql("improvement"), audit.ACCOUNT_AUDIT_SQL)
        for field in PRIMARY_STRUCTURE_FIELDS:
            with self.subTest(field=field):
                self.assertIn(f"improvement.{field}::text", audit.ACCOUNT_AUDIT_SQL)


class ScriptedCursor:
    def __init__(self, results=()):
        self.results = iter(results)
        self.calls = []

    def execute(self, statement, parameters=None):
        self.calls.append((statement, parameters))

    def fetchone(self):
        return next(self.results)


class BoundedQueueApplyTests(unittest.TestCase):
    def candidate(self):
        return (
            ACCOUNT_ID, ["missing_mailing_address"], ["owner", "missing_mailing_address"],
        )

    def test_queue_merge_does_not_reset_retry_or_lease_metadata(self):
        cursor = ScriptedCursor([{"account_id": ACCOUNT_ID}])
        self.assertEqual(audit.queue_candidates(cursor, [self.candidate()]), 1)
        sql = cursor.calls[0][0]
        update = sql.split("ON CONFLICT (account_id) DO UPDATE", 1)[1]
        for column in ("attempts", "last_error", "lease_expires_at", "worker_id", "reason"):
            with self.subTest(column=column):
                self.assertNotRegex(update, rf"\b{column}\s*=")
        self.assertIn("ELSE existing.status", update)
        self.assertIn("ELSE existing.next_attempt_at", update)
        self.assertIn("existing.requested_fields @> EXCLUDED.requested_fields", update)
        self.assertIn("existing.remaining_fields @> EXCLUDED.remaining_fields", update)
        self.assertIn("existing.status IN ('pending', 'retry')", update)
        self.assertNotIn("source_missing", update)
        self.assertNotIn("'leased'", update)

    def test_guarded_queue_noop_does_not_rewrite_account_flags(self):
        cursor = ScriptedCursor([None])
        self.assertEqual(audit.queue_candidates(cursor, [self.candidate()]), 0)
        self.assertEqual(len(cursor.calls), 1)

    def test_account_flags_are_merged_only_after_actual_queue_change(self):
        cursor = ScriptedCursor([{"account_id": ACCOUNT_ID}])
        self.assertEqual(audit.queue_candidates(cursor, [self.candidate()]), 1)
        self.assertEqual(len(cursor.calls), 2)
        sql, parameters = cursor.calls[1]
        self.assertIn("COALESCE(account.data_quality_flags, ARRAY[]::text[]) ||", sql)
        self.assertEqual(parameters["flags"], ["missing_mailing_address"])
        self.assertEqual(parameters["account_id"], ACCOUNT_ID)

    def test_apply_rechecks_healthy_account_and_does_not_queue_it(self):
        lock_row = {"account_id": ACCOUNT_ID}
        cursor = ScriptedCursor([None, lock_row, lock_row, healthy_row()])
        with patch.object(audit, "queue_candidates") as queue:
            self.assertEqual(audit.apply_account(cursor, ACCOUNT_ID), "no_longer_candidate")
        queue.assert_not_called()
        self.assertIn("app.dcad_field_repair_queue", cursor.calls[0][0])
        self.assertIn("app.dcad_scrape_state", cursor.calls[1][0])
        self.assertIn("core.accounts", cursor.calls[2][0])
        for statement, _parameters in cursor.calls[:3]:
            self.assertIn("FOR UPDATE SKIP LOCKED", statement)

    def test_apply_does_not_wait_for_a_locked_primary_row(self):
        cursor = ScriptedCursor([{"account_id": ACCOUNT_ID}, None])
        with patch.object(audit, "queue_candidates") as queue:
            self.assertEqual(audit.apply_account(cursor, ACCOUNT_ID), "defer_locked_or_missing")
        queue.assert_not_called()

    def test_apply_defers_a_queue_row_that_was_not_locked(self):
        lock_row = {"account_id": ACCOUNT_ID}
        row = healthy_row(mailing_address=None, field_repair_status="retry")
        cursor = ScriptedCursor([None, lock_row, lock_row, row])
        with patch.object(audit, "queue_candidates") as queue:
            self.assertEqual(audit.apply_account(cursor, ACCOUNT_ID), "defer_locked_or_changed")
        queue.assert_not_called()

    def test_apply_does_not_reopen_a_terminal_gap_after_rechecking(self):
        lock_row = {"account_id": ACCOUNT_ID}
        row = healthy_row(mailing_address=None, field_repair_status="source_missing")
        cursor = ScriptedCursor([lock_row, lock_row, lock_row, row])
        with patch.object(audit, "queue_candidates") as queue:
            self.assertEqual(audit.apply_account(cursor, ACCOUNT_ID), "defer_terminal")
        queue.assert_not_called()

    def test_apply_queues_only_the_rechecked_exact_missing_fields(self):
        lock_row = {"account_id": ACCOUNT_ID}
        row = healthy_row(mailing_address=None)
        cursor = ScriptedCursor([None, lock_row, lock_row, row])
        with patch.object(audit, "queue_candidates", return_value=1) as queue:
            self.assertEqual(audit.apply_account(cursor, ACCOUNT_ID), "insert")
        queue.assert_called_once_with(cursor, [self.candidate()])


class ReadOnlyAuditCursor:
    def __init__(self, connection):
        self.connection = connection
        self.results = []

    def __enter__(self):
        return self

    def __exit__(self, *_arguments):
        return None

    def execute(self, statement, parameters=None):
        self.connection.events.append(("execute", statement, parameters))
        if statement in (
            "SET LOCAL statement_timeout = '1s'", "SET LOCAL statement_timeout = '15s'",
            "SET LOCAL statement_timeout = '120s'", "SET LOCAL lock_timeout = '1s'",
        ):
            self.results = []
            return
        if self.connection.read_error is not None:
            raise self.connection.read_error
        if statement == audit.ACCOUNT_AUDIT_SQL:
            row = self.connection.rows.get(parameters["account_id"])
            self.results = [] if row is None else [row]
        elif statement == audit.KEYSET_SQL:
            keys = sorted(key for key in self.connection.rows
                          if key > parameters["after_account_id"])
            self.results = [{"account_id": key} for key in keys[:parameters["page_size"]]]
        elif statement == audit.AUDIT_SQL:
            self.results = list(self.connection.rows.values())
        else:
            raise AssertionError("Unexpected SQL in an offline scoped-audit read")

    def fetchone(self):
        return self.results.pop(0) if self.results else None

    def fetchall(self):
        rows, self.results = self.results, []
        return rows

    def __iter__(self):
        return iter(self.results)


class ReadOnlyAuditConnection:
    def __init__(self, rows, read_error=None):
        self.rows = {row["account_id"]: row for row in rows}
        self.read_error = read_error
        self.events = []

    def set_session(self, **arguments):
        self.events.append(("set_session", arguments))

    def cursor(self, *arguments, **keywords):
        self.events.append(("cursor", arguments, keywords))
        return ReadOnlyAuditCursor(self)

    def commit(self):
        self.events.append(("commit",))

    def rollback(self):
        self.events.append(("rollback",))

    def close(self):
        self.events.append(("close",))


class BoundedRunTests(unittest.TestCase):
    def run_offline(self, rows, **arguments):
        connection = ReadOnlyAuditConnection(rows)
        with patch.dict(audit.os.environ, {"DATABASE_URL": SYNTHETIC_DATABASE_URL}):
            with patch.object(audit.psycopg2, "connect", return_value=connection):
                result = audit.run(**arguments)
        return result, connection

    def test_default_sets_database_readonly_before_reading_explicit_scope(self):
        with patch.object(audit, "apply_account") as apply:
            result, connection = self.run_offline([healthy_row()], account_ids=[ACCOUNT_ID])
        apply.assert_not_called()
        self.assertEqual(connection.events[0], ("set_session", {"readonly": True}))
        self.assertIn(("rollback",), connection.events)
        self.assertNotIn(("commit",), connection.events)
        self.assertEqual(connection.events[-1], ("close",))
        self.assertFalse(result["applied"])
        self.assertEqual(result["scope"]["mode"], "account_ids")
        self.assertTrue(result["scope"]["partial"])
        self.assertEqual(result["scope"]["requested_accounts"], 1)
        self.assertEqual(result["scope"]["scanned_accounts"], 1)
        self.assertEqual(result["totals"]["accounts"], 1)
        self.assertEqual(result["repair_accounts_queued"], 0)
        self.assertEqual(result["repair_candidates_selected"], 0)

    def test_explicit_account_id_casing_and_leading_zeroes_are_preserved(self):
        synthetic_id = "000000000H0000000"
        result, connection = self.run_offline(
            [healthy_row(account_id=synthetic_id)], account_ids=[synthetic_id],
        )
        detail_calls = [event for event in connection.events
                        if event[0] == "execute" and event[1] == audit.ACCOUNT_AUDIT_SQL]
        self.assertEqual(len(detail_calls), 1)
        self.assertEqual(detail_calls[0][2]["account_id"], synthetic_id)
        self.assertEqual(result["scope"]["scanned_accounts"], 1)

    def test_explicit_scope_does_not_execute_the_global_aggregate_query(self):
        _, connection = self.run_offline([healthy_row()], account_ids=[ACCOUNT_ID])
        executed = [event[1] for event in connection.events
                    if event[0] == "execute" and not event[1].startswith("SET LOCAL")]
        self.assertEqual(executed, [audit.ACCOUNT_AUDIT_SQL])

    def test_missing_explicit_account_is_not_counted_as_scanned(self):
        result, _connection = self.run_offline(
            [healthy_row()], account_ids=[ACCOUNT_ID, SECOND_ACCOUNT_ID],
        )
        self.assertEqual(result["scope"]["requested_accounts"], 2)
        self.assertEqual(result["scope"]["scanned_accounts"], 1)
        self.assertEqual(result["totals"]["accounts"], 1)

    def test_keyset_reads_only_the_page_and_reports_a_partial_continuation(self):
        third_id = "33333333333333333"
        rows = [healthy_row(account_id=value)
                for value in (ACCOUNT_ID, SECOND_ACCOUNT_ID, third_id)]
        result, connection = self.run_offline(rows, batch_size=2)
        self.assertEqual(result["scope"]["mode"], "keyset")
        self.assertTrue(result["scope"]["partial"])
        self.assertTrue(result["scope"]["has_more"])
        self.assertEqual(result["scope"]["next_after_account_id"], SECOND_ACCOUNT_ID)
        self.assertEqual(result["scope"]["scanned_accounts"], 2)
        self.assertEqual(result["totals"]["accounts"], 2)
        detail_ids = [event[2]["account_id"] for event in connection.events
                      if event[0] == "execute" and event[1] == audit.ACCOUNT_AUDIT_SQL]
        self.assertEqual(detail_ids, [ACCOUNT_ID, SECOND_ACCOUNT_ID])
        self.assertNotIn(third_id, detail_ids)

    def test_keyset_resume_is_strictly_after_the_prior_account(self):
        rows = [healthy_row(account_id=value) for value in (ACCOUNT_ID, SECOND_ACCOUNT_ID)]
        result, _connection = self.run_offline(rows, batch_size=2, after_account_id=ACCOUNT_ID)
        self.assertFalse(result["scope"]["has_more"])
        self.assertEqual(result["scope"]["scanned_accounts"], 1)
        self.assertEqual(result["scope"]["after_account_id"], ACCOUNT_ID)

    def test_candidate_limit_does_not_truncate_scope_counts(self):
        rows = [healthy_row(account_id=value, mailing_address=None)
                for value in (ACCOUNT_ID, SECOND_ACCOUNT_ID)]
        result, _connection = self.run_offline(rows, account_ids=[ACCOUNT_ID, SECOND_ACCOUNT_ID], limit=1)
        self.assertEqual(result["scope"]["scanned_accounts"], 2)
        self.assertEqual(result["totals"]["repair_candidates"], 2)
        self.assertEqual(result["missing_fields"]["mailing_address"], 2)
        self.assertEqual(result["repair_candidates_selected"], 1)
        self.assertEqual(result["repair_accounts_queued"], 0)

    def test_apply_is_explicit_and_counts_only_actual_changed_accounts(self):
        rows = [healthy_row(account_id=value, mailing_address=None)
                for value in (ACCOUNT_ID, SECOND_ACCOUNT_ID)]
        with patch.object(audit, "apply_account", return_value="merge") as apply:
            result, connection = self.run_offline(
                rows, account_ids=[ACCOUNT_ID, SECOND_ACCOUNT_ID], limit=1, apply=True,
            )
        sessions = [event for event in connection.events if event[0] == "set_session"]
        self.assertEqual(sessions, [("set_session", {"readonly": True}),
                                    ("set_session", {"readonly": False})])
        self.assertEqual(apply.call_count, 1)
        self.assertTrue(result["applied"])
        self.assertEqual(result["repair_accounts_queued"], 1)
        self.assertEqual(result["apply_outcomes"]["merge"], 1)
        self.assertIn(("commit",), connection.events)

    def test_apply_recheck_deferrals_are_not_counted_as_changes(self):
        with patch.object(audit, "apply_account", return_value="defer_active"):
            result, _connection = self.run_offline(
                [healthy_row(mailing_address=None)], account_ids=[ACCOUNT_ID], apply=True,
            )
        self.assertEqual(result["repair_accounts_queued"], 0)
        self.assertEqual(result["apply_outcomes"]["defer_active"], 1)

    def test_apply_error_reports_prior_commits_and_stops_the_batch(self):
        third_id = "33333333333333333"
        ids = [ACCOUNT_ID, SECOND_ACCOUNT_ID, third_id]
        rows = [healthy_row(account_id=value, mailing_address=None) for value in ids]
        with patch.object(audit, "apply_account", side_effect=[
            "insert", RuntimeError("Synthetic failure details must not be printed"), "insert",
        ]) as apply:
            result, connection = self.run_offline(rows, account_ids=ids, apply=True)
        self.assertEqual(apply.call_count, 2)
        self.assertEqual(result["repair_accounts_queued"], 1)
        self.assertEqual(result["apply_outcomes"], {"insert": 1})
        self.assertEqual(result["apply_results"], [
            {"account_id": ACCOUNT_ID, "outcome": "insert"},
        ])
        self.assertEqual(result["apply_errors"], [
            {"account_id": SECOND_ACCOUNT_ID, "error_type": "RuntimeError"},
        ])
        self.assertEqual(connection.events.count(("commit",)), 1)
        self.assertGreaterEqual(connection.events.count(("rollback",)), 2)
        self.assertEqual(connection.events[-1], ("close",))

    def test_duplicate_explicit_ids_are_scanned_once(self):
        result, connection = self.run_offline(
            [healthy_row()], account_ids=[ACCOUNT_ID, ACCOUNT_ID],
        )
        detail_calls = [event for event in connection.events
                        if event[0] == "execute" and event[1] == audit.ACCOUNT_AUDIT_SQL]
        self.assertEqual(len(detail_calls), 1)
        self.assertEqual(result["scope"]["requested_accounts"], 1)
        self.assertEqual(result["scope"]["scanned_accounts"], 1)

    def test_full_scan_is_explicit_readonly_and_not_labeled_partial(self):
        result, connection = self.run_offline([healthy_row()], full_scan=True)
        self.assertEqual(result["scope"]["mode"], "full_scan")
        self.assertFalse(result["scope"]["partial"])
        self.assertEqual(connection.events[0], ("set_session", {"readonly": True}))
        self.assertNotIn(("commit",), connection.events)
        self.assertEqual(result["scope"]["statement_timeout_seconds"], 15)
        self.assertIn(("execute", "SET LOCAL statement_timeout = '15s'", None), connection.events)

    def test_full_scan_reports_omissions_but_never_advertises_runnable_candidates(self):
        incomplete = healthy_row(account_id=SECOND_ACCOUNT_ID, mailing_address=None)
        # Match the legacy full-scan projection: no queue state or parsed JSON.
        for key in ("field_repair_status", "field_repair_requested_fields",
                    "field_repair_remaining_fields", "parsed_detail"):
            incomplete.pop(key)
        with patch.object(audit, "candidate_action") as action:
            result, _connection = self.run_offline(
                [healthy_row(), incomplete], full_scan=True, limit=1,
            )
        action.assert_not_called()
        self.assertEqual(result["totals"]["repair_candidates"], 1)
        self.assertEqual(result["missing_fields"]["mailing_address"], 1)
        self.assertEqual(result["candidate_actions"], {"not_classified": 2})
        self.assertEqual(result["repair_candidates_selected"], 0)
        self.assertEqual(result["repair_accounts_queued"], 0)
        self.assertEqual(result["apply_results"], [])

    def test_full_scan_timeout_override_is_explicit_finite_and_set_before_query(self):
        for seconds in (1, 120):
            with self.subTest(seconds=seconds):
                result, connection = self.run_offline(
                    [healthy_row()], full_scan=True,
                    full_scan_statement_timeout_seconds=seconds,
                )
                self.assertEqual(result["scope"]["statement_timeout_seconds"], seconds)
                setting = ("execute", f"SET LOCAL statement_timeout = '{seconds}s'", None)
                named_cursor = ("cursor", (), {"name": "dcad_field_completeness_audit"})
                self.assertLess(connection.events.index(setting), connection.events.index(named_cursor))
                self.assertIn(("execute", "SET LOCAL lock_timeout = '1s'", None), connection.events)
                self.assertEqual(connection.events[0], ("set_session", {"readonly": True}))
                self.assertNotIn(("commit",), connection.events)
                self.assertEqual(connection.events[-2:], [("rollback",), ("close",)])

    def test_bounded_read_and_apply_statement_timeouts_remain_fifteen_seconds(self):
        for scope in ({"account_ids": [ACCOUNT_ID]}, {"batch_size": 1}):
            with self.subTest(scope=scope):
                with patch.object(audit, "apply_account", return_value="insert"):
                    result, connection = self.run_offline(
                        [healthy_row(mailing_address=None)], apply=True, **scope,
                    )
                settings = [event[1] for event in connection.events
                            if event[0] == "execute" and "statement_timeout" in event[1]]
                self.assertEqual(settings, ["SET LOCAL statement_timeout = '15s'"] * 2)
                self.assertEqual(result["scope"]["statement_timeout_seconds"], 15)

    def test_full_scan_read_failure_still_rolls_back_and_closes_without_a_report(self):
        connection = ReadOnlyAuditConnection([], read_error=RuntimeError("Synthetic full-scan timeout"))
        with patch.dict(audit.os.environ, {"DATABASE_URL": SYNTHETIC_DATABASE_URL}):
            with patch.object(audit.psycopg2, "connect", return_value=connection):
                with self.assertRaisesRegex(RuntimeError, "Synthetic full-scan timeout"):
                    audit.run(full_scan=True, full_scan_statement_timeout_seconds=120)
        self.assertNotIn(("commit",), connection.events)
        self.assertEqual(connection.events[-2:], [("rollback",), ("close",)])

    def test_read_error_rolls_back_and_closes_the_connection(self):
        connection = ReadOnlyAuditConnection([], read_error=RuntimeError("Synthetic read failure"))
        with patch.dict(audit.os.environ, {"DATABASE_URL": SYNTHETIC_DATABASE_URL}):
            with patch.object(audit.psycopg2, "connect", return_value=connection):
                with self.assertRaisesRegex(RuntimeError, "Synthetic read failure"):
                    audit.run(account_ids=[ACCOUNT_ID])
        self.assertIn(("rollback",), connection.events)
        self.assertEqual(connection.events[-1], ("close",))


if __name__ == "__main__":
    unittest.main()

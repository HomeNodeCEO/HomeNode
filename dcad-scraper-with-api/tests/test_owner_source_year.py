from copy import deepcopy
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import MagicMock, patch

from sqlalchemy.dialects import postgresql

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scraper"))
from dcad import upsert, worker
from dcad.owner_source import heading_year, owner_source_year, owner_source_year_sql, owner_withheld, owner_bundle_is_usable
from dcad.parse_detail import parse_detail_html
from dcad.field_completeness import parsed_verification_row, verification_presence
from test_field_verification import synthetic_detail
from test_worker_field_verification import FakeEngine


ACCOUNT = "11111111111111111"
WITHHELD_TEXT = "Owner withheld per Sec.# 25.025 or 25.026 of Texas Property Tax Code"


def owner(year=2027, name="SYNTHETIC CURRENT OWNER"):
    return {"source_year": year, "source_heading": f"Owner (Current {year})",
            "parties_source_heading": f"Multi-Owner (Current {year})",
            "owner_name": name, "mailing_address": "200 EXAMPLE WAY",
            "multi_owner": [{"owner_name": name, "ownership_pct": "100%"}]}


class Result:
    def __init__(self, value): self.value = value
    def scalar_one_or_none(self): return self.value
    def mappings(self): return self
    def one(self): return self.value
    def scalars(self): return self
    def all(self): return self.value


class OwnerConnection:
    """Small SQL collector/model, never a database connection."""
    def __init__(self, year=2026, name="SYNTHETIC FORMER OWNER"):
        self.summaries = {year: {"owner_name": name, "mailing_address": "100 FORMER WAY"}}
        self.parties = [{"tax_year": year, "owner_name": name, "ownership_pct": 100}]
        self.calls = []

    def execute(self, statement, params):
        sql = str(statement)
        self.assert_bindings(statement, params)
        self.calls.append((sql, deepcopy(params)))
        if "FOR UPDATE" in sql:
            return Result(ACCOUNT)
        if "FROM (SELECT 1) anchor" in sql:
            year = max(self.summaries, default=None)
            return Result({"tax_year": year, "owner_name": self.summaries.get(year, {}).get("owner_name"),
                           "party_year": max((p["tax_year"] for p in self.parties), default=None)})
        if "SELECT owner_name FROM core.owner_parties" in sql:
            return Result([party["owner_name"] for party in self.parties if party["tax_year"] == params["tax_year"]])
        if "INSERT INTO core.owner_summary" in sql:
            old = self.summaries.get(params["tax_year"], {})
            self.summaries[params["tax_year"]] = {"owner_name": params["owner_name"],
                "mailing_address": params["mailing_address"] if not params["same_owner"]
                else params["mailing_address"] or old.get("mailing_address")}
        elif "DELETE FROM core.owner_parties" in sql:
            self.parties = []
        elif "INSERT INTO core.owner_parties" in sql:
            self.parties.append(deepcopy(params))
        return Result(None)

    @staticmethod
    def assert_bindings(statement, params):
        missing = set(statement.compile(dialect=postgresql.dialect()).params) - params.keys()
        if missing: raise AssertionError(missing)


class OwnerSourceYearTests(unittest.TestCase):
    def test_shared_eligibility_is_strict_about_provenance_and_group_types(self):
        for value in (None, False, 0, [], "owner", {}, {**owner(), "source_year": None},
                      owner(name="SYNTHETIC PARTIAL &"), owner(name=WITHHELD_TEXT),
                      {**owner(), "multi_owner": {}}, {**owner(), "multi_owner": False},
                      {**owner(), "multi_owner": [{"owner_name": "PARTIAL &"}]}):
            with self.subTest(value=value):
                self.assertFalse(owner_bundle_is_usable(value))
        self.assertTrue(owner_bundle_is_usable(owner()))
        self.assertTrue(owner_bundle_is_usable({**owner(), "mailing_address": None, "multi_owner": []}))

    def test_current_owner_year_is_not_the_certified_value_year(self):
        detail = parse_detail_html('''<div><span id="lblOwner">Owner (Current 2027)</span>
          SYNTHETIC OWNER<br>100 EXAMPLE WAY<br>DALLAS, TEXAS 75000<br></div>
          <span id="ValueSummary1_lblApprYr">2026 Certified Values</span>''')
        self.assertEqual(detail["tax_year"], 2026)
        self.assertEqual(owner_source_year(detail["owner"]), 2027)
        self.assertEqual(detail["owner"]["source_heading"], "Owner (Current 2027)")
        self.assertEqual(parsed_verification_row(detail)["owner_source_year"], 2027)

    def test_unknown_or_conflicting_headings_and_unbounded_years_fail_closed(self):
        for changes in ({"source_year": None}, {"source_year": True}, {"source_year": 2027.0},
                        {"source_year": "202700000000"}, {"source_heading": "Owner"},
                        {"source_heading": "Owner (Current 2026)"},
                        {"parties_source_heading": "Multi-Owner (Current 2026)"},
                        {"parties_source_heading": "Multi-Owner"}):
            with self.subTest(changes=changes):
                self.assertIsNone(owner_source_year({**owner(), **changes}))
        self.assertIsNone(owner_source_year({"owner_name": "SYNTHETIC", "tax_year": 2026}))
        self.assertIsNone(heading_year("Owner (Current 2027) " + "x" * 200))
        self.assertEqual(heading_year("owner ( CURRENT 2027 )"), 2027)

    def test_unknown_and_withheld_raw_owners_never_satisfy_repair(self):
        for changes in ({"source_year": None}, {"owner_name": "WITHHELD"},
                        {"owner_name": WITHHELD_TEXT},
                        {"multi_owner": [{"owner_name": "CONFIDENTIAL", "ownership_pct": 100}]}):
            detail = synthetic_detail(); detail["owner"].update(changes); before = deepcopy(detail)
            presence = verification_presence(parsed_verification_row(detail))
            for field in ("owner", "missing_owner_name", "missing_mailing_address", "missing_ownership_percentage"):
                self.assertFalse(presence[field])
            self.assertEqual(detail, before)

    def test_actual_statutory_withholding_marker_is_not_a_real_owner(self):
        detail = parse_detail_html(f'''<div><span id="lblOwner">Owner (Current 2027)</span>
          {WITHHELD_TEXT}<br></div><span id="ValueSummary1_lblApprYr">2026 Certified Values</span>''')
        self.assertTrue(owner_withheld(detail["owner"]))
        self.assertIsNone(parsed_verification_row(detail)["owner_source_year"])
        self.assertFalse(owner_withheld(owner(name="WITHHELD FAMILY TRUST")))
        self.assertFalse(owner_withheld({"multi_owner": 1}))
        self.assertTrue(owner_withheld({"multi_owner": [{"owner_name": WITHHELD_TEXT}]}))

    def test_sql_join_key_has_no_valuation_fallback_or_unbounded_cast(self):
        sql = owner_source_year_sql("raw")
        self.assertIn("{detail,owner,source_year}", sql)
        self.assertIn("^[1-9][0-9]{3}$", sql)
        self.assertNotIn("raw.tax_year", sql)
        for invalid in ("raw; DROP", "raw.raw", "raw--"):
            self.assertRaises(ValueError, owner_source_year_sql, invalid)


class OwnerPersistenceTests(unittest.TestCase):
    def persist(self, connection, fresh):
        with patch.object(upsert, "_SCHEMA", "core"):
            return upsert.persist_owner_bundle(connection, ACCOUNT, fresh)

    def test_new_source_year_preserves_prior_year_and_replaces_only_current_parties(self):
        connection = OwnerConnection(); prior = deepcopy(connection.summaries[2026]); fresh = owner(); before = deepcopy(fresh)
        self.assertTrue(self.persist(connection, fresh))
        self.assertEqual(connection.summaries[2026], prior)
        self.assertEqual(connection.summaries[2027]["owner_name"], fresh["owner_name"])
        self.assertEqual({p["tax_year"] for p in connection.parties}, {2027})
        self.assertEqual(fresh, before)
        self.assertIn("FOR UPDATE", connection.calls[0][0])
        self.assertTrue(all(not any(token in sql for token in ("BEGIN", "COMMIT", "ROLLBACK")) for sql, _ in connection.calls))

    def test_missing_conflicting_withheld_or_partial_owner_source_performs_no_query(self):
        for changes in ({"source_year": None}, {"parties_source_heading": "Multi-Owner (Current 2026)"},
                        {"owner_name": "CONFIDENTIAL"}, {"owner_name": "N/A"},
                        {"owner_name": "--"}, {"owner_name": {}}, {"owner_name": True},
                        {"owner_name": "SYNTHETIC TRUNCATED &"},
                        {"owner_name": WITHHELD_TEXT}, {"multi_owner": [{}]},
                        {"multi_owner": "not a list"}, {"multi_owner": 1}, {"multi_owner": {}},
                        {"multi_owner": False}, {"multi_owner": [{"owner_name": []}]}):
            with self.subTest(changes=changes):
                connection = OwnerConnection()
                self.assertFalse(self.persist(connection, {**owner(), **changes}))
                self.assertEqual(connection.calls, [])

    def test_older_source_never_regresses_newer_summary_or_party_projection(self):
        for parties_only in (False, True):
            connection = OwnerConnection(2028)
            if parties_only: connection.summaries = {2026: {"owner_name": "OLD", "mailing_address": "OLD"}}
            before = deepcopy((connection.summaries, connection.parties))
            self.assertFalse(self.persist(connection, owner(2027)))
            self.assertEqual((connection.summaries, connection.parties), before)
            self.assertTrue(all("INSERT" not in sql and "DELETE" not in sql for sql, _ in connection.calls))

    def test_same_year_changed_owner_does_not_inherit_former_mailing_or_parties(self):
        connection = OwnerConnection(2027); fresh = owner(); fresh.update(mailing_address=None, multi_owner=[])
        self.assertTrue(self.persist(connection, fresh))
        self.assertIsNone(connection.summaries[2027]["mailing_address"])
        self.assertEqual(connection.parties, [])

    def test_same_owner_partial_grid_preserves_existing_data_without_inferred_percentages(self):
        connection = OwnerConnection(2027, owner()["owner_name"])
        fresh = owner(); fresh.update(mailing_address=None, multi_owner=[])
        before = deepcopy((connection.summaries, connection.parties))
        self.assertTrue(self.persist(connection, fresh))
        self.assertEqual((connection.summaries, connection.parties), before)

    def test_same_membership_incomplete_percentages_preserve_entire_group_not_mixed_percentages(self):
        connection = OwnerConnection(2027, owner()["owner_name"])
        connection.parties = [
            {"tax_year": 2027, "owner_name": "SYNTHETIC PARTY A", "ownership_pct": 60},
            {"tax_year": 2027, "owner_name": "SYNTHETIC PARTY B", "ownership_pct": 40},
        ]
        fresh = owner(); fresh["multi_owner"] = [
            {"owner_name": "synthetic   party a", "ownership_pct": "80%"},
            {"owner_name": "SYNTHETIC PARTY B", "ownership_pct": None},
        ]
        before = deepcopy(connection.parties)
        self.assertTrue(self.persist(connection, fresh))
        self.assertEqual(connection.parties, before, "not 80% from fresh plus 40% from storage")
        detail = synthetic_detail(); detail["owner"] = fresh
        self.assertFalse(verification_presence(parsed_verification_row(detail))["missing_ownership_percentage"])
        # Collapsing a repeated named row must not hide its missing percentage.
        fresh["multi_owner"] = [
            {"owner_name": "SYNTHETIC PARTY A", "ownership_pct": "80%"},
            {"owner_name": "SYNTHETIC PARTY A", "ownership_pct": None},
            {"owner_name": "SYNTHETIC PARTY B", "ownership_pct": "20%"},
        ]
        self.assertTrue(self.persist(connection, fresh))
        self.assertEqual(connection.parties, before)

    def test_complete_same_membership_replaces_with_entire_fresh_group(self):
        connection = OwnerConnection(2027, owner()["owner_name"])
        fresh = owner(); fresh["multi_owner"][0]["ownership_pct"] = "75%"
        self.assertTrue(self.persist(connection, fresh))
        self.assertEqual(connection.parties[0]["ownership_pct"], 75)

    def test_partial_grid_changed_membership_owner_or_year_does_not_inherit_percentages(self):
        for prior_year, prior_name, changed_membership in (
            (2026, owner()["owner_name"], False),
            (2027, "SYNTHETIC OLD OWNER", False),
            (2027, owner()["owner_name"], True),
        ):
            with self.subTest(prior_year=prior_year, prior_name=prior_name, changed_membership=changed_membership):
                connection = OwnerConnection(prior_year, prior_name)
                fresh = owner(); fresh["multi_owner"] = [{
                    "owner_name": "SYNTHETIC DIFFERENT PARTY" if changed_membership else fresh["owner_name"],
                    "ownership_pct": None,
                }]
                self.assertTrue(self.persist(connection, fresh))
                self.assertEqual(len(connection.parties), 1)
                self.assertIsNone(connection.parties[0]["ownership_pct"])
                self.assertEqual(connection.parties[0]["tax_year"], 2027)

    def test_upsert_delegates_original_owner_group_while_values_keep_their_year(self):
        detail = synthetic_detail(); original_owner = detail["owner"]
        session = MagicMock()
        with patch.object(upsert, "_SCHEMA", "core"), patch.object(upsert, "get_engine", return_value=object()), \
             patch.object(upsert, "get_session", return_value=session), patch.object(upsert, "persist_owner_bundle") as save:
            upsert.upsert_parsed(ACCOUNT, detail, {})
        self.assertIs(save.call_args.args[2], original_owner)
        value_calls = [call for call in session.__enter__.return_value.execute.call_args_list
                       if "INSERT INTO core.value_summary" in str(call.args[0])]
        self.assertEqual(len(value_calls), 2)
        self.assertTrue(all(call.args[1]["certified_year"] == 2026 for call in value_calls))


class OwnerProvenanceWarningTests(unittest.TestCase):
    def upsert_warning(self, fresh, saved=False):
        detail = synthetic_detail(); detail["owner"] = fresh
        session = MagicMock()
        with patch.object(upsert, "_SCHEMA", "core"), patch.object(upsert, "get_engine", return_value=object()), \
             patch.object(upsert, "get_session", return_value=session), \
             patch.object(upsert, "persist_owner_bundle", return_value=saved) as save, \
             patch.object(upsert.log, "warning") as warning:
            upsert.upsert_parsed(ACCOUNT, detail, {})
        save.assert_called_once_with(session.__enter__.return_value, ACCOUNT, fresh or {})
        return warning

    def test_refused_meaningful_owner_without_source_year_warns_without_private_values(self):
        fresh = owner(); fresh["source_year"] = None
        warning = self.upsert_warning(fresh)
        warning.assert_called_once()
        message, encoded = warning.call_args.args
        self.assertEqual(message, "Owner persistence skipped: unverified source year %s")
        self.assertEqual(json.loads(encoded), {"account_id": ACCOUNT, "source_year": None,
            "source_heading_year": 2027, "parties_source_heading_year": 2027})
        self.assertNotIn(fresh["owner_name"], encoded)
        self.assertNotIn(fresh["mailing_address"], encoded)

    def test_missing_or_mismatched_heading_warns_with_only_safe_year_primitives(self):
        cases = [
            {"source_heading": None}, {"source_heading": "Owner (Current 2026)"},
            {"parties_source_heading": "Multi-Owner (Current 2026)"},
            {"source_year": "2027", "source_heading": "not an owner heading"},
        ]
        for changes in cases:
            with self.subTest(changes=changes):
                fresh = owner(); fresh.update(changes)
                warning = self.upsert_warning(fresh)
                warning.assert_called_once()
                payload = json.loads(warning.call_args.args[1])
                self.assertEqual(payload["account_id"], ACCOUNT)
                self.assertEqual(payload["source_year"], 2027)
                self.assertTrue(all(value is None or type(value) is int for key, value in payload.items() if key != "account_id"))

    def test_untrusted_diagnostic_values_never_leak_names_addresses_or_unbounded_text(self):
        private = "PRIVATE OWNER 999 PRIVATE STREET\nINJECTED LOG " * 100
        for bad_year in (private, {"owner_name": private}, [private], True, 2027.5, 10000, "0270"):
            with self.subTest(value_type=type(bad_year).__name__):
                fresh = owner(); fresh.update(source_year=bad_year, source_heading=private,
                                               parties_source_heading={"mailing_address": private})
                warning = self.upsert_warning(fresh)
                warning.assert_called_once()
                encoded = warning.call_args.args[1]
                self.assertLess(len(encoded), 200)
                self.assertNotIn("PRIVATE", encoded)
                self.assertNotIn("INJECTED", encoded)
                self.assertNotIn("\n", encoded)
                self.assertEqual(json.loads(encoded), {"account_id": ACCOUNT, "source_year": None,
                    "source_heading_year": None, "parties_source_heading_year": None})

    def test_expected_empty_placeholder_withheld_and_valid_dated_refusals_are_silent(self):
        cases = [None, {}, [], owner(), owner(2026), owner(name=WITHHELD_TEXT)]
        for name in (None, "", "N/A", "UNKNOWN", "NOT REPORTED", "TRUNCATED &", "WITHHELD", "CONFIDENTIAL"):
            fresh = owner(name=name); fresh["source_year"] = None
            cases.append(fresh)
        fresh = owner(); fresh.update(source_year=None, multi_owner=[{"owner_name": WITHHELD_TEXT}])
        cases.append(fresh)
        for fresh in cases:
            with self.subTest(fresh=fresh):
                self.upsert_warning(fresh).assert_not_called()
        fresh = owner(); fresh["source_year"] = None
        self.upsert_warning(fresh, saved=True).assert_not_called()


class OwnerVerificationYearTests(unittest.TestCase):
    def test_field_repair_uses_owner_year_separately_and_rejects_wrong_year(self):
        detail = synthetic_detail(); row = parsed_verification_row(detail)
        row.update(parsed_detail=detail, snapshot_is_fresh=True)
        config = worker.WorkerConfig.from_env(); engine = FakeEngine(row)
        fields = ("owner", "missing_mailing_address", "missing_ownership_percentage", "missing_tax_year")
        self.assertEqual(worker.missing_required_fields(engine, config, ACCOUNT, fields), ())
        sql = engine.calls[0][0]
        self.assertIn(owner_source_year_sql("r"), sql)
        self.assertIn("v.certified_year = r.tax_year", sql)
        row["owner_source_year"] = 2026
        self.assertEqual(worker.missing_required_fields(engine, config, ACCOUNT, fields), fields[:3])
        row.update(owner_source_year=2027, owner_name="DIFFERENT OWNER SAME SOURCE YEAR")
        self.assertEqual(worker.missing_required_fields(engine, config, ACCOUNT, fields), fields[:3])

    def test_owner_recovery_requires_fresh_same_year_same_name_evidence(self):
        detail = synthetic_detail(); row = parsed_verification_row(detail)
        row.update(parsed_detail=detail, snapshot_is_fresh=True)
        config = worker.WorkerConfig.from_env()
        self.assertTrue(worker.owner_name_is_complete(FakeEngine(row), config, ACCOUNT))
        for changes in ({"snapshot_is_fresh": False}, {"owner_source_year": 2026},
                        {"owner_name": "DIFFERENT SYNTHETIC OWNER"}, {"parsed_detail": {}}):
            self.assertFalse(worker.owner_name_is_complete(FakeEngine({**row, **changes}), config, ACCOUNT))


if __name__ == "__main__": unittest.main()

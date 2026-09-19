import sys
import unittest
from contextlib import ExitStack
from copy import deepcopy
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, Mock, patch


SCRAPER_ROOT = Path(__file__).resolve().parents[1] / "scraper"
sys.path.insert(0, str(SCRAPER_ROOT))

from api import main as api  # noqa: E402


ACCOUNT = "12345678901234567"


def fresh_owner(**changes):
    return {
        "owner_name": "FRESH OWNER",
        "mailing_address": "200 NEW ADDRESS, DALLAS TX 75201",
        "multi_owner": [{"owner_name": "FRESH OWNER", "ownership_pct": "100%"}],
        "source_year": 2027,
        "source_heading": "Owner (Current 2027)",
        "parties_source_heading": "Multi-Owner (Current 2027)",
        **changes,
    }


def persisted_owner(**changes):
    return {"owner_name": "FRESH OWNER", "mailing_address": "200 NEW ADDRESS, DALLAS TX 75201",
            "source_year": 2027, "tax_year": 2027,
            "multi_owner": [{"owner_name": "FRESH OWNER", "ownership_pct": 100}], **changes}


def complete_mocked_coroutine(coroutine):
    # Every await is an immediate AsyncMock. Do not construct a Windows asyncio
    # loop: its self-pipe uses a loopback socket, blocked by the offline harness.
    try:
        coroutine.send(None)
    except StopIteration as completed:
        return completed.value
    finally:
        coroutine.close()
    raise AssertionError("Unexpected asynchronous I/O in mocked API test")


class ApiOwnerRefreshTests(unittest.TestCase):
    def refresh(self, parsed_owner, stored_owner=None, persist_result=True, db_owner=None, failure=None):
        stored = {
            "tax_year": 2026,
            "owner": stored_owner if stored_owner is not None else {
                "owner_name": "STORED OLD OWNER", "mailing_address": None,
                "source_year": 2026, "tax_year": 2026,
                "multi_owner": [{"owner_name": "STORED OLD OWNER", "ownership_pct": "50%"}],
            },
            "property_location": {"address": None, "neighborhood": "KEEP NEIGHBORHOOD"},
            "legal_description": {},
            "main_improvement": {"bedroom_count": None, "baths_full": None, "building_class": None},
            "history": {"owner_history": [{"observed_year": 2026}], "exemptions": [{"year": 2026}]},
            "exemptions_table": [{"year": 2026}],
        }
        original = deepcopy(stored)
        parsed = {
            "tax_year": 2026,
            "owner": parsed_owner,
            "property_location": {"address": "10 FRESH SITUS", "neighborhood": "FRESH NEIGHBORHOOD", "mapsco": "A1"},
            "legal_description": {"lines": ["FRESH PLAT", "LOT 10"], "deed_transfer_date": "01/02/2026"},
            "main_improvement": {"bedroom_count": 4, "baths_full": 2, "bath_count": "2", "building_class": "15"},
        }
        engine, reader, writer = MagicMock(), MagicMock(), MagicMock()
        engine.connect.return_value.__enter__.return_value = reader
        engine.begin.return_value.__enter__.return_value = writer
        persisted = deepcopy(db_owner if db_owner is not None else persisted_owner())
        owner_snapshots_before_commit = []

        def before_commit():
            # Assert outside the API's best-effort exception handler so an
            # assertion failure cannot be mistaken for a tolerated SQL failure.
            owner_snapshots_before_commit.append(deepcopy(stored["owner"]))

        def execute(*_args, **_kwargs):
            before_commit()
            if (failure, writer.execute.call_count) in {
                ("before_writer", 1), ("after_writer", 2), ("last_write", 3),
            }:
                raise RuntimeError(f"mock_sql_failure_{failure}")
            return MagicMock()

        def persist_bundle(conn, account_id, _owner):
            before_commit()
            self.assertIs(conn, writer)
            self.assertEqual(account_id, ACCOUNT)
            if failure == "writer":
                raise RuntimeError("mock_owner_writer_failure")
            return persist_result

        def read_persisted_owner(conn, account_id):
            before_commit()
            self.assertIs(conn, writer, "owner is reread on the writer's transaction")
            self.assertEqual(account_id, ACCOUNT)
            if failure == "reread":
                raise RuntimeError("mock_owner_reread_failure")
            return persisted

        def exit_transaction(*_args):
            before_commit()
            if failure == "commit":
                raise RuntimeError("mock_commit_failure")
            return False

        writer.execute.side_effect = execute
        engine.begin.return_value.__exit__.side_effect = exit_transaction
        fetch = AsyncMock(return_value=(
            '<span id="lblOwner">Owner (Current 2027)</span>FRESH DOM OWNER<br>'
            '999 DOM ADDRESS<br>DALLAS TX 75201'
        ))
        history = AsyncMock(side_effect=AssertionError("Unexpected history fetch"))
        persist = Mock(side_effect=persist_bundle)
        read_owner = Mock(side_effect=read_persisted_owner)
        http_client = MagicMock()
        http_client.__aenter__ = AsyncMock(return_value=object())
        http_client.__aexit__ = AsyncMock(return_value=False)
        with ExitStack() as stack:
            for name, value in {
                "_db_engine_or_none": Mock(return_value=engine),
                "_build_detail_from_db": Mock(return_value=stored),
                "parse_detail_html": Mock(return_value=parsed),
                "_fetch_text": fetch,
                "build_history_for_account": history,
                "_persist_owner_bundle": persist,
                "_db_owner": read_owner,
            }.items():
                stack.enter_context(patch.object(api, name, value))
            stack.enter_context(patch.object(api.httpx, "AsyncClient", return_value=http_client))
            result = complete_mocked_coroutine(api.get_detail(ACCOUNT))
        fetch.assert_awaited_once()
        history.assert_not_awaited()
        for snapshot in owner_snapshots_before_commit:
            self.assertEqual(snapshot, original["owner"], "no provisional owner before commit")
        if read_owner.called:
            read_owner.assert_called_once_with(writer, ACCOUNT)
        writer.owner_read = read_owner
        return result.detail, original, parsed, persist, writer

    def test_fresh_owner_replaces_group_and_persists_original_bundle_not_valuation_year(self):
        owner = fresh_owner()
        detail, original, parsed, persist, writer = self.refresh(owner)
        self.assertEqual(detail["owner"], persisted_owner())
        self.assertNotIn(original["owner"]["owner_name"], str(detail["owner"]))
        persist.assert_called_once_with(writer, ACCOUNT, owner)
        writer.owner_read.assert_called_once_with(writer, ACCOUNT)
        self.assertIs(persist.call_args.args[2], parsed["owner"])
        self.assertEqual(detail["tax_year"], 2026)
        self.assertEqual(detail["owner"]["source_year"], 2027)
        sql_calls = [(str(call.args[0]), call.args[1]) for call in writer.execute.call_args_list]
        self.assertEqual(len(sql_calls), 3, "owner SQL belongs only to the shared helper")
        location = next(params for sql, params in sql_calls if "UPDATE" in sql and "accounts" in sql)
        self.assertEqual(location, {"a": "10 FRESH SITUS", "n": "KEEP NEIGHBORHOOD", "m": "A1", "s": "FRESH PLAT", "id": ACCOUNT})
        legal = next(params for sql, params in sql_calls if "legal_description_current" in sql)
        self.assertEqual(legal["tax_year"], 2026)
        primary = next(params for sql, params in sql_calls if "primary_improvements" in sql)
        self.assertEqual(primary["bedroom_count"], 4)
        self.assertEqual(primary["baths_full"], 2)
        self.assertEqual(primary["building_class"], "15")
        self.assertFalse(any("owner_summary" in sql or "owner_parties" in sql for sql, _ in sql_calls))

    def test_changed_owner_does_not_inherit_stored_mailing_or_parties(self):
        stored = {"owner_name": "OLD OWNER", "mailing_address": "OLD MAILING", "source_year": 2027,
                  "multi_owner": [{"owner_name": "OLD OWNER", "ownership_pct": "100%"}]}
        owner = fresh_owner(mailing_address=None, multi_owner=[])
        persisted = persisted_owner(mailing_address=None, multi_owner=[])
        detail, _, _, persist, _ = self.refresh(owner, stored, db_owner=persisted)
        self.assertEqual(detail["owner"], persisted)
        self.assertIsNone(detail["owner"]["mailing_address"])
        self.assertEqual(detail["owner"]["multi_owner"], [])
        persist.assert_called_once()

    def test_unproven_withheld_and_partial_owner_preserve_existing_group_without_writes(self):
        cases = [
            {},
            fresh_owner(source_year=None),
            fresh_owner(source_heading=None),
            fresh_owner(source_heading="Owner (Current 2026)"),
            fresh_owner(parties_source_heading="Multi-Owner (Current 2026)"),
            fresh_owner(owner_name=None),
            fresh_owner(owner_name="N/A"),
            fresh_owner(owner_name="TRUNCATED &"),
            fresh_owner(owner_name="CONFIDENTIAL"),
            fresh_owner(owner_name="OWNER WITHHELD PER SEC.# 25.025 OR 25.026 OF TEXAS PROPERTY TAX CODE"),
            fresh_owner(multi_owner=[{"owner_name": "WITHHELD", "ownership_pct": None}]),
            fresh_owner(multi_owner={"malformed": "parties"}),
            fresh_owner(multi_owner=[None]),
            fresh_owner(multi_owner=[{"owner_name": "TRUNCATED PARTY &"}]),
        ]
        for owner in cases:
            with self.subTest(owner=owner):
                detail, original, _, persist, _ = self.refresh(owner)
                self.assertEqual(detail["owner"], original["owner"])
                self.assertIsNone(detail["owner"]["mailing_address"], "no standalone DOM mailing blend")
                persist.assert_not_called()
                self.assertEqual(detail["tax_year"], 2026)
                self.assertEqual(detail["property_location"]["address"], "10 FRESH SITUS")

    def test_older_fresh_owner_cannot_replace_newer_stored_owner(self):
        for year_key in ("source_year", "tax_year"):
            with self.subTest(year_key=year_key):
                stored = {"owner_name": "NEWER STORED OWNER", "mailing_address": "KEEP MAILING", year_key: 2028}
                detail, original, _, persist, _ = self.refresh(fresh_owner(), stored)
                self.assertEqual(detail["owner"], original["owner"])
                persist.assert_not_called()

    def test_persistence_refusal_preserves_snapshot_owner_group_without_rereading(self):
        detail, original, _, persist, writer = self.refresh(fresh_owner(), persist_result=False)
        persist.assert_called_once()
        writer.owner_read.assert_not_called()
        self.assertEqual(detail["owner"], original["owner"])
        self.assertEqual(detail["tax_year"], 2026)

    def test_same_owner_partial_refresh_returns_persisted_mailing_and_party_percentages(self):
        stored = persisted_owner(mailing_address="PRESERVED NORMALIZED MAILING",
                                multi_owner=[{"owner_name": "FRESH OWNER", "ownership_pct": 75}])
        raw = fresh_owner(mailing_address=None, multi_owner=[{"owner_name": "FRESH OWNER", "ownership_pct": None}])
        detail, _, _, persist, writer = self.refresh(raw, stored, db_owner=stored)
        persist.assert_called_once_with(writer, ACCOUNT, raw)
        writer.owner_read.assert_called_once_with(writer, ACCOUNT)
        self.assertEqual(detail["owner"], stored)
        self.assertNotEqual(detail["owner"], raw)

    def test_owner_response_preserves_snapshot_on_write_read_or_commit_failure(self):
        for failure in ("before_writer", "writer", "reread", "after_writer", "last_write", "commit"):
            with self.subTest(failure=failure):
                detail, original, _, persist, writer = self.refresh(fresh_owner(), failure=failure)
                self.assertEqual(detail["owner"], original["owner"])
                self.assertEqual(detail["tax_year"], 2026)
                if failure == "before_writer":
                    persist.assert_not_called()
                else:
                    persist.assert_called_once()
                if failure in ("before_writer", "writer"):
                    writer.owner_read.assert_not_called()
                else:
                    writer.owner_read.assert_called_once_with(writer, ACCOUNT)

    def test_ineligible_owner_never_reaches_writer_even_when_other_sql_fails(self):
        for raw in (fresh_owner(owner_name="TRUNCATED &"), fresh_owner(multi_owner={"malformed": "parties"}),
                    fresh_owner(multi_owner=[{"owner_name": "PARTY &"}])):
            for failure in ("before_writer", "after_writer", "commit"):
                with self.subTest(raw=raw, failure=failure):
                    detail, original, _, persist, writer = self.refresh(raw, failure=failure)
                    persist.assert_not_called()
                    writer.owner_read.assert_not_called()
                    self.assertEqual(detail["owner"], original["owner"])


class ApiStoredOwnerYearTests(unittest.TestCase):
    def test_parties_bind_to_selected_summary_year_not_independent_latest_year(self):
        conn = MagicMock()
        summary = MagicMock()
        summary.mappings.return_value.first.return_value = {
            "owner_name": "SELECTED OWNER", "mailing_address": "MAIL", "tax_year": 2027,
        }
        parties = MagicMock()
        parties.mappings.return_value.all.return_value = [{"owner_name": "SELECTED OWNER", "ownership_pct": "100"}]
        conn.execute.side_effect = [summary, parties]
        owner = api._db_owner(conn, ACCOUNT)
        self.assertEqual(owner["source_year"], 2027)
        self.assertEqual(owner["tax_year"], 2027)
        self.assertEqual(owner["multi_owner"][0]["owner_name"], "SELECTED OWNER")
        self.assertEqual(conn.execute.call_count, 2)
        sql, params = conn.execute.call_args.args
        self.assertIn("tax_year=:ty", str(sql))
        self.assertEqual(params, {"id": ACCOUNT, "ty": 2027})
        self.assertFalse(any("MAX(tax_year)" in str(call.args[0]) for call in conn.execute.call_args_list))

    def test_missing_summary_does_not_attach_unbound_parties(self):
        conn = MagicMock()
        conn.execute.return_value.mappings.return_value.first.return_value = None
        self.assertIsNone(api._db_owner(conn, ACCOUNT))
        self.assertEqual(conn.execute.call_count, 1)


if __name__ == "__main__":
    unittest.main()

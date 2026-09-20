from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch


SCRAPER_ROOT = Path(__file__).resolve().parents[1] / "scraper"
sys.path.insert(0, str(SCRAPER_ROOT))

from dcad import worker  # noqa: E402


ACCOUNT_ID = "26272500060150000"


def healthy_detail() -> dict[str, object]:
    return {
        "property_location": {"address": "1909 SNOWMASS LN"},
        "owner": {"owner_name": "PATTERSON GREGORY SCOTT & GINA R"},
        "value_summary": {"market_value": "$216,000"},
    }


def healthy_history() -> dict[str, object]:
    row = {"year": 2026}
    return {
        "owner_history": [row],
        "market_value": [row],
        "taxable_value": [row],
        "exemptions": [row],
    }


class ParserCanaryValidationTests(unittest.TestCase):
    def test_known_good_account_requires_detail_and_all_history_sections(self) -> None:
        result = worker.validate_parser_canary_result(
            healthy_detail(), healthy_history()
        )
        self.assertTrue(result["address_present"])
        self.assertEqual(result["history_counts"]["owner_history"], 1)

    def test_missing_critical_fields_fail_closed(self) -> None:
        detail = healthy_detail()
        detail["owner"] = {}
        history = healthy_history()
        history["market_value"] = []
        with self.assertRaisesRegex(
            worker.ParserCanaryError,
            "missing_owner_name,missing_market_value",
        ):
            worker.validate_parser_canary_result(detail, history)

    def test_default_canary_is_the_existing_health_account(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            config = worker.WorkerConfig.from_env()
        self.assertEqual(config.parser_canary_account_ids, (ACCOUNT_ID,))
        self.assertEqual(config.parser_canary_interval_hours, 24)
        self.assertEqual(config.parser_canary_retry_minutes, 15)
        self.assertEqual(config.parser_canary_poll_seconds, 60)

    def test_invalid_canary_account_id_fails_configuration(self) -> None:
        with patch.dict(
            os.environ,
            {"SCRAPE_CANARY_ACCOUNT_IDS": "not-an-account"},
            clear=True,
        ):
            with self.assertRaisesRegex(ValueError, "17-digit Dallas"):
                worker.WorkerConfig.from_env()

    @patch.object(worker, "parse_history_html", return_value=healthy_history())
    @patch.object(worker, "parse_detail_html", return_value=healthy_detail())
    @patch.object(worker, "get_history_html", return_value="history")
    @patch.object(worker, "get_detail_html", return_value="detail")
    @patch.object(worker, "polite_pause")
    @patch.object(worker, "browser")
    def test_canary_fetches_and_parses_without_upserting(
        self,
        browser_mock,
        _pause,
        detail_fetch,
        history_fetch,
        detail_parse,
        history_parse,
    ) -> None:
        page = browser_mock.return_value.__enter__.return_value
        result = worker.run_parser_canary(ACCOUNT_ID)
        detail_fetch.assert_called_once_with(page, ACCOUNT_ID)
        history_fetch.assert_called_once_with(page, ACCOUNT_ID)
        detail_parse.assert_called_once_with("detail")
        history_parse.assert_called_once_with("history")
        self.assertTrue(result["owner_name_present"])


class ParserCanaryPersistenceTests(unittest.TestCase):
    def setUp(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            self.config = worker.WorkerConfig.from_env()

    def test_claim_is_leased_with_skip_locked(self) -> None:
        engine = MagicMock()
        connection = engine.begin.return_value.__enter__.return_value
        connection.execute.return_value.mappings.return_value.first.return_value = {
            "account_id": ACCOUNT_ID
        }
        self.assertEqual(
            worker.claim_due_parser_canary(engine, self.config, "worker-a"),
            ACCOUNT_ID,
        )
        statement, params = connection.execute.call_args.args
        sql = str(statement)
        self.assertIn("FOR UPDATE SKIP LOCKED", sql)
        self.assertIn("SET status = 'leased'", sql)
        self.assertEqual(params["lease_minutes"], self.config.lease_minutes)

    def test_success_schedules_the_next_daily_run(self) -> None:
        engine = MagicMock()
        connection = engine.begin.return_value.__enter__.return_value
        worker.mark_parser_canary_success(
            engine, self.config, ACCOUNT_ID, {"address_present": True}
        )
        statement, params = connection.execute.call_args.args
        sql = str(statement)
        self.assertIn("SET status = 'passed'", sql)
        self.assertIn("consecutive_failures = 0", sql)
        self.assertEqual(params["interval_hours"], 24)

    def test_failure_blocks_and_retries_without_page_content(self) -> None:
        engine = MagicMock()
        connection = engine.begin.return_value.__enter__.return_value
        worker.mark_parser_canary_failure(
            engine,
            self.config,
            ACCOUNT_ID,
            worker.ParserCanaryError("parser_canary_failed:missing_owner_name"),
        )
        statement, params = connection.execute.call_args.args
        sql = str(statement)
        self.assertIn("SET status = 'failed'", sql)
        self.assertIn("last_result = '{}'::jsonb", sql)
        self.assertEqual(params["retry_minutes"], 15)
        self.assertNotIn("PATTERSON", params["last_error"])


if __name__ == "__main__":
    unittest.main()

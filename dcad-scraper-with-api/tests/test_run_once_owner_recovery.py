import ast
import inspect
import sys
import unittest
from contextlib import ExitStack
from copy import deepcopy
from pathlib import Path
from unittest.mock import MagicMock, Mock, patch


SCRAPER_ROOT = Path(__file__).resolve().parents[1] / "scraper"
sys.path.insert(0, str(SCRAPER_ROOT))

from dcad import run_once  # noqa: E402


class RunOnceOwnerRecoveryTests(unittest.TestCase):
    account_id = "12345678901234567"

    def scrape_with_mocks(self, detail, history):
        calls = Mock()
        browser = MagicMock()
        mocks = {
            "browser": browser,
            "get_detail_html": Mock(return_value="<html>usable detail</html>"),
            "get_history_html": Mock(return_value="<html>usable history</html>"),
            "polite_pause": Mock(),
            "parse_detail_html": Mock(return_value=detail),
            "parse_history_html": Mock(return_value=history),
            "repair_owner_from_history": Mock(wraps=run_once.repair_owner_from_history),
            "_save_raw_json": Mock(),
            "upsert_parsed": Mock(),
        }
        for name in ("repair_owner_from_history", "_save_raw_json", "upsert_parsed"):
            calls.attach_mock(mocks[name], name)
        with ExitStack() as stack:
            for name, mock in mocks.items():
                stack.enter_context(patch.object(run_once, name, mock))
            assessment = run_once.run_for_account(self.account_id)
        self.assertTrue(assessment.complete)
        self.assertEqual(
            [call[0] for call in calls.mock_calls],
            ["repair_owner_from_history", "_save_raw_json", "upsert_parsed"],
        )
        mocks["get_detail_html"].assert_called_once()
        mocks["get_history_html"].assert_called_once()
        mocks["repair_owner_from_history"].assert_called_once_with(detail, history)
        mocks["upsert_parsed"].assert_called_once_with(self.account_id, detail, history)
        snapshot = mocks["_save_raw_json"].call_args.args[3]
        self.assertEqual(snapshot["detail"], detail)
        self.assertEqual(snapshot["history"], history)
        return mocks

    def test_recovers_owner_from_history_before_saving_once(self):
        detail = {
            "tax_year": 2026,
            "property_location": {"address": "100 SAMPLE LN"},
            "value_summary": {"market_value": 300000},
            "owner": {
                "source_year": 2027, "source_heading": "Owner (Current 2027)",
                "owner_name": "EXAMPLE AVERY &",
                "mailing_address": "100 SAMPLE LN, DALLAS, TEXAS 752010001",
                "multi_owner": [
                    {"owner_name": "EXAMPLE AVERY &", "ownership_pct": "100%"}
                ],
            },
        }
        history = {"owner_history": [{"observed_year": 2027, "owner_lines": [
            "EXAMPLE AVERY & MORGAN 100 SAMPLE LN DALLAS TEXAS 752010001"
        ]}]}
        self.scrape_with_mocks(detail, history)
        self.assertEqual(detail["owner"]["owner_name"], "EXAMPLE AVERY & MORGAN")
        self.assertEqual(
            detail["owner"]["multi_owner"][0]["owner_name"],
            "EXAMPLE AVERY & MORGAN",
        )

    def test_keeps_healthy_parsed_outputs_unchanged(self):
        detail = {
            "tax_year": 2026,
            "property_location": {"address": "200 DEMO DR"},
            "value_summary": {"market_value": 500000, "certified_year": 2026},
            "owner": {
                "owner_name": "EXAMPLE MORGAN & JAMIE",
                "mailing_address": "200 DEMO DR, DALLAS, TEXAS 752010002",
                "multi_owner": [
                    {"owner_name": "EXAMPLE MORGAN & JAMIE", "ownership_pct": "100%"}
                ],
            },
        }
        history = {"owner_history": []}
        original = deepcopy((detail, history))
        self.scrape_with_mocks(detail, history)
        self.assertEqual((detail, history), original)

    def test_prior_year_history_never_becomes_current_owner_before_raw_save(self):
        detail = {
            "tax_year": 2026,
            "property_location": {"address": "100 SAMPLE LN"},
            "value_summary": {"market_value": 300000},
            "owner": {
                "source_year": 2027, "source_heading": "Owner (Current 2027)",
                "owner_name": "SYNTHETIC AVERY &",
                "mailing_address": "100 SAMPLE LN, DALLAS TX 75201",
                "multi_owner": [{"owner_name": "SYNTHETIC AVERY &", "ownership_pct": "100%"}],
            },
        }
        history = {"owner_history": [{"observed_year": 2026, "owner_lines": [
            "SYNTHETIC AVERY & MORGAN 100 SAMPLE LN DALLAS TX 75201"
        ]}]}
        original = deepcopy((detail, history))
        self.scrape_with_mocks(detail, history)
        self.assertEqual((detail, history), original)

    def test_module_has_one_runner_and_one_cli_entrypoint(self):
        module = ast.parse(inspect.getsource(run_once))
        runners = [node for node in module.body
                   if isinstance(node, ast.FunctionDef) and node.name == "run_for_account"]
        main_guards = [node for node in module.body
                       if isinstance(node, ast.If)
                       and ast.unparse(node.test) == "__name__ == '__main__'"]
        self.assertEqual(len(runners), 1)
        self.assertEqual(len(main_guards), 1)


if __name__ == "__main__":
    unittest.main()

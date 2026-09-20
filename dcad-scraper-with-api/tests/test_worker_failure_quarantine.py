from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch


SCRAPER_ROOT = Path(__file__).resolve().parents[1] / "scraper"
sys.path.insert(0, str(SCRAPER_ROOT))

from dcad.fetch import DcadResponseValidationError  # noqa: E402
from dcad.worker import (  # noqa: E402
    FailureDisposition,
    WorkerConfig,
    campaign_status,
    claim_next_account,
    deterministic_failure_fingerprint,
    mark_failure,
)


class DeterministicFailureClassificationTests(unittest.TestCase):
    def test_only_response_validation_errors_receive_a_fingerprint(self) -> None:
        error = DcadResponseValidationError("dcad_detail_account_identity_mismatch")
        first = deterministic_failure_fingerprint(error)
        second = deterministic_failure_fingerprint(
            DcadResponseValidationError("dcad_detail_account_identity_mismatch")
        )
        self.assertEqual(first, second)
        self.assertEqual(len(first or ""), 64)
        self.assertIsNone(deterministic_failure_fingerprint(TimeoutError("offline")))
        self.assertIsNone(deterministic_failure_fingerprint(ValueError("parser")))

    def test_config_uses_three_identical_failures_and_safe_minimum(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(
                WorkerConfig.from_env().deterministic_failure_threshold, 3
            )
        with patch.dict(
            os.environ,
            {"SCRAPE_DETERMINISTIC_FAILURE_ATTEMPTS": "1"},
            clear=True,
        ):
            self.assertEqual(
                WorkerConfig.from_env().deterministic_failure_threshold, 2
            )


class DeterministicFailurePersistenceTests(unittest.TestCase):
    def setUp(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            self.config = WorkerConfig.from_env()

    def test_third_identical_rejection_is_returned_as_manual_review(self) -> None:
        engine = MagicMock()
        connection = engine.begin.return_value.__enter__.return_value
        update = MagicMock()
        update.mappings.return_value.one.return_value = {
            "status": "manual_review",
            "consecutive_deterministic_failures": 3,
        }
        connection.execute.side_effect = [update, MagicMock()]

        outcome = mark_failure(
            engine,
            self.config,
            "00000792229000000",
            2,
            DcadResponseValidationError("dcad_detail_account_identity_mismatch"),
        )

        self.assertEqual(
            outcome,
            FailureDisposition(
                delay_seconds=1200,
                status="manual_review",
                consecutive_deterministic_failures=3,
            ),
        )
        statement, params = connection.execute.call_args_list[0].args
        sql = str(statement)
        self.assertIn("status = CASE", sql)
        self.assertIn("THEN 'manual_review'", sql)
        self.assertIn("failure_fingerprint = :failure_fingerprint", sql)
        self.assertIn("manual_review_reason", sql)
        self.assertEqual(params["failure_threshold"], 3)
        self.assertEqual(len(params["failure_fingerprint"]), 64)

    def test_transient_failure_resets_deterministic_counter_and_retries(self) -> None:
        engine = MagicMock()
        connection = engine.begin.return_value.__enter__.return_value
        update = MagicMock()
        update.mappings.return_value.one.return_value = {
            "status": "retry",
            "consecutive_deterministic_failures": 0,
        }
        connection.execute.side_effect = [update, MagicMock()]

        outcome = mark_failure(
            engine,
            self.config,
            "00000792229000000",
            0,
            TimeoutError("offline"),
        )

        self.assertFalse(outcome.quarantined)
        params = connection.execute.call_args_list[0].args[1]
        self.assertIsNone(params["failure_fingerprint"])

    def test_claim_excludes_manual_review_until_an_operator_requeues_it(self) -> None:
        engine = MagicMock()
        connection = engine.begin.return_value.__enter__.return_value
        connection.execute.return_value.mappings.return_value.first.return_value = None

        self.assertIsNone(claim_next_account(engine, self.config, "worker-a"))

        sql = str(connection.execute.call_args.args[0])
        self.assertIn(
            "NOT IN ('disabled', 'manual_review')",
            sql,
        )

    def test_campaign_status_exposes_manual_review_count(self) -> None:
        source = Path(
            campaign_status.__code__.co_filename
        ).read_text(encoding="utf-8")
        self.assertIn("AS manual_review_targets", source)

    def test_success_clears_prior_quarantine_evidence(self) -> None:
        source = Path(
            mark_failure.__code__.co_filename
        ).read_text(encoding="utf-8")
        self.assertIn("failure_fingerprint = NULL", source)
        self.assertIn("manual_review_at = NULL", source)
        self.assertIn("manual_review_reason = NULL", source)


if __name__ == "__main__":
    unittest.main()

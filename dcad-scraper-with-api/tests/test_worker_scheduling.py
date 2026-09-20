from __future__ import annotations

import os
import sys
import unittest
from contextlib import ExitStack
from dataclasses import replace
from pathlib import Path
from unittest.mock import MagicMock, Mock, patch


SCRAPER_ROOT = Path(__file__).resolve().parents[1] / "scraper"
sys.path.insert(0, str(SCRAPER_ROOT))

from dcad import worker  # noqa: E402


QUEUE_NAMES = ("owner_recovery", "field_repair", "reconciliation", "market_value_recheck")
CLAIMS = (
    ("owner-account", 0),
    ("field-account", 0, ("owner",)),
    {"source_account_id": "reconciliation-account"},
    ("market-account", 0),
)
PROCESS_NAMES = (
    "process_owner_recovery_safely",
    "process_field_repair_safely",
    "process_reconciliation_claim_safely",
    "process_market_value_recheck_safely",
)


class IdleQueueFairnessTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        with patch.dict(os.environ, {}, clear=True):
            self.config = worker.WorkerConfig.from_env()
        self.engine = object()
        self.processed = []
        self.claimers = []
        for index, name in enumerate(QUEUE_NAMES):
            self.claimers.append(self.stack.enter_context(patch.object(
                worker, f"claim_next_{name}", return_value=CLAIMS[index]
            )))
            self.stack.enter_context(patch.object(
                worker, PROCESS_NAMES[index],
                side_effect=lambda *_args, queue=name: self.processed.append(queue),
            ))

    def test_continuously_busy_queues_each_get_one_turn_per_round(self):
        cursor = 0
        for _ in range(8):
            cursor = worker.process_next_idle_auxiliary(
                self.engine, self.config, "worker", cursor
            )
        self.assertEqual(self.processed, list(QUEUE_NAMES) * 2)
        self.assertEqual(cursor, 0)

    def test_busy_field_queue_cannot_starve_reconciliation_or_market_value(self):
        self.claimers[0].return_value = None
        cursor = 0
        for _ in range(6):
            cursor = worker.process_next_idle_auxiliary(
                self.engine, self.config, "worker", cursor
            )
        self.assertEqual(self.processed, list(QUEUE_NAMES[1:]) * 2)

    def test_empty_queues_are_skipped_and_only_one_claim_is_processed(self):
        for claimer in self.claimers[:3]:
            claimer.return_value = None
        cursor = worker.process_next_idle_auxiliary(self.engine, self.config, "worker", 1)
        self.assertEqual(cursor, 0)
        self.assertEqual(self.processed, ["market_value_recheck"])
        self.claimers[0].assert_not_called()

    def test_no_due_work_returns_none_without_processing(self):
        for claimer in self.claimers:
            claimer.return_value = None
        self.assertIsNone(worker.process_next_idle_auxiliary(
            self.engine, self.config, "worker", 2
        ))
        self.assertEqual(self.processed, [])
        for claimer in self.claimers:
            claimer.assert_called_once_with(self.engine, self.config, "worker")


class WorkerSchedulingTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.dict(os.environ, {"DATABASE_URL": "not-used"}))
        self.stack.enter_context(patch.object(worker, "_stop_requested", False))
        self.config = replace(worker.WorkerConfig.from_env(), auto_migrate=False)
        self.engine = object()
        self.stack.enter_context(patch.object(worker, "get_engine", return_value=self.engine))
        for name in ("verify_state_schema", "bootstrap_existing_successes", "target_account_count"):
            self.stack.enter_context(patch.object(worker, name, return_value=0))
        self.stack.enter_context(patch.object(worker, "campaign_status", return_value={}))
        self.stack.enter_context(
            patch.object(worker, "seed_parser_canaries", return_value=0)
        )
        self.stack.enter_context(
            patch.object(worker, "claim_due_parser_canary", return_value=None)
        )
        self.stack.enter_context(
            patch.object(
                worker,
                "parser_canary_status",
                return_value={"blocked": False},
            )
        )
        self.sleep = self.stack.enter_context(patch.object(worker, "_sleep"))
        self.advance = self.stack.enter_context(patch.object(
            worker, "advance_campaign_if_complete", return_value=None
        ))
        self.main_claim = self.stack.enter_context(patch.object(
            worker, "claim_next_account", return_value=None
        ))
        self.idle = self.stack.enter_context(patch.object(
            worker, "process_next_idle_auxiliary", return_value=None
        ))
        self.claimers = [self.stack.enter_context(patch.object(
            worker, f"claim_next_{name}", return_value=None
        )) for name in QUEUE_NAMES]

    def test_once_checks_campaign_completion_before_idle_repairs(self):
        calls = Mock()
        calls.attach_mock(self.advance, "advance")
        calls.attach_mock(self.idle, "idle")
        self.idle.return_value = 1
        self.assertEqual(worker.run_worker(self.config, once=True), 0)
        self.assertEqual([call[0] for call in calls.mock_calls], ["advance", "idle"])
        self.sleep.assert_not_called()

    def test_completed_campaign_advances_even_with_idle_repairs_waiting(self):
        self.advance.return_value = {"event_type": "initial_missing_complete"}
        self.assertEqual(worker.run_worker(self.config, once=True), 0)
        self.idle.assert_not_called()
        for claimer in self.claimers:
            claimer.assert_not_called()

    def test_continuous_idle_cursor_is_preserved_across_iterations(self):
        self.idle.side_effect = [1, 2, 3, 0]
        def stop_after_four_sleeps(*_args):
            if self.sleep.call_count == 4:
                worker._stop_requested = True
        self.sleep.side_effect = stop_after_four_sleeps
        self.assertEqual(worker.run_worker(self.config), 0)
        self.assertEqual([call.args[3] for call in self.idle.call_args_list], [0, 1, 2, 3])
        self.assertEqual(self.advance.call_count, 4)

    def test_once_with_main_work_does_not_process_auxiliary_work(self):
        self.main_claim.return_value = ("main-account", 0)
        scrape = self.stack.enter_context(patch.object(worker, "run_for_account"))
        self.stack.enter_context(patch.object(worker, "mark_success", return_value=False))
        self.assertEqual(worker.run_worker(self.config, once=True), 0)
        scrape.assert_called_once_with("main-account")
        self.advance.assert_not_called()
        self.idle.assert_not_called()
        for claimer in self.claimers:
            claimer.assert_not_called()

    def test_normal_main_account_cadence_is_unchanged(self):
        config = replace(
            self.config, owner_recovery_every_accounts=3, field_repair_every_accounts=2,
            recovery_every_accounts=4, market_value_recheck_every_accounts=5,
        )
        self.main_claim.return_value = ("main-account", 0)
        processed = []
        main_count = 0
        def scrape(_account_id):
            nonlocal main_count
            main_count += 1
            processed.append("main")
            if main_count == 6:
                worker._stop_requested = True
        self.stack.enter_context(patch.object(worker, "run_for_account", side_effect=scrape))
        self.stack.enter_context(patch.object(worker, "mark_success", return_value=False))
        for index, name in enumerate(QUEUE_NAMES):
            self.claimers[index].return_value = CLAIMS[index]
            self.stack.enter_context(patch.object(
                worker, PROCESS_NAMES[index],
                side_effect=lambda *_args, queue=name: processed.append(queue),
            ))
        self.assertEqual(worker.run_worker(config), 0)
        self.assertEqual(processed, [
            "owner_recovery", "field_repair", "reconciliation", "main", "main",
            "field_repair", "main", "owner_recovery", "main", "field_repair",
            "reconciliation", "main", "market_value_recheck", "main",
        ])
        self.advance.assert_not_called()
        self.idle.assert_not_called()


class CampaignCompletionAndOutageTests(unittest.TestCase):
    def setUp(self):
        with patch.dict(os.environ, {}, clear=True):
            self.config = worker.WorkerConfig.from_env()

    def completion_engine(self, phase, remaining):
        engine = MagicMock()
        connection = engine.begin.return_value.__enter__.return_value
        campaign = MagicMock()
        campaign.mappings.return_value.first.return_value = {
            "phase": phase, "cycle_number": 2, "total_valid_targets": 558534,
            "initial_missing_count": 558534,
        }
        targets = MagicMock()
        targets.scalar_one.return_value = remaining
        connection.execute.side_effect = [campaign, targets, MagicMock(), MagicMock()]
        return engine, connection

    def test_unfinished_initial_targets_prevent_false_completion(self):
        engine, connection = self.completion_engine("initial_missing", True)
        self.assertIsNone(worker.advance_campaign_if_complete(engine, self.config))
        self.assertEqual(connection.execute.call_count, 2)
        sql = str(connection.execute.call_args_list[1].args[0])
        self.assertIn("SELECT EXISTS", sql)
        self.assertIn("WHERE initial_missing", sql)
        self.assertIn("initial_completed_at IS NULL", sql)
        self.assertNotIn("status", sql)

    def test_unfinished_full_cycle_targets_prevent_false_completion(self):
        engine, connection = self.completion_engine("full_cycle", True)
        self.assertIsNone(worker.advance_campaign_if_complete(engine, self.config))
        self.assertEqual(connection.execute.call_count, 2)
        query = connection.execute.call_args_list[1]
        self.assertIn("last_completed_cycle < :cycle_number", str(query.args[0]))
        self.assertEqual(query.args[1], {"cycle_number": 2})

    def test_complete_initial_targets_transition_without_querying_aux_queues(self):
        engine, connection = self.completion_engine("initial_missing", False)
        event = worker.advance_campaign_if_complete(engine, self.config)
        self.assertEqual(event["event_type"], "initial_missing_complete")
        self.assertEqual(event["next_cycle_number"], 1)
        self.assertEqual(connection.execute.call_count, 4)
        self.assertNotIn("repair_queue", " ".join(str(c.args[0]) for c in connection.execute.call_args_list))

    def test_complete_full_cycle_advances_exactly_one_cycle(self):
        engine, connection = self.completion_engine("full_cycle", False)
        event = worker.advance_campaign_if_complete(engine, self.config)
        self.assertEqual(event["event_type"], "full_cycle_complete")
        self.assertEqual(event["next_cycle_number"], 3)
        self.assertEqual(connection.execute.call_count, 4)

    def test_reconciliation_claim_honors_campaign_outage_gate_and_due_time(self):
        engine = MagicMock()
        connection = engine.begin.return_value.__enter__.return_value
        connection.execute.return_value.mappings.return_value.first.return_value = None
        self.assertIsNone(worker.claim_next_reconciliation(engine, self.config, "worker"))
        statement, params = connection.execute.call_args.args
        sql = str(statement)
        self.assertIn("c.campaign_key = :campaign_key", sql)
        self.assertIn("c.outage_paused_until IS NULL", sql)
        self.assertIn("next_attempt_at <= now()", sql)
        self.assertIn("FOR UPDATE SKIP LOCKED", sql)
        self.assertEqual(params["campaign_key"], self.config.campaign_key)


if __name__ == "__main__":
    unittest.main()

from __future__ import annotations

import os
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

import requests


SCRAPER_ROOT = Path(__file__).resolve().parents[1] / "scraper"
sys.path.insert(0, str(SCRAPER_ROOT))

from dcad.worker import (  # noqa: E402
    WorkerConfig,
    is_upstream_outage_error,
    record_upstream_failure,
    reset_outage_circuit,
    should_pause_for_outage,
)


class FakeResult:
    def __init__(self, row: dict[str, object] | None = None) -> None:
        self.row = row

    def mappings(self) -> "FakeResult":
        return self

    def first(self) -> dict[str, object] | None:
        return self.row


class FakeConnection:
    def __init__(self, rows: list[dict[str, object] | None]) -> None:
        self.rows = list(rows)
        self.calls: list[dict[str, object]] = []

    def execute(self, _statement: object, parameters: dict[str, object]) -> FakeResult:
        self.calls.append(parameters)
        row = self.rows.pop(0) if self.rows else None
        return FakeResult(row)


class FakeTransaction:
    def __init__(self, connection: FakeConnection) -> None:
        self.connection = connection

    def __enter__(self) -> FakeConnection:
        return self.connection

    def __exit__(self, *_args: object) -> None:
        return None


class FakeEngine:
    def __init__(self, rows: list[dict[str, object] | None]) -> None:
        self.connection = FakeConnection(rows)

    def begin(self) -> FakeTransaction:
        return FakeTransaction(self.connection)


class UpstreamOutageClassificationTests(unittest.TestCase):
    def test_connection_and_timeout_failures_are_upstream_outages(self) -> None:
        self.assertTrue(is_upstream_outage_error(requests.Timeout("timed out")))
        self.assertTrue(is_upstream_outage_error(requests.ConnectionError("offline")))

    def test_nested_connection_failure_is_detected(self) -> None:
        try:
            try:
                raise requests.ConnectionError("dns unavailable")
            except requests.ConnectionError as cause:
                raise RuntimeError("scrape failed") from cause
        except RuntimeError as error:
            self.assertTrue(is_upstream_outage_error(error))

    def test_rate_limit_and_server_errors_are_upstream_outages(self) -> None:
        for status_code in (408, 425, 429, 500, 502, 503, 504):
            with self.subTest(status_code=status_code):
                response = requests.Response()
                response.status_code = status_code
                error = requests.HTTPError(response=response)
                self.assertTrue(is_upstream_outage_error(error))

    def test_property_and_application_errors_do_not_open_the_circuit(self) -> None:
        response = requests.Response()
        response.status_code = 404
        self.assertFalse(
            is_upstream_outage_error(requests.HTTPError(response=response))
        )
        self.assertFalse(is_upstream_outage_error(ValueError("invalid property")))


class OutageCircuitDecisionTests(unittest.TestCase):
    def test_threshold_opens_the_circuit(self) -> None:
        self.assertFalse(should_pause_for_outage(4, 5, False))
        self.assertTrue(should_pause_for_outage(5, 5, False))

    def test_failed_recovery_probe_reopens_immediately(self) -> None:
        self.assertTrue(should_pause_for_outage(1, 5, True))

    def test_config_has_conservative_defaults_and_minimums(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            config = WorkerConfig.from_env()
        self.assertEqual(config.outage_failure_threshold, 5)
        self.assertEqual(config.outage_pause_seconds, 300)

        with patch.dict(
            os.environ,
            {
                "SCRAPE_OUTAGE_FAILURE_THRESHOLD": "1",
                "SCRAPE_OUTAGE_PAUSE_SECONDS": "1",
            },
            clear=True,
        ):
            config = WorkerConfig.from_env()
        self.assertEqual(config.outage_failure_threshold, 2)
        self.assertEqual(config.outage_pause_seconds, 30)

    def test_fifth_shared_upstream_failure_opens_the_pause(self) -> None:
        config = WorkerConfig.from_env()
        engine = FakeEngine(
            [
                {
                    "upstream_failure_count": 4,
                    "outage_paused_until": None,
                    "outage_probe_worker_id": None,
                },
                None,
            ]
        )
        result = record_upstream_failure(
            engine, config, "worker-a", requests.Timeout("offline")
        )
        self.assertTrue(result["paused"])
        self.assertTrue(result["transitioned"])
        self.assertEqual(result["failure_count"], 5)
        self.assertEqual(
            engine.connection.calls[1]["pause_seconds"],
            config.outage_pause_seconds,
        )

    def test_failed_shared_probe_reopens_without_waiting_for_threshold(self) -> None:
        config = WorkerConfig.from_env()
        engine = FakeEngine(
            [
                {
                    "upstream_failure_count": 0,
                    "outage_paused_until": datetime.now(timezone.utc),
                    "outage_probe_worker_id": "worker-a",
                },
                None,
            ]
        )
        result = record_upstream_failure(
            engine, config, "worker-a", requests.ConnectionError("offline")
        )
        self.assertTrue(result["paused"])
        self.assertFalse(result["transitioned"])
        self.assertTrue(result["probe_worker"])

    def test_reachable_response_clears_a_shared_pause(self) -> None:
        config = WorkerConfig.from_env()
        engine = FakeEngine([{"recovered": True}])
        self.assertTrue(reset_outage_circuit(engine, config))
        self.assertEqual(engine.connection.calls[0]["campaign_key"], "dallas_residential")


if __name__ == "__main__":
    unittest.main()


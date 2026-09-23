import asyncio
import inspect
import threading
import time
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

from scraper.api import main


class DetailDatabaseResponsivenessTests(unittest.IsolatedAsyncioTestCase):
    async def test_database_unavailable_keeps_the_existing_503_contract(self):
        with patch.object(main, "_db_engine_or_none", return_value=None):
            with self.assertRaises(HTTPException) as raised:
                await main.get_detail("12345678901234567")
        self.assertEqual(raised.exception.status_code, 503)
        self.assertEqual(raised.exception.detail, "database_unavailable")

    async def test_slow_detail_read_does_not_block_health(self):
        entered = threading.Event()
        release = threading.Event()

        def slow_db_read(_account_id):
            entered.set()
            release.wait(timeout=3)
            return None, None

        with patch.object(main, "_load_detail_from_db", side_effect=slow_db_read):
            started = time.monotonic()
            detail_task = asyncio.create_task(main.get_detail("12345678901234567"))
            try:
                self.assertTrue(await asyncio.wait_for(asyncio.to_thread(entered.wait, 1.5), 2))
                self.assertTrue(main.health()["ok"])
                self.assertLess(time.monotonic() - started, 2)
            finally:
                release.set()
            with self.assertRaises(HTTPException) as raised:
                await detail_task
            self.assertEqual(raised.exception.status_code, 404)

    async def test_recovery_transaction_runs_off_the_event_loop(self):
        caller_thread = threading.get_ident()
        observed = []

        class Engine:
            def begin(self):
                class Transaction:
                    def __enter__(self):
                        observed.append(("open", threading.get_ident()))
                        return "connection"

                    def __exit__(self, *_args):
                        observed.append(("close", threading.get_ident()))

                return Transaction()

        await asyncio.to_thread(
            main._run_db_transaction,
            Engine(),
            lambda connection: observed.append((connection, threading.get_ident())),
        )
        self.assertEqual([label for label, _thread in observed], ["open", "connection", "close"])
        self.assertTrue(all(worker_thread != caller_thread for _label, worker_thread in observed))
        self.assertIn("await asyncio.to_thread(_run_db_transaction, engine, persist_recovery)",
                      inspect.getsource(main.get_detail))

    async def test_slow_recovery_write_does_not_block_health(self):
        entered = threading.Event()
        release = threading.Event()
        detail = {
            "property_location": {},
            "owner": {"owner_name": "Example", "mailing_address": "Example", "multi_owner": ["Example"]},
            "main_improvement": {"building_class": "A", "bedroom_count": 2, "baths_full": 1},
            "legal_description": {"lines": ["Example"], "deed_transfer_date": "2026-01-01"},
            "history": {"owner_history": ["Example"], "exemptions": ["Example"]},
            "exemptions_table": ["Example"],
            "tax_year": 2026,
        }

        def slow_db_write(_engine, _operation):
            entered.set()
            release.wait(timeout=3)

        with (patch.object(main, "_load_detail_from_db", return_value=(object(), detail)),
              patch.object(main, "_fetch_text", new_callable=AsyncMock, return_value="<html></html>"),
              patch.object(main, "parse_detail_html", return_value={}),
              patch.object(main, "_run_db_transaction", side_effect=slow_db_write)):
            started = time.monotonic()
            detail_task = asyncio.create_task(main.get_detail("12345678901234567"))
            try:
                self.assertTrue(await asyncio.wait_for(asyncio.to_thread(entered.wait, 1.5), 2))
                self.assertTrue(main.health()["ok"])
                self.assertLess(time.monotonic() - started, 2)
            finally:
                release.set()
            self.assertEqual((await detail_task).account_id, "12345678901234567")

    async def test_db_failure_is_logged_without_leaking_details_to_client(self):
        with (patch.object(main, "_load_detail_from_db", side_effect=RuntimeError("private database password")),
              patch.object(main.logger, "error") as logged):
            with self.assertRaises(HTTPException) as raised:
                await main.get_detail("12345678901234567")
        self.assertEqual(raised.exception.status_code, 500)
        self.assertEqual(raised.exception.detail, "db_lookup_failed")
        logged.assert_called_once_with("scraper_db_lookup_failed error_type=%s", "RuntimeError")


if __name__ == "__main__":
    unittest.main()

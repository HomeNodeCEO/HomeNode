import sys
import unittest
from pathlib import Path
from unittest.mock import patch


SCRAPER_PATH = Path(__file__).resolve().parents[1] / "scraper"
sys.path.insert(0, str(SCRAPER_PATH))

from dcad import fetch, run_batch, worker  # noqa: E402


class FakeCookies(dict):
    def __init__(self):
        super().__init__()
        self.clear_count = 0

    def clear(self):
        self.clear_count += 1
        super().clear()


class FakeSession:
    def __init__(self):
        self.cookies = FakeCookies()
        self.close_count = 0

    def close(self):
        self.close_count += 1


class FetchSessionReuseTests(unittest.TestCase):
    def setUp(self):
        self.sessions = []

        def new_session():
            session = FakeSession()
            self.sessions.append(session)
            return session

        self.patcher = patch.object(fetch, "_new_session", side_effect=new_session)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)

    def test_without_worker_scope_each_account_closes_its_session(self):
        with fetch.browser() as first:
            first.cookies["account"] = "first"
        with fetch.browser() as second:
            self.assertIsNot(first, second)
        self.assertEqual([session.close_count for session in self.sessions], [1, 1])

    def test_worker_reuses_transport_but_clears_cookies_between_accounts(self):
        with fetch.reuse_browser_for_worker():
            with fetch.browser() as first:
                first.cookies["account"] = "first"
            self.assertEqual(first.close_count, 0)
            with fetch.browser() as second:
                self.assertIs(first, second)
                self.assertNotIn("account", second.cookies)
            self.assertEqual(len(self.sessions), 1)
            self.assertEqual(first.cookies.clear_count, 2)
        self.assertEqual(first.close_count, 1)

    def test_worker_discards_a_failed_session_before_retry(self):
        with fetch.reuse_browser_for_worker():
            with self.assertRaisesRegex(RuntimeError, "network failed"):
                with fetch.browser() as first:
                    raise RuntimeError("network failed")
            self.assertEqual(first.close_count, 1)
            with fetch.browser() as second:
                self.assertIsNot(first, second)
        self.assertEqual([session.close_count for session in self.sessions], [1, 1])

    def test_worker_recycles_transport_after_a_bounded_number_of_accounts(self):
        with fetch.reuse_browser_for_worker(maximum_accounts=2):
            with fetch.browser() as first:
                pass
            with fetch.browser() as second:
                self.assertIs(first, second)
            self.assertEqual(first.close_count, 1)
            with fetch.browser() as third:
                self.assertIsNot(first, third)
        self.assertEqual([session.close_count for session in self.sessions], [1, 1])

    def test_nested_worker_scope_does_not_close_the_outer_session(self):
        with fetch.reuse_browser_for_worker():
            with fetch.browser() as first:
                pass
            with fetch.reuse_browser_for_worker():
                with fetch.browser() as second:
                    self.assertIs(first, second)
            self.assertEqual(first.close_count, 0)
        self.assertEqual(first.close_count, 1)

    def test_continuous_worker_wraps_account_processing_in_one_reuse_scope(self):
        seen = []

        def run_once(_config, once):
            self.assertTrue(once)
            for _ in range(2):
                with fetch.browser() as session:
                    seen.append(session)
            return 7

        with patch.object(worker, "_run_worker", side_effect=run_once):
            self.assertEqual(worker.run_worker(object(), once=True), 7)
        self.assertIs(seen[0], seen[1])
        self.assertEqual(seen[0].close_count, 1)

    def test_batch_reuses_transport_without_changing_per_account_pacing(self):
        seen = []

        def run_account(_account_id):
            with fetch.browser() as session:
                seen.append(session)

        with patch.object(run_batch, "run_for_account", side_effect=run_account), \
                patch.object(run_batch.time, "sleep") as sleep, \
                patch.object(sys, "argv", ["run_batch", "12345678901234567,12345678901234568"]):
            run_batch.main()
        self.assertEqual(len(seen), 2)
        self.assertIs(seen[0], seen[1])
        self.assertEqual(seen[0].close_count, 1)
        self.assertEqual(sleep.call_count, 2)


if __name__ == "__main__":
    unittest.main()

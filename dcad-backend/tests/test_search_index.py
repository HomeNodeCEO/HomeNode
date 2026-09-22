import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import search_index  # noqa: E402


class SearchIndexTests(unittest.TestCase):
    def write_detail(self, directory, account_id, detail):
        path = Path(directory) / f"{account_id}.json"
        path.write_text(json.dumps(detail), encoding="utf-8")
        return path

    def test_snapshot_is_built_once_and_preserves_the_existing_response_shape(self):
        with tempfile.TemporaryDirectory() as directory:
            account_id = "12345678901234567"
            path = self.write_detail(directory, account_id, {
                "property_location": {"address": "123 Main Street"},
                "owner": {"owner_name": "Jordan Example"},
                "value_summary": {"market_value": "$123,456"},
            })
            self.write_detail(directory, "23456789012345678", {"results": [{
                "detail": {"property_location": {"address": "500 Oak Avenue"}},
            }]})
            (Path(directory) / "not-an-account.json").write_text("{}", encoding="utf-8")

            snapshot = search_index.build_data_snapshot(Path(directory))
            path.unlink()
            result = search_index.search_snapshot(snapshot, "  jordan  ", 5)

            self.assertEqual(result["query"], "  jordan  ")
            self.assertEqual(len(result["results"]), 1)
            self.assertEqual(result["results"][0], {"summary": {
                "account_id": account_id,
                "address": "123 Main Street",
                "city": "",
                "owner": "Jordan Example",
                "total_value": "$123,456",
                "type": "RESIDENTIAL",
                "detail_url": (
                    "https://www.dallascad.org/AcctDetailRes.aspx?ID="
                    f"{account_id}"
                ),
            }})
            with self.assertRaises(TypeError):
                snapshot.detail_files[account_id] = Path("replacement")

    def test_search_rejects_unbounded_queries_and_result_counts(self):
        snapshot = search_index.DataSnapshot({}, ())
        for query in ("", "   ", "x" * (search_index.MAX_SEARCH_QUERY_CHARS + 1)):
            with self.subTest(query_length=len(query)):
                with self.assertRaisesRegex(ValueError, "invalid_search_query"):
                    search_index.search_snapshot(snapshot, query, 5)
        for limit in (0, -1, search_index.MAX_SEARCH_RESULTS + 1, True, "5"):
            with self.subTest(limit=limit):
                with self.assertRaisesRegex(ValueError, "invalid_search_limit"):
                    search_index.search_snapshot(snapshot, "valid", limit)

        record = search_index.SearchRecord(
            haystack="matching record",
            account_id="12345678901234567",
            address="123 Main Street",
            owner="Jordan Example",
            total_value="Value in Dispute",
        )
        bounded_snapshot = search_index.DataSnapshot({}, tuple(
            record for _ in range(search_index.MAX_SEARCH_RESULTS + 5)
        ))
        result = search_index.search_snapshot(
            bounded_snapshot,
            "matching",
            search_index.MAX_SEARCH_RESULTS,
        )
        self.assertEqual(len(result["results"]), search_index.MAX_SEARCH_RESULTS)

    def test_snapshot_bounds_response_fields_and_index_work(self):
        with tempfile.TemporaryDirectory() as directory:
            account_id = "12345678901234567"
            self.write_detail(directory, account_id, {
                "property_location": {"address": "A" * 800},
                "owner": {"owner_name": "B" * 800},
            })
            snapshot = search_index.build_data_snapshot(Path(directory))
            record = snapshot.search_records[0]
            self.assertLessEqual(len(record.haystack), 17 + 2 + 2 * search_index.MAX_INDEX_FIELD_CHARS)
            response = search_index.search_snapshot(snapshot, account_id, 1)["results"][0]["summary"]
            self.assertEqual(len(response["address"]), search_index.MAX_ADDRESS_RESPONSE_CHARS)
            self.assertEqual(len(response["owner"]), search_index.MAX_OWNER_RESPONSE_CHARS)

    def test_dataset_file_count_and_byte_budgets_fail_startup_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            for index in range(3):
                self.write_detail(directory, f"{index:017d}", {"owner": {"owner_name": "x"}})
            with mock.patch.object(search_index, "MAX_DATA_FILES", 2):
                with self.assertRaisesRegex(
                    search_index.SearchIndexLimitError,
                    "dcad_data_file_count_limit_exceeded",
                ):
                    search_index.build_data_snapshot(Path(directory))

        with tempfile.TemporaryDirectory() as directory:
            self.write_detail(directory, "12345678901234567", {"owner": {"owner_name": "x" * 100}})
            with mock.patch.object(search_index, "MAX_DATA_FILE_BYTES", 40):
                with self.assertRaisesRegex(
                    search_index.SearchIndexLimitError,
                    "dcad_data_file_size_limit_exceeded",
                ):
                    search_index.build_data_snapshot(Path(directory))

        with tempfile.TemporaryDirectory() as directory:
            first = self.write_detail(directory, "12345678901234567", {"owner": {"owner_name": "x" * 30}})
            second = self.write_detail(directory, "23456789012345678", {"owner": {"owner_name": "y" * 30}})
            maximum = max(first.stat().st_size, second.stat().st_size)
            with mock.patch.object(search_index, "MAX_TOTAL_INDEX_SOURCE_BYTES", maximum):
                with self.assertRaisesRegex(
                    search_index.SearchIndexLimitError,
                    "dcad_data_total_size_limit_exceeded",
                ):
                    search_index.build_data_snapshot(Path(directory))

    def test_bounded_reader_never_materializes_an_oversized_detail(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "12345678901234567.json"
            path.write_bytes(b"{" + (b"x" * 128) + b"}")
            with self.assertRaisesRegex(
                search_index.SearchIndexLimitError,
                "dcad_data_file_size_limit_exceeded",
            ):
                search_index.read_bounded_detail(path, maximum_bytes=64)

    def test_concurrency_guard_refuses_excess_work_and_releases_on_failure(self):
        guard = search_index.SearchConcurrencyGuard(1)
        with guard.slot():
            with self.assertRaisesRegex(search_index.SearchCapacityError, "search_capacity_exceeded"):
                with guard.slot():
                    self.fail("the second slot must never be admitted")
        with self.assertRaisesRegex(RuntimeError, "synthetic_failure"):
            with guard.slot():
                raise RuntimeError("synthetic_failure")
        with guard.slot():
            pass


if __name__ == "__main__":
    unittest.main()

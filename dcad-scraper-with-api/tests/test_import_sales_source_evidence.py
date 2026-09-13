from __future__ import annotations

import csv
import hashlib
import io
import json
import sys
import tempfile
import unittest
from copy import deepcopy
from dataclasses import asdict
from decimal import Decimal
from pathlib import Path
from types import ModuleType
from unittest.mock import MagicMock, patch


SCRAPER_ROOT = Path(__file__).resolve().parents[1] / "scraper"
sys.path.insert(0, str(SCRAPER_ROOT))

from dcad import import_sales as importer  # noqa: E402


EVIDENCE = {
    "StandardStatus": " Pending ",
    "ClosePrice": " 9007199254740993.0100 ",
    "Currency": " USD ",
    "PriceCurrency": "",
    "CurrentPriceCurrency": " CAD ",
    "ClosePriceCurrency": " EUR ",
    "LivingAreaUnits": " Square Feet ",
    "LotSizeUnits": " Acres ",
}


def source_row(**changes: str) -> dict[str, str]:
    row = {header: "" for header in importer.EXPECTED_HEADERS}
    row.update({
        "CurrentPrice": "350000", "LivingArea": "1800", "LotSizeArea": "0.2",
        "MlsStatus": "Closed", "CloseDate": "07/01/2026",
        "ParcelNumber": "26272500060150000", "StructuralStyle": "Single Detached",
    })
    row.update(changes)
    return row


class OptionalSourceEvidenceTests(unittest.TestCase):
    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory(prefix="sales_source_evidence_")
        self.addCleanup(directory.cleanup)
        self.directory = Path(directory.name)

    def csv_file(self, rows: list[dict[str, str]], headers: list[str] | None = None) -> Path:
        stream = io.StringIO(newline="")
        writer = csv.DictWriter(stream, fieldnames=headers or list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
        path = self.directory / "synthetic-source.csv"
        path.write_bytes(stream.getvalue().encode("utf-8"))
        return path

    def test_literal_optional_fields_survive_preparation_and_json(self) -> None:
        path = self.csv_file([source_row(**EVIDENCE)])
        loaded = importer._load_rows(path)
        prepared = importer._prepare_sales(loaded, {})[0]
        roundtrip = json.loads(json.dumps(prepared.raw_payload))
        self.assertEqual(set(importer.OPTIONAL_RAW_EVIDENCE_HEADERS), set(EVIDENCE))
        self.assertEqual({key: roundtrip[key] for key in EVIDENCE}, EVIDENCE)
        self.assertEqual(prepared.source_row_number, 2)

    def test_missing_headers_remain_absent_without_defaults(self) -> None:
        raw = importer._load_rows(self.csv_file([source_row()]))[0][1]
        self.assertTrue(set(EVIDENCE).isdisjoint(raw))
        self.assertEqual(raw, source_row())

    def test_explicit_blanks_whitespace_and_multiline_text_are_not_missing(self) -> None:
        fields = {key: "" for key in EVIDENCE}
        fields.update({"Currency": " \t ", "LotSizeUnits": "provider\r\nunit,\"literal\""})
        raw = importer._load_rows(self.csv_file([source_row(**fields)]))[0][1]
        self.assertEqual({key: raw[key] for key in fields}, fields)

    def test_unprovided_trailing_cell_is_not_synthesized_as_blank(self) -> None:
        for field in ("ClosePrice", "StandardStatus"):
            with self.subTest(field=field):
                path = self.csv_file([source_row()])
                contents = path.read_bytes().decode("utf-8")
                header, body = contents.split("\r\n", 1)
                path.write_bytes((header + f",{field}\r\n" + body).encode("utf-8"))
                self.assertNotIn(field, importer._load_rows(path)[0][1])

    def test_unknown_columns_remain_unretained_and_required_headers_unchanged(self) -> None:
        raw = importer._load_rows(self.csv_file([source_row(UnknownColumn="unused", **EVIDENCE)]))[0][1]
        self.assertNotIn("UnknownColumn", raw)
        incomplete = source_row(**EVIDENCE)
        del incomplete["CurrentPrice"]
        with self.assertRaisesRegex(ValueError, "missing required columns: CurrentPrice"):
            importer._load_rows(self.csv_file([incomplete]))

    def test_duplicate_evidence_headers_fail_instead_of_selecting_last_value(self) -> None:
        for field in ("ClosePrice", "StandardStatus"):
            with self.subTest(field=field):
                path = self.csv_file([source_row(**EVIDENCE)], list(source_row(**EVIDENCE)) + [field])
                with self.assertRaisesRegex(ValueError, "duplicate optional source evidence columns"):
                    importer._load_rows(path)

    def test_standard_status_is_literal_and_never_a_typed_mls_status_fallback(self) -> None:
        for mls_status, standard_status in (("Closed", " Pending "), ("Active", " Closed "),
                                            ("", "Closed"), ("Closed", "\t"),
                                            ("Closed", ""), ("Closed", "unknown\r\nprovider,\"token\"")):
            with self.subTest(mls_status=mls_status, standard_status=standard_status):
                before = importer._prepare_sales([(2, source_row(MlsStatus=mls_status))], {})[0]
                path = self.csv_file([source_row(MlsStatus=mls_status, StandardStatus=standard_status)])
                after = importer._prepare_sales(importer._load_rows(path), {})[0]
                self.assertEqual(after.raw_payload["StandardStatus"], standard_status)
                # Status disagreements are retained, not resolved by the importer.
                # Removing only the new raw cell recovers the entire old preparation.
                after_without_evidence = asdict(after)
                del after_without_evidence["raw_payload"]["StandardStatus"]
                self.assertEqual(after_without_evidence, asdict(before))

    def test_standard_status_does_not_replace_the_required_mls_status_column(self) -> None:
        row = source_row(StandardStatus="Closed")
        del row["MlsStatus"]
        with self.assertRaisesRegex(ValueError, "missing required columns: MlsStatus"):
            importer._load_rows(self.csv_file([row]))

    def test_absent_standard_status_preserves_full_prechange_preparation_hashes(self) -> None:
        # Captured before adding the optional raw header, using this synthetic row.
        # Covers raw/typed values, flags, links, stable identity and fingerprint.
        expected = {
            "Closed": "509b9146e315cc54b14b640e1385227ce2cb3126f81f5d5887102d2abcbf62ea",
            "Active": "aae05282cdf531552fd84570576a6f0aaf5e78d21cdf077899b8ce6208cde85e",
            "": "ff658fb9b2ee1967ccab9e919e9ebb752f8a0c751742dcc5ac1f8d0841bdd787",
        }
        for status, digest in expected.items():
            with self.subTest(status=status):
                path = self.csv_file([source_row(MlsStatus=status)])
                prepared = importer._prepare_sales(importer._load_rows(path), {})[0]
                canonical = json.dumps(asdict(prepared), sort_keys=True, separators=(",", ":"), default=str)
                self.assertEqual(hashlib.sha256(canonical.encode("utf-8")).hexdigest(), digest)

    def test_conflicting_price_and_unit_metadata_cannot_change_typed_values_or_flags(self) -> None:
        before = importer._prepare_sales([(2, source_row())], {})[0]
        after = importer._prepare_sales(importer._load_rows(self.csv_file([source_row(**EVIDENCE)])), {})[0]
        self.assertEqual(before.typed, after.typed)
        self.assertEqual(before.data_quality_flags, after.data_quality_flags)
        self.assertEqual(after.typed["current_price"], Decimal("350000"))
        self.assertEqual(after.typed["living_area"], Decimal("1800"))
        self.assertEqual(after.typed["lot_size_area"], Decimal("0.2"))
        self.assertEqual(before.transaction_fingerprint, after.transaction_fingerprint)
        self.assertEqual(before.parcel_links, after.parcel_links)

    def test_new_units_do_not_populate_blank_measurements_or_attach_to_typed_fields(self) -> None:
        row = source_row(CurrentPrice="", LivingArea="", LotSizeArea="", **EVIDENCE)
        prepared = importer._prepare_sales(importer._load_rows(self.csv_file([row])), {})[0]
        for key in ["current_price", "living_area", "lot_size_area"]:
            self.assertIsNone(prepared.typed[key])
        for key in ["close_price", "currency", "living_area_units", "lot_size_units"]:
            self.assertNotIn(key, prepared.typed)
        self.assertEqual(prepared.raw_payload["ClosePrice"], EVIDENCE["ClosePrice"])
        self.assertEqual(prepared.raw_payload["LivingArea"], "")

    def test_metadata_does_not_change_legacy_listing_or_duplicate_identity(self) -> None:
        for identity in [{}, {"ListingId": "SYNTHETIC-1"}, {"ListingKey": "SYNTHETIC-KEY"}]:
            with self.subTest(identity=identity):
                before = source_row(**identity)
                after = source_row(**identity, **EVIDENCE)
                self.assertEqual(importer._source_record_hash(before), importer._source_record_hash(after))
                with self.assertRaisesRegex(ValueError, "Duplicate source row content at CSV row 3"):
                    importer._load_rows(self.csv_file([before, after], list(after)))

    def test_file_hash_and_logical_row_position_remain_distinct_from_stable_identity(self) -> None:
        rows = [source_row(ListingId="SYNTHETIC-1", **EVIDENCE),
                source_row(ListingId="SYNTHETIC-2", **{**EVIDENCE, "ClosePrice": "0.00"})]
        path = self.csv_file(rows)
        original_bytes = path.read_bytes()
        first_sha = importer._source_sha256(path)
        prepared = importer._prepare_sales(importer._load_rows(path), {})
        self.assertEqual(first_sha, hashlib.sha256(original_bytes).hexdigest())
        self.assertEqual([row.source_row_number for row in prepared], [2, 3])
        revised = self.csv_file([{**rows[0], "Currency": "CAD"}, rows[1]])
        self.assertNotEqual(first_sha, importer._source_sha256(revised))
        self.assertEqual(prepared[0].source_record_hash,
                         importer._prepare_sales(importer._load_rows(revised), {})[0].source_record_hash)

    def test_existing_persistence_binds_raw_fields_to_file_hash_filename_and_row(self) -> None:
        # All database entry points are mocked; no schema or database is touched.
        path = self.csv_file([source_row(**EVIDENCE)])
        connection, cursor = MagicMock(), MagicMock()
        connection.cursor.return_value.__enter__.return_value = cursor
        cursor.fetchall.return_value = []
        cursor.fetchone.return_value = (0,)
        captured = []
        driver, extras = ModuleType("psycopg2"), ModuleType("psycopg2.extras")
        driver.connect = MagicMock(return_value=connection)
        extras.Json = deepcopy
        extras.execute_batch = MagicMock()

        def execute_values(_cursor, sql, values, **_options):
            if "INSERT INTO core.sales_source_records" in sql:
                columns = sql.split("INSERT INTO core.sales_source_records (", 1)[1].split(") VALUES", 1)[0]
                names = [column.strip() for column in columns.split(",")]
                captured.extend(dict(zip(names, row, strict=True)) for row in values)
                return [(index + 1, row["source_record_hash"]) for index, row in enumerate(captured)]
            return []

        extras.execute_values = execute_values
        with patch.dict(sys.modules, {"psycopg2": driver, "psycopg2.extras": extras}), \
                patch.dict("os.environ", {"DATABASE_URL": "synthetic://never-connected"}), \
                patch.object(importer, "_migration_sql", return_value="synthetic_schema_stub"), \
                patch.object(importer, "_account_map", return_value={}), \
                patch.object(importer, "_address_resolutions", return_value={}), \
                patch.object(importer, "_existing_hashes_by_listing_id", return_value={}):
            result = importer.import_sales(path, "Synthetic declared source")
        self.assertEqual(len(captured), 1)
        stored = captured[0]
        self.assertEqual(stored["source_filename"], path.name)
        self.assertEqual(stored["source_name"], "Synthetic declared source")
        self.assertEqual(stored["source_row_number"], 2)
        self.assertEqual(stored["source_sha256"], hashlib.sha256(path.read_bytes()).hexdigest())
        self.assertEqual({key: stored["raw_payload"][key] for key in EVIDENCE}, EVIDENCE)
        self.assertEqual(stored["current_price"], Decimal("350000"))
        self.assertTrue(set(EVIDENCE).isdisjoint(stored))
        self.assertEqual(result["source_records_upserted"], 1)
        connection.commit.assert_called_once_with()
        connection.close.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()

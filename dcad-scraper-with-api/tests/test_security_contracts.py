import asyncio
import base64
import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException
from pydantic import ValidationError

from scraper.api.main import (
    SignupRequest,
    _cors_origins,
    _decode_data_url,
    signup_submit,
)
from scraper.api.routes.history import _validated_account_id, history
from scraper.dcad.worker import (
    _accounts_table,
    _campaign_table,
    _events_table,
    _field_repair_table,
    _identifier,
    _owner_recovery_table,
    _owner_summary_table,
    _raw_table,
    _reconciliations_table,
    _state_table,
    _targets_table,
)


class ScraperSecurityContractTests(unittest.TestCase):
    def test_cors_is_an_explicit_origin_allowlist(self):
        with patch.dict(os.environ, {"SCRAPER_CORS_ORIGINS": "https://review.homenode.com"}, clear=False):
            origins = _cors_origins()
        self.assertNotIn("*", origins)
        self.assertIn("https://homenode.onrender.com", origins)
        self.assertIn("https://review.homenode.com", origins)

    def test_cors_rejects_insecure_remote_and_path_origins(self):
        with patch.dict(os.environ, {"SCRAPER_CORS_ORIGINS": "http://attacker.example"}, clear=False):
            with self.assertRaisesRegex(RuntimeError, "invalid_scraper_cors_origin"):
                _cors_origins()
        with patch.dict(os.environ, {"SCRAPER_CORS_ORIGINS": "https://review.homenode.com/path"}, clear=False):
            with self.assertRaisesRegex(RuntimeError, "invalid_scraper_cors_origin"):
                _cors_origins()
        for invalid_origin in ("https://", "https://review.homenode.com:bad", "https://review.homenode.com\\@attacker.example"):
            with self.subTest(invalid_origin=invalid_origin):
                with patch.dict(os.environ, {"SCRAPER_CORS_ORIGINS": invalid_origin}, clear=False):
                    with self.assertRaisesRegex(RuntimeError, "invalid_scraper_cors_origin"):
                        _cors_origins()

    def test_base64_decoder_is_strict_and_bounded(self):
        encoded = base64.b64encode(b"%PDF-1.7").decode("ascii")
        self.assertEqual(_decode_data_url(encoded, maximum_bytes=64), b"%PDF-1.7")
        with self.assertRaises(ValueError):
            _decode_data_url("not-base64!!", maximum_bytes=64)
        oversized = base64.b64encode(b"x" * 65).decode("ascii")
        with self.assertRaisesRegex(ValueError, "decoded_file_too_large"):
            _decode_data_url(oversized, maximum_bytes=64)

    def test_legacy_pdf_endpoint_is_disabled_by_default(self):
        request = SignupRequest(accountId="SYNTHETIC-001", basePdfData="JVBERi0xLjc=")
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(HTTPException) as raised:
                asyncio.run(signup_submit(request))
        self.assertEqual(raised.exception.status_code, 404)
        self.assertEqual(raised.exception.detail, "not_found")

    def test_account_identifier_cannot_create_a_path(self):
        with self.assertRaises(ValidationError):
            SignupRequest(accountId="../../outside", basePdfData="JVBERi0xLjc=")

    def test_history_account_identifier_is_numeric_and_bounded(self):
        self.assertEqual(_validated_account_id(" 123456789 "), "123456789")
        for candidate in (
            "../../outside",
            "https://attacker.example",
            "123?redirect=https://attacker.example",
            "1" * 26,
        ):
            with self.subTest(candidate=candidate):
                with self.assertRaises(HTTPException) as raised:
                    _validated_account_id(candidate)
                self.assertEqual(raised.exception.status_code, 400)

    def test_history_failure_does_not_expose_exception_details(self):
        with patch(
            "scraper.api.routes.history.get_history_for_account",
            side_effect=RuntimeError("database password was exposed"),
        ):
            result = asyncio.run(history("123456789"))
        self.assertEqual(result["error"], "history_unavailable")
        self.assertEqual(result["history_url"], "https://www.dallascad.org/AcctHistory.aspx")
        self.assertNotIn("password", str(result).lower())

    def test_worker_dynamic_sql_identifiers_are_strictly_validated(self):
        self.assertEqual(_identifier("scrape_state_2026", "test"), "scrape_state_2026")
        for candidate in (
            "app.scrape_state",
            'scrape_state"; DROP TABLE core.accounts;--',
            "scrape-state",
            "../../scrape_state",
            "1scrape_state",
            "",
        ):
            with self.subTest(candidate=candidate):
                with self.assertRaisesRegex(ValueError, "Invalid test"):
                    _identifier(candidate, "test")

    def test_worker_table_helpers_revalidate_directly_constructed_configs(self):
        malicious = 'app"; DROP TABLE core.accounts;--'
        config = SimpleNamespace(data_schema=malicious, state_schema=malicious)
        for table_helper in (
            _accounts_table,
            _campaign_table,
            _events_table,
            _field_repair_table,
            _owner_recovery_table,
            _owner_summary_table,
            _raw_table,
            _reconciliations_table,
            _state_table,
            _targets_table,
        ):
            with self.subTest(table_helper=table_helper.__name__):
                with self.assertRaisesRegex(ValueError, "Invalid .* schema"):
                    table_helper(config)

        safe = SimpleNamespace(data_schema="core", state_schema="app")
        self.assertEqual(_accounts_table(safe), '"core"."accounts"')
        self.assertEqual(_state_table(safe), '"app"."dcad_scrape_state"')


if __name__ == "__main__":
    unittest.main()

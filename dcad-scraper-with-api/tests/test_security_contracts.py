import asyncio
import base64
import os
import unittest
from unittest.mock import patch

from fastapi import HTTPException
from pydantic import ValidationError

from scraper.api.main import (
    SignupRequest,
    _cors_origins,
    _decode_data_url,
    signup_submit,
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


if __name__ == "__main__":
    unittest.main()

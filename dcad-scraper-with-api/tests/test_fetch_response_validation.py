from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import Mock

import requests


SCRAPER_ROOT = Path(__file__).resolve().parents[1] / "scraper"
sys.path.insert(0, str(SCRAPER_ROOT))

from dcad.fetch import (  # noqa: E402
    DcadResponseValidationError,
    MAX_HTML_BYTES,
    get_detail_html,
    get_history_html,
)


ACCOUNT = "26272500060150000"


def response(
    url: str,
    html: str,
    headers: dict[str, str] | None = None,
    status_code: int = 200,
) -> requests.Response:
    value = requests.Response()
    value.status_code = status_code
    value.url = url
    value.headers.update(headers or {"Content-Type": "text/html; charset=utf-8"})
    value._content = html.encode("utf-8")
    value._content_consumed = True
    value.encoding = "utf-8"
    value.close = Mock(wraps=value.close)
    return value


def session_with(value: requests.Response) -> Mock:
    session = Mock()
    session.get.return_value = value
    return session


def detail_html(account_id: str = ACCOUNT) -> str:
    return f'''<html><head><title>DCAD: Residential Acct Detail</title></head><body>
    <form id="Form1" action="./AcctDetailRes.aspx?ID={account_id}">
    <span id="lblPageTitle">Residential Account #{account_id}</span>
    <input id="txtAccountNumber" value="{account_id}">
    <input id="hdnReschedAcctNum" value="{account_id}">
    </form></body></html>'''


def history_html(account_id: str = ACCOUNT) -> str:
    return f'''<html><head><title>DCAD - Account History</title></head><body>
    <form id="Form1" action="./AcctHistory.aspx?ID={account_id}">
    <span id="lblPageTitle">Account History #{account_id}</span>
    </form></body></html>'''


class FetchResponseValidationTests(unittest.TestCase):
    def test_accepts_exact_detail_identity(self):
        session = session_with(response(
            f"https://www.dallascad.org/AcctDetailRes.aspx?ID={ACCOUNT}",
            detail_html(),
        ))
        self.assertIn("Residential Account", get_detail_html(session, ACCOUNT))
        session.get.assert_called_once_with(
            f"https://www.dallascad.org/AcctDetailRes.aspx?ID={ACCOUNT}",
            timeout=30.0,
            stream=True,
            allow_redirects=False,
        )

    def test_accepts_exact_history_identity(self):
        session = session_with(response(
            f"https://dallascad.org/AcctHistory.aspx?ID={ACCOUNT}", history_html(),
        ))
        self.assertIn("Account History", get_history_html(session, ACCOUNT))

    def test_rejects_conflicting_or_wrong_account_markers(self):
        other = "26572500130160000"
        cases = (
            detail_html(other),
            detail_html().replace(
                f'id="hdnReschedAcctNum" value="{ACCOUNT}"',
                f'id="hdnReschedAcctNum" value="{other}"',
            ),
        )
        for html in cases:
            with self.subTest(html=html):
                session = session_with(response(
                    f"https://www.dallascad.org/AcctDetailRes.aspx?ID={ACCOUNT}", html,
                ))
                with self.assertRaisesRegex(
                    DcadResponseValidationError, "account_identity_mismatch"
                ):
                    get_detail_html(session, ACCOUNT)

    def test_rejects_login_or_challenge_page(self):
        session = session_with(response(
            f"https://www.dallascad.org/AcctDetailRes.aspx?ID={ACCOUNT}",
            "<html><head><title>Access Required</title></head><body>Sign in</body></html>",
        ))
        with self.assertRaisesRegex(DcadResponseValidationError, "page_identity_missing"):
            get_detail_html(session, ACCOUNT)

    def test_rejects_cross_origin_and_wrong_path_redirects(self):
        for final_url in (
            f"https://example.com/AcctDetailRes.aspx?ID={ACCOUNT}",
            f"https://www.dallascad.org/SearchAcct.aspx?ID={ACCOUNT}",
            f"http://www.dallascad.org/AcctDetailRes.aspx?ID={ACCOUNT}",
            "https://www.dallascad.org/AcctDetailRes.aspx?ID=26572500130160000",
        ):
            with self.subTest(final_url=final_url):
                session = session_with(response(final_url, detail_html()))
                with self.assertRaisesRegex(
                    DcadResponseValidationError,
                    "redirect_(?:invalid|account_mismatch)",
                ):
                    get_detail_html(session, ACCOUNT)

    def test_rejects_cross_origin_redirect_before_requesting_target(self):
        value = response(
            f"https://www.dallascad.org/AcctDetailRes.aspx?ID={ACCOUNT}", "",
            {"Location": "https://example.com/redirect"}, status_code=302,
        )
        session = session_with(value)
        with self.assertRaisesRegex(DcadResponseValidationError, "redirect_invalid"):
            get_detail_html(session, ACCOUNT)
        session.get.assert_called_once()
        value.close.assert_called_once()

    def test_follows_one_prevalidated_dcad_redirect(self):
        initial_url = f"https://www.dallascad.org/AcctDetailRes.aspx?ID={ACCOUNT}"
        final_url = f"https://dallascad.org/AcctDetailRes.aspx?ID={ACCOUNT}"
        redirect = response(
            initial_url, "", {"Location": final_url}, status_code=302,
        )
        final = response(final_url, detail_html())
        session = Mock()
        session.get.side_effect = [redirect, final]
        self.assertIn("Residential Account", get_detail_html(session, ACCOUNT))
        self.assertEqual(session.get.call_count, 2)
        redirect.close.assert_called_once()
        final.close.assert_called_once()

    def test_rejects_missing_required_form_and_detail_markers(self):
        cases = (
            history_html().replace('<form id="Form1"', '<form id="Other"'),
            detail_html().replace(
                f'<input id="txtAccountNumber" value="{ACCOUNT}">', ""
            ),
            detail_html().replace(
                f'<input id="hdnReschedAcctNum" value="{ACCOUNT}">', ""
            ),
            detail_html().replace(
                f'action="./AcctDetailRes.aspx?ID={ACCOUNT}"',
                'action="./AcctDetailRes.aspx"',
            ),
        )
        for html in cases:
            with self.subTest(html=html[:120]):
                is_history = "Account History" in html
                url = (
                    f"https://www.dallascad.org/AcctHistory.aspx?ID={ACCOUNT}"
                    if is_history
                    else f"https://www.dallascad.org/AcctDetailRes.aspx?ID={ACCOUNT}"
                )
                session = session_with(response(url, html))
                fetch = get_history_html if is_history else get_detail_html
                with self.assertRaisesRegex(
                    DcadResponseValidationError, "account_identity_missing"
                ):
                    fetch(session, ACCOUNT)

    def test_rejects_invalid_account_id_before_network_access(self):
        session = Mock()
        for account_id in ("", "123", "26272500060150000&other=1", "R-123"):
            with self.subTest(account_id=account_id):
                with self.assertRaisesRegex(ValueError, "dcad_account_id_invalid"):
                    get_detail_html(session, account_id)
        session.get.assert_not_called()

    def test_rejects_non_html_and_invalid_declared_lengths(self):
        cases = (
            {"Content-Type": "application/json"},
            {"Content-Type": "text/html", "Content-Length": "not-a-number"},
            {"Content-Type": "text/html", "Content-Length": str(MAX_HTML_BYTES + 1)},
        )
        for headers in cases:
            with self.subTest(headers=headers):
                session = session_with(response(
                    f"https://www.dallascad.org/AcctDetailRes.aspx?ID={ACCOUNT}",
                    detail_html(), headers,
                ))
                with self.assertRaises(DcadResponseValidationError):
                    get_detail_html(session, ACCOUNT)
                session.get.return_value.close.assert_called_once()

    def test_rejects_streamed_body_beyond_limit_without_length_header(self):
        value = response(
            f"https://www.dallascad.org/AcctDetailRes.aspx?ID={ACCOUNT}",
            detail_html(),
        )
        value.iter_content = Mock(return_value=iter((b"x" * MAX_HTML_BYTES, b"x")))
        with self.assertRaisesRegex(DcadResponseValidationError, "response_too_large"):
            get_detail_html(session_with(value), ACCOUNT)
        value.close.assert_called_once()


if __name__ == "__main__":
    unittest.main()

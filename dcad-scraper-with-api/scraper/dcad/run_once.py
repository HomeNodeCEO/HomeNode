# scraper/dcad/run_once_envfix.py
# Same behavior as run_once.py, but explicitly loads .env so DATABASE_URL/PGSSL are picked up.
# Usage:
#   python -m dcad.run_once_envfix 26272500060150000

import os
import sys
import json
import logging
from datetime import datetime
from decimal import Decimal
from typing import Any, Dict

# Load environment from a local .env (DATABASE_URL, PGSSL, etc.)
try:
    from dotenv import load_dotenv  # pip install python-dotenv
    load_dotenv()
except Exception:
    pass

from sqlalchemy import create_engine, text

# ---- DCAD project bits ----
# Synchronous browser + fetchers
from dcad.fetch import browser, get_detail_html, get_history_html, polite_pause
# Parsers for "Main Improvement" (primary) and "Additional Improvements" (secondary/history)
from dcad.parse_detail import parse_detail_html
from dcad.parse_history import parse_history_html
# Upsert into Postgres
from dcad.upsert import upsert_parsed

# Optional schema override for raw JSON table as well
_SCHEMA = os.getenv("DB_SCHEMA") or os.getenv("DCAD_SCHEMA") or os.getenv("PGSCHEMA")

def _tbl(name: str) -> str:
    return f"{_SCHEMA}.{name}" if _SCHEMA else name


log = logging.getLogger("dcad.run_once_envfix")


def _json_default(o: Any) -> Any:
    """JSON serializer default that safely handles Decimal (convert to float)."""
    if isinstance(o, Decimal):
        return float(o)
    raise TypeError(f"Object of type {o.__class__.__name__} is not JSON serializable")


def _save_raw_json(account_id: str, tax_year: int, source_url: str, raw_obj: Dict[str, Any]) -> None:
    """Persist a raw snapshot of what we scraped into public.dcad_json_raw."""
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        raise RuntimeError("DATABASE_URL is not set")

    payload = json.dumps(raw_obj, default=_json_default)

    engine = create_engine(db_url, future=True)

    sql = text(
        f"""
        INSERT INTO {_tbl('dcad_json_raw')} (account_id, tax_year, source_url, raw)
        VALUES (:account_id, :tax_year, :source_url, CAST(:raw AS JSONB))
        ON CONFLICT (account_id, tax_year) DO UPDATE
        SET source_url = EXCLUDED.source_url,
            raw        = EXCLUDED.raw,
            fetched_at = now()
        """
    )

    with engine.begin() as conn:
        conn.execute(sql, {
            "account_id": account_id,
            "tax_year": tax_year,
            "source_url": source_url,
            "raw": payload,
        })


def run_for_account(account_id: str) -> None:
    """Scrape one account and upsert into Postgres."""
    source_url = f"https://www.dallascad.org/Account/{account_id}"

    # 1) Fetch HTML (sync)
    with browser() as page:
        detail_html = get_detail_html(page, account_id)
        polite_pause()
        history_html = get_history_html(page, account_id)

    # 2) Parse
    detail = parse_detail_html(detail_html) if detail_html else {}

    # 2b) Ensure mailing_address is present in parsed detail by using a DOM fallback on the Owner block
    try:
        if detail_html:
            owner = detail.get("owner") if isinstance(detail, dict) else None
            maddr = (owner or {}).get("mailing_address") if isinstance(owner, dict) else None
            if not maddr:
                from bs4 import BeautifulSoup  # type: ignore
                import re as _re
                soup = BeautifulSoup(detail_html, "lxml")
                sp = soup.find(id="lblOwner")
                if sp is not None:
                    lines = []
                    for sib in sp.next_siblings:
                        # stop at next section header
                        if getattr(sib, "name", None) == "span" and "DtlSectionHdr" in (sib.get("class") or []):
                            break
                        if isinstance(sib, str):
                            t = sib.strip()
                            if t:
                                lines.append(t)
                        else:
                            t = (sib.get_text(" ") or "").strip()
                            if t:
                                lines.append(t)
                    # normalize
                    norm = [_re.sub(r"\s+", " ", s).strip() for s in lines if s and s.strip()]
                    if norm:
                        # derive rest by skipping possible co-owner line (non-addressy short line)
                        def looks_addr(s: str) -> bool:
                            s_low = (s or "").lower()
                            if any(k in s_low for k in [
                                "multi-owner", "owner name", "ownership %", "application received",
                                "hs application", "ownership", "owner("
                            ]):
                                return False
                            if _re.search(r"\b(tx|texas|[A-Z]{2})\b", s, flags=_re.I):
                                return True
                            if _re.search(r"\b\d{5}(?:-\d{4})?\b", s):
                                return True
                            if _re.search(r"^\s*\d+\s+", s):
                                return True
                            if _re.search(r"\b(apt|unit|#|ct|ln|rd|dr|st|ave|blvd|hwy|pkwy|cir|trl|way|lane|drive|court|road)\b", s_low):
                                return True
                            if "," in s:
                                return True
                            return False
                        rest = norm[1:]
                        if len(norm) > 1 and not looks_addr(norm[1]) and len(norm[1]) <= 40:
                            rest = norm[2:]
                        addr_lines = [ln for ln in rest if looks_addr(ln)]
                        if addr_lines:
                            mailing = ", ".join(addr_lines).replace(" ,", ",").strip(", ")
                            if isinstance(detail.get("owner"), dict):
                                detail["owner"]["mailing_address"] = mailing
                            else:
                                detail["owner"] = {"owner_name": (owner or {}).get("owner_name"), "mailing_address": mailing}
    except Exception:
        pass
    history = parse_history_html(history_html) if history_html else {}

    # Choose a tax_year to label the snapshot. Prefer parsed value; else current year.
    tax_year = None
    for key in ("tax_year", "year", "assessment_year"):
        if key in detail and detail[key]:
            try:
                tax_year = int(detail[key])
                break
            except Exception:
                pass
    if tax_year is None:
        tax_year = datetime.now().year

    # 3) Save raw snapshot (log error but proceed if saving fails)
    snapshot = {
        "account_id": account_id,
        "tax_year": tax_year,
        "source_url": source_url,
        "detail": detail,
        "history": history,
    }
    try:
        _save_raw_json(account_id, tax_year, source_url, snapshot)
    except Exception as e:
        log.error("Saving raw JSON failed for account_id=%s: %s", account_id, e, exc_info=True)

    # 4) Upsert the parsed structures into your normalized tables
    upsert_parsed(account_id, detail, history)
    log.info("Upsert complete for account_id=%s", account_id)


def main() -> None:
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    if len(sys.argv) < 2:
        print("Usage: python -m dcad.run_once_envfix <ACCOUNT_ID>")
        sys.exit(2)

    account_id = sys.argv[1].strip()
    log.info("Starting run for account_id=%s", account_id)
    run_for_account(account_id)
    log.info("Done upsert for account_id=%s", account_id)


if __name__ == "__main__":
    main()

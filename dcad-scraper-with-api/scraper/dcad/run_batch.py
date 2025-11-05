from __future__ import annotations

import os
import sys
import csv
import time
import logging
from typing import List

try:
    from dotenv import load_dotenv
    load_dotenv()
except Exception:
    pass

from .run_once import run_for_account
try:
    # When running as a package (python -m dcad.run_batch), import top-level utils
    from utils import normalize_account_id  # type: ignore
except Exception:
    # Fallback for alternate execution contexts
    from ..utils import normalize_account_id  # type: ignore


log = logging.getLogger("dcad.run_batch")


def _read_accounts_from_csv(path: str) -> List[str]:
    out: List[str] = []
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.reader(f)
        for row in reader:
            for cell in row:
                s = (cell or "").strip()
                if not s:
                    continue
                # Try to normalize/validate full DCAD IDs first
                try:
                    acc = normalize_account_id(s)
                    out.append(acc)
                    continue
                except Exception:
                    pass
                # Fallback: accept digit-starting tokens that look like account IDs
                if s[0].isdigit() and len(s) >= 10:
                    out.append(s)
    return out


def main() -> None:
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    if len(sys.argv) < 2:
        print("Usage: python -m dcad.run_batch <accounts.csv|account1,account2,...>")
        sys.exit(2)

    arg = sys.argv[1]
    if os.path.exists(arg):
        accounts = _read_accounts_from_csv(arg)
    else:
        accounts = [s.strip() for s in arg.split(",") if s.strip()]

    if not accounts:
        print("No accounts provided")
        sys.exit(2)

    delay = float(os.environ.get("BATCH_DELAY_SEC", "1.5"))
    log.info("Starting batch for %d accounts", len(accounts))
    for i, acc in enumerate(accounts, 1):
        try:
            log.info("[%d/%d] Running account_id=%s", i, len(accounts), acc)
            run_for_account(acc)
        except Exception as e:
            log.error("Account %s failed: %s", acc, e, exc_info=True)
        time.sleep(delay)
    log.info("Batch complete")


if __name__ == "__main__":
    main()

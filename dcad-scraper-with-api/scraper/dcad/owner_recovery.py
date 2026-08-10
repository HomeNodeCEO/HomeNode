"""Conservative recovery helpers for truncated current-owner names."""

from __future__ import annotations

import re
from typing import Optional


def _tokens(value: str | None) -> list[str]:
    return re.findall(r"[A-Z0-9]+", str(value or "").upper())


def _normalized(value: str | None) -> str:
    return " ".join(_tokens(value))


def recover_complete_owner_name(
    summary_name: str | None,
    mailing_address: str | None,
    ownership_history_line: str | None,
) -> Optional[str]:
    """Return a deterministic longer owner name retained before the address.

    The method intentionally handles only summary names ending in ``&``. It
    locates the current mailing address inside the retained ownership-history
    line, then accepts the preceding text only when it begins with the exact
    current summary plus additional owner-name tokens.
    """

    summary = str(summary_name or "").strip()
    if not summary or not re.search(r"&\s*$", summary):
        return None

    address_tokens = _tokens(mailing_address)
    history_tokens = _tokens(ownership_history_line)
    if len(address_tokens) < 3 or not history_tokens:
        return None

    boundary: int | None = None
    for width in (4, 3):
        needle = address_tokens[:width]
        for index in range(1, len(history_tokens) - width + 1):
            if history_tokens[index : index + width] == needle:
                boundary = index
                break
        if boundary is not None:
            break
    if boundary is None:
        return None

    candidate_tokens = history_tokens[:boundary]
    summary_tokens = _tokens(summary)
    if (
        len(candidate_tokens) <= len(summary_tokens)
        or candidate_tokens[: len(summary_tokens)] != summary_tokens
    ):
        return None

    raw_line = str(ownership_history_line or "")
    address_pattern = r"\b" + r"\W+".join(
        re.escape(token) for token in address_tokens[:3]
    ) + r"\b"
    match = re.search(address_pattern, raw_line, flags=re.IGNORECASE)
    if not match:
        return None
    candidate = re.sub(r"\s+", " ", raw_line[: match.start()]).strip(" ,;-")
    if not candidate or _normalized(candidate) != " ".join(candidate_tokens):
        return None
    if not _normalized(candidate).startswith(_normalized(summary) + " "):
        return None
    return candidate

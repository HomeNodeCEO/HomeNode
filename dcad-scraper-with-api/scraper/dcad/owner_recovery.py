"""Conservative recovery helpers for truncated current-owner names."""

from __future__ import annotations

import re
from typing import Any, Optional


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


def repair_owner_from_history(
    detail: dict[str, Any], history: dict[str, Any]
) -> bool:
    """Repair a current sole-owner row using the freshly scraped history.

    Some DCAD detail pages place the co-owner on a line that resembles a street
    suffix (for example, ``ROBBINS LANE``). The detail parser can consequently
    treat that name as the first mailing-address line. The history page retains
    the complete owner and actual numbered mailing address in one line, which
    lets us recover the name and remove the false address prefix safely.
    """

    owner = detail.get("owner") if isinstance(detail, dict) else None
    if not isinstance(owner, dict):
        return False
    summary_name = str(owner.get("owner_name") or "").strip()
    parties = owner.get("multi_owner")
    if not re.search(r"&\s*$", summary_name) or not isinstance(parties, list):
        return False
    if len(parties) != 1 or not isinstance(parties[0], dict):
        return False
    pct = str(parties[0].get("ownership_pct") or "").strip()
    if not re.fullmatch(r"100(?:\.0+)?%?", pct):
        return False

    owner_history = history.get("owner_history") if isinstance(history, dict) else None
    if not isinstance(owner_history, list) or not owner_history:
        return False
    lines = owner_history[0].get("owner_lines") if isinstance(owner_history[0], dict) else None
    if not isinstance(lines, list) or not lines:
        return False
    history_line = " ".join(str(line) for line in lines if str(line).strip())

    mailing = str(owner.get("mailing_address") or "").strip()
    segments = [part.strip() for part in mailing.split(",") if part.strip()]
    numbered_index = next(
        (index for index, part in enumerate(segments) if re.match(r"^\d+\s+\S", part)),
        None,
    )
    clean_mailing = (
        ", ".join(segments[numbered_index:])
        if numbered_index is not None
        else mailing
    )
    recovered = recover_complete_owner_name(
        summary_name, clean_mailing, history_line
    )
    if not recovered:
        return False

    owner["owner_name"] = recovered
    parties[0]["owner_name"] = recovered
    if clean_mailing:
        owner["mailing_address"] = clean_mailing
    return True

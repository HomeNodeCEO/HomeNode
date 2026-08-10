"""Conservative recovery helpers for truncated DCAD owner headings."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Optional


TOKEN_RE = re.compile(r"[A-Z0-9&'-]+")


@dataclass(frozen=True)
class Token:
    value: str
    start: int


def _tokens(value: object) -> list[Token]:
    text = str(value or "").upper()
    return [Token(match.group(0), match.start()) for match in TOKEN_RE.finditer(text)]


def recover_complete_owner_name(
    summary_name: object,
    mailing_address: object,
    ownership_history_line: object,
) -> Optional[str]:
    """Return a longer owner name only when the mailing-address boundary is clear.

    DCAD history lines concatenate the complete owner heading and mailing
    address.  A recovery is accepted only when at least the first three mailing
    address tokens appear together after the summary name and the recovered
    name begins with the existing summary.  Ambiguous rows return ``None``.
    """

    summary = str(summary_name or "").strip()
    history_line = str(ownership_history_line or "").strip()
    summary_tokens = _tokens(summary)
    history_tokens = _tokens(history_line)
    address_tokens = _tokens(mailing_address)
    if not summary.endswith("&") or len(address_tokens) < 3 or len(history_tokens) < 4:
        return None

    boundary_size = min(4, len(address_tokens))
    address_start = None
    for index in range(1, len(history_tokens) - boundary_size + 1):
        if all(
            history_tokens[index + offset].value == address_tokens[offset].value
            for offset in range(boundary_size)
        ):
            address_start = index
            break
    if address_start is None:
        return None

    candidate = history_line[: history_tokens[address_start].start]
    candidate = re.sub(r"[\s,]+$", "", candidate).strip()
    normalized_summary = " ".join(token.value for token in summary_tokens)
    normalized_candidate = " ".join(token.value for token in _tokens(candidate))
    if (
        not normalized_summary
        or normalized_candidate == normalized_summary
        or not normalized_candidate.startswith(f"{normalized_summary} ")
        or len(candidate) > 220
    ):
        return None
    return candidate


def repair_owner_from_history(
    detail: dict[str, Any], history: dict[str, Any]
) -> bool:
    """Repair a current sole-owner row using the freshly scraped history."""

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

"""Bounded, immutable search snapshot for the legacy DCAD fixture API."""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
import json
from pathlib import Path
import re
from threading import BoundedSemaphore
from types import MappingProxyType
from typing import Any, Dict, Iterator, List, Mapping, Sequence


ACCOUNT_ID_PATTERN = re.compile(r"^[0-9]{17}$", re.ASCII)
MAX_DATA_FILES = 10_000
MAX_DATA_FILE_BYTES = 2 * 1024 * 1024
MAX_TOTAL_INDEX_SOURCE_BYTES = 64 * 1024 * 1024
MAX_SEARCH_QUERY_CHARS = 128
MAX_SEARCH_RESULTS = 50
MAX_INDEX_FIELD_CHARS = 512
MAX_ADDRESS_RESPONSE_CHARS = 500
MAX_OWNER_RESPONSE_CHARS = 120
MAX_CONCURRENT_SEARCHES = 8


class SearchIndexLimitError(RuntimeError):
    """The configured fixture dataset exceeds a startup safety bound."""


class SearchCapacityError(RuntimeError):
    """All bounded search execution slots are currently in use."""


@dataclass(frozen=True)
class SearchRecord:
    haystack: str
    account_id: str
    address: str
    owner: str
    total_value: str

    def response(self) -> Dict[str, Dict[str, str]]:
        return {
            "summary": {
                "account_id": self.account_id,
                "address": self.address or self.account_id,
                "city": "",
                "owner": self.owner,
                "total_value": self.total_value,
                "type": "RESIDENTIAL",
                "detail_url": (
                    "https://www.dallascad.org/AcctDetailRes.aspx?ID="
                    f"{self.account_id}"
                ),
            }
        }


@dataclass(frozen=True)
class DataSnapshot:
    detail_files: Mapping[str, Path]
    search_records: Sequence[SearchRecord]


class SearchConcurrencyGuard:
    def __init__(self, maximum: int = MAX_CONCURRENT_SEARCHES):
        if not isinstance(maximum, int) or maximum < 1:
            raise ValueError("invalid_search_concurrency")
        self._semaphore = BoundedSemaphore(maximum)

    @contextmanager
    def slot(self) -> Iterator[None]:
        if not self._semaphore.acquire(blocking=False):
            raise SearchCapacityError("search_capacity_exceeded")
        try:
            yield
        finally:
            self._semaphore.release()


def _safe_get(value: Dict[str, Any], path: List[str], default=None):
    current = value
    for key in path:
        if not isinstance(current, dict) or key not in current:
            return default
        current = current[key]
    return current


def _to_num(value: Any) -> float:
    if value is None:
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)
    normalized = str(value).replace("$", "").replace(",", "").strip()
    try:
        return float(normalized)
    except (TypeError, ValueError):
        return 0.0


def load_detail_object(raw: Dict[str, Any]) -> Dict[str, Any]:
    if "detail" in raw and isinstance(raw["detail"], dict):
        return raw["detail"]
    if "results" in raw and isinstance(raw["results"], list) and raw["results"]:
        item = raw["results"][0]
        if isinstance(item, dict) and isinstance(item.get("detail"), dict):
            return item["detail"]
    return raw


def _read_bounded_payload(path: Path, maximum_bytes: int) -> bytes:
    with path.open("rb") as handle:
        payload = handle.read(maximum_bytes + 1)
    if not payload or len(payload) > maximum_bytes:
        raise SearchIndexLimitError("dcad_data_file_size_limit_exceeded")
    return payload


def read_bounded_detail(path: Path, maximum_bytes: int = MAX_DATA_FILE_BYTES) -> Dict[str, Any]:
    payload = _read_bounded_payload(path, maximum_bytes)
    raw = json.loads(payload)
    if not isinstance(raw, dict):
        raise ValueError("invalid_dcad_detail_root")
    return load_detail_object(raw)


def _bounded_fixture_paths(data_dir: Path) -> List[Path]:
    base_dir = data_dir.resolve()
    paths: List[Path] = []
    for entry in base_dir.iterdir():
        if not entry.is_file() or entry.suffix.lower() != ".json":
            continue
        if not ACCOUNT_ID_PATTERN.fullmatch(entry.stem):
            continue
        candidate = entry.resolve()
        try:
            relative = candidate.relative_to(base_dir)
        except ValueError:
            continue
        if candidate.parent != base_dir or relative.name != entry.name:
            continue
        paths.append(candidate)
        if len(paths) > MAX_DATA_FILES:
            raise SearchIndexLimitError("dcad_data_file_count_limit_exceeded")
    return sorted(paths, key=lambda item: item.name)


def _search_record(account_id: str, detail: Dict[str, Any]) -> SearchRecord:
    address = str(_safe_get(detail, ["property_location", "address"], "") or "")
    owner = str(_safe_get(detail, ["owner", "owner_name"], "") or "")
    market_from_summary = _to_num(_safe_get(detail, ["value_summary", "market_value"]))
    market_history = _safe_get(detail, ["history", "market_value"], [])
    market_history_value = (
        _to_num(market_history[0].get("total_market"))
        if isinstance(market_history, list)
        and market_history
        and isinstance(market_history[0], dict)
        else 0.0
    )
    market_value = market_from_summary or market_history_value
    indexed_address = address[:MAX_INDEX_FIELD_CHARS]
    indexed_owner = owner[:MAX_INDEX_FIELD_CHARS]
    return SearchRecord(
        haystack=f"{account_id} {indexed_address} {indexed_owner}".casefold(),
        account_id=account_id,
        address=address[:MAX_ADDRESS_RESPONSE_CHARS],
        owner=owner[:MAX_OWNER_RESPONSE_CHARS],
        total_value=f"${market_value:,.0f}" if market_value else "Value in Dispute",
    )


def build_data_snapshot(data_dir: Path) -> DataSnapshot:
    detail_files: Dict[str, Path] = {}
    search_records: List[SearchRecord] = []
    source_bytes = 0
    for path in _bounded_fixture_paths(data_dir):
        payload = _read_bounded_payload(path, MAX_DATA_FILE_BYTES)
        source_bytes += len(payload)
        if source_bytes > MAX_TOTAL_INDEX_SOURCE_BYTES:
            raise SearchIndexLimitError("dcad_data_total_size_limit_exceeded")
        account_id = path.stem
        detail_files[account_id] = path
        try:
            raw = json.loads(payload)
            if not isinstance(raw, dict):
                continue
            detail = load_detail_object(raw)
        except (UnicodeError, ValueError, json.JSONDecodeError):
            continue
        search_records.append(_search_record(account_id, detail))
    return DataSnapshot(
        detail_files=MappingProxyType(detail_files),
        search_records=tuple(search_records),
    )


def search_snapshot(snapshot: DataSnapshot, query: str, limit: int) -> Dict[str, Any]:
    raw_query = str(query or "")
    normalized_query = raw_query.strip()
    if not normalized_query or len(normalized_query) > MAX_SEARCH_QUERY_CHARS:
        raise ValueError("invalid_search_query")
    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= MAX_SEARCH_RESULTS:
        raise ValueError("invalid_search_limit")
    folded_query = normalized_query.casefold()
    results = []
    for record in snapshot.search_records:
        if folded_query not in record.haystack:
            continue
        results.append(record.response())
        if len(results) == limit:
            break
    return {"query": raw_query, "results": results}

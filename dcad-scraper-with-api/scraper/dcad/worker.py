from __future__ import annotations

import argparse
import json
import logging
import os
import re
import signal
import socket
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from requests import exceptions as requests_exceptions
from sqlalchemy import Engine, text

from dcad.run_once import run_for_account
from dcad.upsert import get_engine


log = logging.getLogger("dcad.worker")
_stop_requested = False
DEFAULT_CAMPAIGN_KEY = "dallas_residential"


def _identifier(value: str, label: str) -> str:
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", value):
        raise ValueError(f"Invalid {label}: {value!r}")
    return value


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class WorkerConfig:
    data_schema: str
    state_schema: str
    campaign_key: str
    excluded_counties: tuple[str, ...]
    refresh_days: int
    delay_seconds: float
    idle_seconds: float
    lease_minutes: int
    retry_base_seconds: int
    retry_max_seconds: int
    outage_failure_threshold: int
    outage_pause_seconds: int
    auto_migrate: bool
    account_id_regex: str

    @classmethod
    def from_env(cls) -> "WorkerConfig":
        excluded = tuple(
            part.strip().upper()
            for part in os.getenv("SCRAPE_EXCLUDED_COUNTIES", "COLLIN").split(",")
            if part.strip()
        )
        return cls(
            data_schema=_identifier(os.getenv("DB_SCHEMA", "core"), "DB_SCHEMA"),
            state_schema=_identifier(os.getenv("SCRAPE_STATE_SCHEMA", "app"), "SCRAPE_STATE_SCHEMA"),
            campaign_key=os.getenv("SCRAPE_CAMPAIGN_KEY", DEFAULT_CAMPAIGN_KEY).strip(),
            excluded_counties=excluded,
            refresh_days=max(1, int(os.getenv("SCRAPE_REFRESH_DAYS", "30"))),
            delay_seconds=max(0.0, float(os.getenv("SCRAPE_DELAY_SECONDS", "2"))),
            idle_seconds=max(1.0, float(os.getenv("SCRAPE_IDLE_SECONDS", "60"))),
            lease_minutes=max(1, int(os.getenv("SCRAPE_LEASE_MINUTES", "15"))),
            retry_base_seconds=max(30, int(os.getenv("SCRAPE_RETRY_BASE_SECONDS", "300"))),
            retry_max_seconds=max(300, int(os.getenv("SCRAPE_RETRY_MAX_SECONDS", "604800"))),
            outage_failure_threshold=max(
                2, int(os.getenv("SCRAPE_OUTAGE_FAILURE_THRESHOLD", "5"))
            ),
            outage_pause_seconds=max(
                30, int(os.getenv("SCRAPE_OUTAGE_PAUSE_SECONDS", "300"))
            ),
            auto_migrate=_env_bool("SCRAPE_AUTO_MIGRATE", True),
            account_id_regex=os.getenv("SCRAPE_ACCOUNT_ID_REGEX", r"^[[:alnum:]]{17}$"),
        )


def _state_table(config: WorkerConfig) -> str:
    return f'"{config.state_schema}"."dcad_scrape_state"'


def _accounts_table(config: WorkerConfig) -> str:
    return f'"{config.data_schema}"."accounts"'


def _raw_table(config: WorkerConfig) -> str:
    return f'"{config.data_schema}"."dcad_json_raw"'


def _targets_table(config: WorkerConfig) -> str:
    return f'"{config.state_schema}"."dcad_residential_targets"'


def _campaign_table(config: WorkerConfig) -> str:
    return f'"{config.state_schema}"."dcad_residential_campaign"'


def _events_table(config: WorkerConfig) -> str:
    return f'"{config.state_schema}"."dcad_campaign_events"'


def ensure_state_schema(engine: Engine, config: WorkerConfig) -> None:
    state = _state_table(config)
    ddl = f"""
        CREATE SCHEMA IF NOT EXISTS "{config.state_schema}";
        CREATE TABLE IF NOT EXISTS {state} (
            account_id       text PRIMARY KEY,
            status           text NOT NULL DEFAULT 'pending',
            attempts         integer NOT NULL DEFAULT 0,
            last_attempt_at  timestamptz,
            last_success_at  timestamptz,
            next_attempt_at  timestamptz NOT NULL DEFAULT now(),
            lease_expires_at timestamptz,
            worker_id        text,
            last_error       text,
            updated_at       timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS dcad_scrape_state_due_idx
            ON {state} (next_attempt_at, last_success_at);
        CREATE INDEX IF NOT EXISTS dcad_scrape_state_status_idx
            ON {state} (status);
    """
    with engine.begin() as conn:
        conn.execute(text(ddl))
        migration_root = Path(__file__).resolve().parents[2] / "migrations"
        for migration_name in (
            "003_dcad_residential_campaign.sql",
            "006_dcad_outage_circuit.sql",
        ):
            migration = migration_root / migration_name
            conn.execute(text(migration.read_text(encoding="utf-8")))


def verify_state_schema(engine: Engine, config: WorkerConfig) -> None:
    with engine.connect() as conn:
        found = conn.execute(
            text("SELECT to_regclass(:table_name)"),
            {"table_name": f"{config.state_schema}.dcad_scrape_state"},
        ).scalar_one()
    if found is None:
        raise RuntimeError(
            "Scrape state table is missing. Run with --migrate-only or set "
            "SCRAPE_AUTO_MIGRATE=true."
        )


def bootstrap_existing_successes(engine: Engine, config: WorkerConfig) -> int:
    state = _state_table(config)
    raw = _raw_table(config)
    sql = text(
        f"""
        INSERT INTO {state} (
            account_id, status, attempts, last_attempt_at, last_success_at,
            next_attempt_at, updated_at
        )
        SELECT r.account_id,
               'succeeded',
               0,
               r.fetched_at,
               r.fetched_at,
               r.fetched_at + make_interval(days => :refresh_days),
               now()
        FROM {raw} r
        ON CONFLICT (account_id) DO NOTHING
        """
    )
    with engine.begin() as conn:
        result = conn.execute(sql, {"refresh_days": config.refresh_days})
        return int(result.rowcount or 0)


def target_account_count(engine: Engine, config: WorkerConfig) -> int:
    targets = _targets_table(config)
    campaign = _campaign_table(config)
    sql = text(
        f"""
        SELECT count(*)
        FROM {targets} t
        JOIN {campaign} c ON c.campaign_key = :campaign_key
        """
    )
    with engine.connect() as conn:
        return int(
            conn.execute(
                sql,
                {"campaign_key": config.campaign_key},
            ).scalar_one()
        )


def claim_next_account(
    engine: Engine,
    config: WorkerConfig,
    worker_id: str,
) -> Optional[tuple[str, int]]:
    state = _state_table(config)
    targets = _targets_table(config)
    campaign = _campaign_table(config)
    sql = text(
        f"""
        WITH locked_campaign AS (
            SELECT c.*
            FROM {campaign} c
            WHERE c.campaign_key = :campaign_key
            FOR UPDATE
        ),
        available_campaign AS (
            SELECT c.*
            FROM locked_campaign c
            WHERE c.outage_paused_until IS NULL
               OR (
                    c.outage_paused_until <= now()
                    AND (
                        c.outage_probe_lease_expires_at IS NULL
                        OR c.outage_probe_lease_expires_at <= now()
                        OR c.outage_probe_worker_id = :worker_id
                    )
               )
        ),
        campaign_gate AS (
            UPDATE {campaign} c
            SET outage_probe_worker_id = CASE
                    WHEN gate.outage_paused_until IS NULL THEN NULL
                    ELSE :worker_id
                END,
                outage_probe_lease_expires_at = CASE
                    WHEN gate.outage_paused_until IS NULL THEN NULL
                    ELSE now() + make_interval(mins => :lease_minutes)
                END,
                updated_at = now()
            FROM available_campaign gate
            WHERE c.campaign_key = gate.campaign_key
            RETURNING c.phase, c.cycle_number
        ),
        candidate AS (
            SELECT t.account_id
            FROM {targets} t
            JOIN campaign_gate c ON true
            LEFT JOIN {state} s ON s.account_id = t.account_id
            WHERE COALESCE(s.status, 'pending') <> 'disabled'
              AND (s.lease_expires_at IS NULL OR s.lease_expires_at <= now())
              AND (
                  COALESCE(s.status, 'pending') <> 'retry'
                  OR COALESCE(s.next_attempt_at, now()) <= now()
              )
              AND (
                  (
                      c.phase = 'initial_missing'
                      AND t.initial_missing
                      AND t.initial_completed_at IS NULL
                  )
                  OR (
                      c.phase = 'full_cycle'
                      AND t.last_completed_cycle < c.cycle_number
                  )
              )
            ORDER BY t.source_position
            FOR UPDATE OF t SKIP LOCKED
            LIMIT 1
        )
        INSERT INTO {state} (
            account_id, status, attempts, last_attempt_at, last_success_at,
            next_attempt_at, lease_expires_at, worker_id, last_error, updated_at
        )
        SELECT c.account_id,
               'leased',
               0,
               now(),
               NULL,
               now(),
               now() + make_interval(mins => :lease_minutes),
               :worker_id,
               NULL,
               now()
        FROM candidate c
        ON CONFLICT (account_id) DO UPDATE
        SET status = 'leased',
            last_attempt_at = now(),
            lease_expires_at = now() + make_interval(mins => :lease_minutes),
            worker_id = EXCLUDED.worker_id,
            updated_at = now()
        RETURNING account_id, attempts
        """
    )
    with engine.begin() as conn:
        row = conn.execute(
            sql,
            {
                "campaign_key": config.campaign_key,
                "lease_minutes": config.lease_minutes,
                "worker_id": worker_id,
            },
        ).mappings().first()
    if row is None:
        return None
    return str(row["account_id"]), int(row["attempts"])


UPSTREAM_OUTAGE_STATUS_CODES = frozenset({408, 425, 429, 500, 502, 503, 504})


def is_upstream_outage_error(error: BaseException) -> bool:
    """Return true only for failures that indicate DCAD itself is unavailable."""
    current: Optional[BaseException] = error
    visited: set[int] = set()
    while current is not None and id(current) not in visited:
        visited.add(id(current))
        if isinstance(
            current,
            (
                requests_exceptions.Timeout,
                requests_exceptions.ConnectionError,
                requests_exceptions.RetryError,
            ),
        ):
            return True
        if isinstance(current, requests_exceptions.HTTPError):
            response = getattr(current, "response", None)
            status_code = getattr(response, "status_code", None)
            return status_code in UPSTREAM_OUTAGE_STATUS_CODES
        current = current.__cause__ or current.__context__
    return False


def should_pause_for_outage(
    failure_count: int,
    threshold: int,
    circuit_was_open: bool,
) -> bool:
    return circuit_was_open or failure_count >= threshold


def record_upstream_failure(
    engine: Engine,
    config: WorkerConfig,
    worker_id: str,
    error: BaseException,
) -> dict[str, object]:
    campaign = _campaign_table(config)
    message = f"{error.__class__.__name__}: {error}"[:2000]
    with engine.begin() as conn:
        current = conn.execute(
            text(
                f"""
                SELECT upstream_failure_count, outage_paused_until,
                       outage_probe_worker_id
                FROM {campaign}
                WHERE campaign_key = :campaign_key
                FOR UPDATE
                """
            ),
            {"campaign_key": config.campaign_key},
        ).mappings().first()
        if current is None:
            return {
                "paused": False,
                "transitioned": False,
                "failure_count": 0,
            }

        failure_count = int(current["upstream_failure_count"] or 0) + 1
        circuit_was_open = current["outage_paused_until"] is not None
        paused = should_pause_for_outage(
            failure_count,
            config.outage_failure_threshold,
            circuit_was_open,
        )
        if paused:
            conn.execute(
                text(
                    f"""
                    UPDATE {campaign}
                    SET upstream_failure_count = :failure_count,
                        outage_pause_started_at = CASE
                            WHEN outage_paused_until IS NULL THEN now()
                            ELSE outage_pause_started_at
                        END,
                        outage_paused_until = now() + make_interval(secs => :pause_seconds),
                        outage_last_error = :last_error,
                        outage_count = outage_count + CASE
                            WHEN outage_paused_until IS NULL THEN 1
                            ELSE 0
                        END,
                        outage_probe_worker_id = NULL,
                        outage_probe_lease_expires_at = NULL,
                        updated_at = now()
                    WHERE campaign_key = :campaign_key
                    """
                ),
                {
                    "campaign_key": config.campaign_key,
                    "failure_count": failure_count,
                    "pause_seconds": config.outage_pause_seconds,
                    "last_error": message,
                },
            )
        else:
            conn.execute(
                text(
                    f"""
                    UPDATE {campaign}
                    SET upstream_failure_count = :failure_count,
                        outage_last_error = :last_error,
                        updated_at = now()
                    WHERE campaign_key = :campaign_key
                    """
                ),
                {
                    "campaign_key": config.campaign_key,
                    "failure_count": failure_count,
                    "last_error": message,
                },
            )

    return {
        "paused": paused,
        "transitioned": paused and not circuit_was_open,
        "failure_count": failure_count,
        "pause_seconds": config.outage_pause_seconds if paused else 0,
        "probe_worker": current["outage_probe_worker_id"] == worker_id,
    }


def reset_outage_circuit(engine: Engine, config: WorkerConfig) -> bool:
    """Record evidence that DCAD is reachable and clear any shared pause."""
    campaign = _campaign_table(config)
    with engine.begin() as conn:
        row = conn.execute(
            text(
                f"""
                WITH previous AS (
                    SELECT campaign_key, upstream_failure_count,
                           outage_paused_until
                    FROM {campaign}
                    WHERE campaign_key = :campaign_key
                    FOR UPDATE
                )
                UPDATE {campaign} c
                SET upstream_failure_count = 0,
                    outage_pause_started_at = NULL,
                    outage_paused_until = NULL,
                    outage_last_error = NULL,
                    outage_probe_worker_id = NULL,
                    outage_probe_lease_expires_at = NULL,
                    updated_at = now()
                FROM previous p
                WHERE c.campaign_key = p.campaign_key
                RETURNING (p.outage_paused_until IS NOT NULL) AS recovered
                """
            ),
            {"campaign_key": config.campaign_key},
        ).mappings().first()
    return bool(row and row["recovered"])


def mark_success(engine: Engine, config: WorkerConfig, account_id: str) -> bool:
    state = _state_table(config)
    targets = _targets_table(config)
    campaign = _campaign_table(config)
    sql = text(
        f"""
        UPDATE {state}
        SET status = 'succeeded',
            attempts = 0,
            last_success_at = now(),
            next_attempt_at = now() + make_interval(days => :refresh_days),
            lease_expires_at = NULL,
            worker_id = NULL,
            last_error = NULL,
            updated_at = now()
        WHERE account_id = :account_id
        """
    )
    with engine.begin() as conn:
        conn.execute(sql, {"account_id": account_id, "refresh_days": config.refresh_days})
        conn.execute(
            text(
                f"""
                UPDATE {targets} t
                SET initial_completed_at = CASE
                        WHEN c.phase = 'initial_missing' AND t.initial_missing
                        THEN now()
                        ELSE t.initial_completed_at
                    END,
                    last_completed_cycle = CASE
                        WHEN c.phase = 'full_cycle'
                        THEN c.cycle_number
                        ELSE t.last_completed_cycle
                    END,
                    last_cycle_success_at = CASE
                        WHEN c.phase = 'full_cycle'
                        THEN now()
                        ELSE t.last_cycle_success_at
                    END
                FROM {campaign} c
                WHERE c.campaign_key = :campaign_key
                  AND t.account_id = :account_id
                """
            ),
            {"campaign_key": config.campaign_key, "account_id": account_id},
        )
        recovery = conn.execute(
            text(
                f"""
                WITH previous AS (
                    SELECT campaign_key, outage_paused_until
                    FROM {campaign}
                    WHERE campaign_key = :campaign_key
                    FOR UPDATE
                )
                UPDATE {campaign} c
                SET upstream_failure_count = 0,
                    outage_pause_started_at = NULL,
                    outage_paused_until = NULL,
                    outage_last_error = NULL,
                    outage_probe_worker_id = NULL,
                    outage_probe_lease_expires_at = NULL,
                    updated_at = now()
                FROM previous p
                WHERE c.campaign_key = p.campaign_key
                RETURNING (p.outage_paused_until IS NOT NULL) AS recovered
                """
            ),
            {"campaign_key": config.campaign_key},
        ).mappings().first()
    return bool(recovery and recovery["recovered"])


def retry_delay_seconds(config: WorkerConfig, prior_attempts: int) -> int:
    exponent = min(max(prior_attempts, 0), 16)
    return min(config.retry_max_seconds, config.retry_base_seconds * (2**exponent))


def mark_failure(
    engine: Engine,
    config: WorkerConfig,
    account_id: str,
    prior_attempts: int,
    error: BaseException,
) -> int:
    state = _state_table(config)
    delay = retry_delay_seconds(config, prior_attempts)
    message = f"{error.__class__.__name__}: {error}"[:2000]
    sql = text(
        f"""
        UPDATE {state}
        SET status = 'retry',
            attempts = attempts + 1,
            next_attempt_at = now() + make_interval(secs => :delay_seconds),
            lease_expires_at = NULL,
            worker_id = NULL,
            last_error = :last_error,
            updated_at = now()
        WHERE account_id = :account_id
        """
    )
    with engine.begin() as conn:
        conn.execute(
            sql,
            {
                "account_id": account_id,
                "delay_seconds": delay,
                "last_error": message,
            },
        )
    return delay


def release_claim(
    engine: Engine,
    config: WorkerConfig,
    account_id: str,
    worker_id: Optional[str] = None,
) -> None:
    state = _state_table(config)
    campaign = _campaign_table(config)
    with engine.begin() as conn:
        conn.execute(
            text(
                f"""
                UPDATE {state}
                SET status = 'pending',
                    lease_expires_at = NULL,
                    worker_id = NULL,
                    next_attempt_at = now(),
                    updated_at = now()
                WHERE account_id = :account_id
                """
            ),
            {"account_id": account_id},
        )
        if worker_id:
            conn.execute(
                text(
                    f"""
                    UPDATE {campaign}
                    SET outage_probe_worker_id = NULL,
                        outage_probe_lease_expires_at = NULL,
                        updated_at = now()
                    WHERE campaign_key = :campaign_key
                      AND outage_probe_worker_id = :worker_id
                    """
                ),
                {"campaign_key": config.campaign_key, "worker_id": worker_id},
            )


def campaign_status(engine: Engine, config: WorkerConfig) -> dict[str, object]:
    campaign = _campaign_table(config)
    targets = _targets_table(config)
    state = _state_table(config)
    events = _events_table(config)
    with engine.connect() as conn:
        row = conn.execute(
            text(
                f"""
                SELECT c.campaign_key,
                       c.source_filename,
                       c.source_sha256,
                       c.total_source_rows,
                       c.total_valid_targets,
                       c.invalid_source_rows,
                       c.initial_missing_count,
                       c.phase,
                       c.cycle_number,
                       c.loaded_at,
                       c.phase_started_at,
                       c.initial_completed_at,
                       c.current_cycle_started_at,
                       c.last_cycle_completed_at,
                       c.upstream_failure_count,
                       c.outage_pause_started_at,
                       c.outage_paused_until,
                       c.outage_last_error,
                       c.outage_count,
                       c.outage_probe_worker_id,
                       c.outage_probe_lease_expires_at,
                       CASE
                           WHEN c.outage_paused_until IS NULL THEN 'closed'
                           WHEN c.outage_paused_until > now() THEN 'open'
                           ELSE 'half_open'
                       END AS outage_circuit_state,
                       count(t.account_id) FILTER (
                           WHERE t.initial_missing
                             AND t.initial_completed_at IS NOT NULL
                       ) AS initial_completed,
                       count(t.account_id) FILTER (
                           WHERE t.initial_missing
                             AND t.initial_completed_at IS NULL
                       ) AS initial_remaining,
                       count(t.account_id) FILTER (
                           WHERE t.last_completed_cycle >= c.cycle_number
                       ) AS cycle_completed,
                       count(t.account_id) FILTER (
                           WHERE t.last_completed_cycle < c.cycle_number
                       ) AS cycle_remaining,
                       count(t.account_id) FILTER (
                           WHERE s.status = 'retry'
                       ) AS retry_targets,
                       min(t.source_position) FILTER (
                           WHERE (
                               c.phase = 'initial_missing'
                               AND t.initial_missing
                               AND t.initial_completed_at IS NULL
                           ) OR (
                               c.phase = 'full_cycle'
                               AND t.last_completed_cycle < c.cycle_number
                           )
                       ) AS next_source_position
                FROM {campaign} c
                LEFT JOIN {targets} t ON true
                LEFT JOIN {state} s ON s.account_id = t.account_id
                WHERE c.campaign_key = :campaign_key
                GROUP BY c.campaign_key, c.source_filename, c.source_sha256,
                         c.total_source_rows, c.total_valid_targets,
                         c.invalid_source_rows, c.initial_missing_count,
                         c.phase, c.cycle_number, c.loaded_at,
                         c.phase_started_at, c.initial_completed_at,
                         c.current_cycle_started_at, c.last_cycle_completed_at,
                         c.upstream_failure_count, c.outage_pause_started_at,
                         c.outage_paused_until, c.outage_last_error,
                         c.outage_count, c.outage_probe_worker_id,
                         c.outage_probe_lease_expires_at
                """
            ),
            {"campaign_key": config.campaign_key},
        ).mappings().first()
        if row is None:
            return {
                "loaded": False,
                "campaign_key": config.campaign_key,
                "phase": "awaiting_target_import",
            }

        event = conn.execute(
            text(
                f"""
                SELECT event_type, cycle_number, event_payload, created_at
                FROM {events}
                WHERE campaign_key = :campaign_key
                ORDER BY event_id DESC
                LIMIT 1
                """
            ),
            {"campaign_key": config.campaign_key},
        ).mappings().first()

    result = dict(row)
    result["loaded"] = True
    result["outage_failure_threshold"] = config.outage_failure_threshold
    result["outage_pause_seconds"] = config.outage_pause_seconds
    if result["phase"] != "full_cycle":
        result["cycle_completed"] = 0
        result["cycle_remaining"] = result["total_valid_targets"]
    result["latest_event"] = dict(event) if event else None
    return result


def advance_campaign_if_complete(
    engine: Engine, config: WorkerConfig
) -> Optional[dict[str, object]]:
    campaign = _campaign_table(config)
    targets = _targets_table(config)
    events = _events_table(config)
    with engine.begin() as conn:
        current = conn.execute(
            text(
                f"""
                SELECT phase, cycle_number, total_valid_targets,
                       initial_missing_count
                FROM {campaign}
                WHERE campaign_key = :campaign_key
                FOR UPDATE
                """
            ),
            {"campaign_key": config.campaign_key},
        ).mappings().first()
        if current is None:
            return None

        if current["phase"] == "initial_missing":
            remaining = int(
                conn.execute(
                    text(
                        f"""
                        SELECT count(*)
                        FROM {targets}
                        WHERE initial_missing
                          AND initial_completed_at IS NULL
                        """
                    )
                ).scalar_one()
            )
            if remaining:
                return None

            payload = {
                "valid_targets": int(current["total_valid_targets"]),
                "initial_missing_completed": int(current["initial_missing_count"]),
                "next_phase": "full_cycle",
                "next_cycle_number": 1,
            }
            conn.execute(
                text(
                    f"""
                    INSERT INTO {events} (
                        campaign_key, event_type, cycle_number, event_payload
                    ) VALUES (
                        :campaign_key, 'initial_missing_complete', 0,
                        CAST(:payload AS jsonb)
                    )
                    ON CONFLICT (campaign_key, event_type, cycle_number)
                    DO NOTHING
                    """
                ),
                {
                    "campaign_key": config.campaign_key,
                    "payload": json.dumps(payload),
                },
            )
            conn.execute(
                text(
                    f"""
                    UPDATE {campaign}
                    SET phase = 'full_cycle',
                        cycle_number = 1,
                        initial_completed_at = now(),
                        current_cycle_started_at = now(),
                        phase_started_at = now(),
                        updated_at = now()
                    WHERE campaign_key = :campaign_key
                    """
                ),
                {"campaign_key": config.campaign_key},
            )
            return {"event_type": "initial_missing_complete", **payload}

        cycle_number = int(current["cycle_number"])
        remaining = int(
            conn.execute(
                text(
                    f"""
                    SELECT count(*)
                    FROM {targets}
                    WHERE last_completed_cycle < :cycle_number
                    """
                ),
                {"cycle_number": cycle_number},
            ).scalar_one()
        )
        if remaining:
            return None

        payload = {
            "completed_cycle_number": cycle_number,
            "completed_targets": int(current["total_valid_targets"]),
            "next_cycle_number": cycle_number + 1,
        }
        conn.execute(
            text(
                f"""
                INSERT INTO {events} (
                    campaign_key, event_type, cycle_number, event_payload
                ) VALUES (
                    :campaign_key, 'full_cycle_complete', :cycle_number,
                    CAST(:payload AS jsonb)
                )
                ON CONFLICT (campaign_key, event_type, cycle_number)
                DO NOTHING
                """
            ),
            {
                "campaign_key": config.campaign_key,
                "cycle_number": cycle_number,
                "payload": json.dumps(payload),
            },
        )
        conn.execute(
            text(
                f"""
                UPDATE {campaign}
                SET cycle_number = :next_cycle_number,
                    last_cycle_completed_at = now(),
                    current_cycle_started_at = now(),
                    phase_started_at = now(),
                    updated_at = now()
                WHERE campaign_key = :campaign_key
                """
            ),
            {
                "campaign_key": config.campaign_key,
                "next_cycle_number": cycle_number + 1,
            },
        )
        return {"event_type": "full_cycle_complete", **payload}


def _log_campaign_event(event: dict[str, object]) -> None:
    log.warning("DCAD CAMPAIGN EVENT %s", json.dumps(event, default=str, sort_keys=True))


def _sleep(seconds: float) -> None:
    deadline = time.monotonic() + seconds
    while not _stop_requested and time.monotonic() < deadline:
        time.sleep(min(1.0, max(0.0, deadline - time.monotonic())))


def _request_stop(signum, _frame) -> None:
    global _stop_requested
    _stop_requested = True
    log.info("Received signal %s; stopping after the current account", signum)


def run_worker(config: WorkerConfig, once: bool = False) -> int:
    if not os.getenv("DATABASE_URL"):
        raise RuntimeError("DATABASE_URL is not set")

    engine = get_engine()
    if config.auto_migrate:
        ensure_state_schema(engine, config)
    else:
        verify_state_schema(engine, config)

    bootstrapped = bootstrap_existing_successes(engine, config)
    total_targets = target_account_count(engine, config)
    progress = campaign_status(engine, config)
    worker_id = f"{socket.gethostname()}:{os.getpid()}"
    log.info(
        "Worker ready id=%s campaign=%s targets=%d phase=%s cycle=%s "
        "existing_successes_bootstrapped=%d",
        worker_id,
        config.campaign_key,
        total_targets,
        progress.get("phase"),
        progress.get("cycle_number", 0),
        bootstrapped,
    )

    successes = 0
    failures = 0
    while not _stop_requested:
        claim = claim_next_account(engine, config, worker_id)
        if claim is None:
            event = advance_campaign_if_complete(engine, config)
            if event is not None:
                _log_campaign_event(event)
                if once:
                    return 0
                continue
            if once:
                return 0
            progress = campaign_status(engine, config)
            log.info(
                "No campaign target is currently due; phase=%s initial_remaining=%s "
                "cycle=%s cycle_remaining=%s retry_targets=%s circuit=%s "
                "paused_until=%s sleeping=%.1f",
                progress.get("phase"),
                progress.get("initial_remaining"),
                progress.get("cycle_number"),
                progress.get("cycle_remaining"),
                progress.get("retry_targets"),
                progress.get("outage_circuit_state"),
                progress.get("outage_paused_until"),
                config.idle_seconds,
            )
            _sleep(config.idle_seconds)
            continue

        account_id, prior_attempts = claim
        if _stop_requested:
            release_claim(engine, config, account_id, worker_id)
            break

        started = time.monotonic()
        try:
            run_for_account(account_id)
        except Exception as error:
            failures += 1
            delay = mark_failure(engine, config, account_id, prior_attempts, error)
            upstream_outage = is_upstream_outage_error(error)
            if upstream_outage:
                circuit = record_upstream_failure(
                    engine,
                    config,
                    worker_id,
                    error,
                )
                if circuit["paused"]:
                    log.warning(
                        "DCAD outage circuit open account_id=%s failures=%s "
                        "threshold=%d pause_seconds=%d probe_worker=%s",
                        account_id,
                        circuit["failure_count"],
                        config.outage_failure_threshold,
                        config.outage_pause_seconds,
                        circuit["probe_worker"],
                    )
            else:
                recovered = reset_outage_circuit(engine, config)
                if recovered:
                    log.warning(
                        "DCAD outage circuit closed after a reachable non-upstream response"
                    )
            log.error(
                "Scrape failed account_id=%s attempt=%d retry_in_seconds=%d "
                "upstream_outage=%s error=%s",
                account_id,
                prior_attempts + 1,
                delay,
                upstream_outage,
                error,
                exc_info=True,
            )
        else:
            successes += 1
            recovered = mark_success(engine, config, account_id)
            if recovered:
                log.warning(
                    "DCAD outage circuit recovered account_id=%s; campaign resumed",
                    account_id,
                )
            log.info(
                "Scrape succeeded account_id=%s duration_seconds=%.2f totals_success=%d totals_failed=%d",
                account_id,
                time.monotonic() - started,
                successes,
                failures,
            )

        if once:
            break
        _sleep(config.delay_seconds)

    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Continuously refresh Dallas CAD account data")
    parser.add_argument("--once", action="store_true", help="Process at most one due account and exit")
    parser.add_argument(
        "--migrate-only",
        action="store_true",
        help="Create/verify the scrape state table, bootstrap existing successes, and exit",
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=os.getenv("LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    signal.signal(signal.SIGTERM, _request_stop)
    signal.signal(signal.SIGINT, _request_stop)

    config = WorkerConfig.from_env()
    if args.migrate_only:
        engine = get_engine()
        ensure_state_schema(engine, config)
        bootstrapped = bootstrap_existing_successes(engine, config)
        log.info("Scrape state schema ready; bootstrapped=%d", bootstrapped)
        log.info("Campaign status: %s", json.dumps(campaign_status(engine, config), default=str))
        return 0
    return run_worker(config, once=args.once)


if __name__ == "__main__":
    raise SystemExit(main())

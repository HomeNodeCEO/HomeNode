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

from sqlalchemy import Engine, text

from dcad.account_recovery import dcad_site_is_healthy, exact_candidates, search_by_address
from dcad.data_quality import CompletenessAssessment, IncompleteScrapeError
from dcad.fetch import browser
from dcad.run_once import run_for_account
from dcad.upsert import get_engine


log = logging.getLogger("dcad.worker")
_stop_requested = False
DEFAULT_CAMPAIGN_KEY = "dallas_residential"


def _identifier(value: str, label: str) -> str:
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", value):
        raise ValueError(f"Invalid {label}: {value!r}")
    return value


def _qualified_table(schema_value: str, table_value: str, label: str) -> str:
    """Build one quoted table reference only from locally validated identifiers."""

    schema = _identifier(schema_value, f"{label} schema")
    table = _identifier(table_value, f"{label} table")
    return f'"{schema}"."{table}"'


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
    auto_migrate: bool
    account_id_regex: str
    recovery_attempt_threshold: int
    recovery_every_accounts: int
    recovery_health_account_id: str
    market_value_recheck_days: int
    market_value_recheck_every_accounts: int
    owner_recovery_every_accounts: int
    field_repair_every_accounts: int

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
            auto_migrate=_env_bool("SCRAPE_AUTO_MIGRATE", True),
            account_id_regex=os.getenv("SCRAPE_ACCOUNT_ID_REGEX", r"^[[:alnum:]]{17}$"),
            recovery_attempt_threshold=max(
                2, int(os.getenv("SCRAPE_RECOVERY_ATTEMPTS", "3"))
            ),
            recovery_every_accounts=max(
                1, int(os.getenv("SCRAPE_RECOVERY_EVERY_ACCOUNTS", "25"))
            ),
            recovery_health_account_id=os.getenv(
                "SCRAPE_HEALTH_ACCOUNT_ID", "26272500060150000"
            ).strip(),
            market_value_recheck_days=max(
                1, int(os.getenv("SCRAPE_MARKET_VALUE_RECHECK_DAYS", "7"))
            ),
            market_value_recheck_every_accounts=max(
                1,
                int(os.getenv("SCRAPE_MARKET_VALUE_RECHECK_EVERY_ACCOUNTS", "100")),
            ),
            owner_recovery_every_accounts=max(
                1, int(os.getenv("SCRAPE_OWNER_RECOVERY_EVERY_ACCOUNTS", "25"))
            ),
            field_repair_every_accounts=max(
                1, int(os.getenv("SCRAPE_FIELD_REPAIR_EVERY_ACCOUNTS", "5"))
            ),
        )


def _state_table(config: WorkerConfig) -> str:
    return _qualified_table(config.state_schema, "dcad_scrape_state", "scrape state")


def _accounts_table(config: WorkerConfig) -> str:
    return _qualified_table(config.data_schema, "accounts", "accounts")


def _owner_summary_table(config: WorkerConfig) -> str:
    return _qualified_table(config.data_schema, "owner_summary", "owner summary")


def _raw_table(config: WorkerConfig) -> str:
    return _qualified_table(config.data_schema, "dcad_json_raw", "raw data")


def _targets_table(config: WorkerConfig) -> str:
    return _qualified_table(
        config.state_schema, "dcad_residential_targets", "campaign targets"
    )


def _campaign_table(config: WorkerConfig) -> str:
    return _qualified_table(config.state_schema, "dcad_residential_campaign", "campaign")


def _events_table(config: WorkerConfig) -> str:
    return _qualified_table(
        config.state_schema, "dcad_campaign_events", "campaign events"
    )


def _reconciliations_table(config: WorkerConfig) -> str:
    return _qualified_table(
        config.state_schema, "dcad_account_reconciliations", "reconciliations"
    )


def _owner_recovery_table(config: WorkerConfig) -> str:
    return _qualified_table(
        config.state_schema, "dcad_owner_recovery_queue", "owner recovery"
    )


def _field_repair_table(config: WorkerConfig) -> str:
    return _qualified_table(
        config.state_schema, "dcad_field_repair_queue", "field repair"
    )


def ensure_state_schema(engine: Engine, config: WorkerConfig) -> None:
    state_schema = _identifier(config.state_schema, "scrape state schema")
    state = _state_table(config)
    ddl = f"""
        CREATE SCHEMA IF NOT EXISTS "{state_schema}";
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
        migrations = Path(__file__).resolve().parents[2] / "migrations"
        for migration_name in (
            "003_dcad_residential_campaign.sql",
            "011_dcad_data_quality_recovery.sql",
            "012_dcad_market_value_rechecks.sql",
            "016_dcad_owner_recovery_queue.sql",
            "024_dcad_field_repair_queue.sql",
        ):
            migration = migrations / migration_name
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
        WITH candidate AS (
            SELECT t.account_id
            FROM {targets} t
            JOIN {campaign} c ON c.campaign_key = :campaign_key
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


def mark_success(
    engine: Engine,
    config: WorkerConfig,
    account_id: str,
    assessment: CompletenessAssessment,
) -> None:
    state = _state_table(config)
    targets = _targets_table(config)
    campaign = _campaign_table(config)
    market_value_present = assessment.market_value_present
    quality_status = (
        "complete" if market_value_present else "complete_missing_market_value"
    )
    quality_flags = (
        []
        if market_value_present
        else ["missing_market_value", "possible_active_protest"]
    )
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
            quality_status = :quality_status,
            quality_flags = CAST(:quality_flags AS text[]),
            canonical_account_id = :account_id,
            market_value_status = CASE
                WHEN :market_value_present THEN 'present'
                ELSE 'pending'
            END,
            market_value_attempts = CASE
                WHEN :market_value_present THEN 0
                ELSE market_value_attempts + 1
            END,
            market_value_missing_since = CASE
                WHEN :market_value_present THEN NULL
                ELSE COALESCE(market_value_missing_since, now())
            END,
            market_value_last_checked_at = now(),
            market_value_next_check_at = CASE
                WHEN :market_value_present THEN NULL
                ELSE now() + make_interval(days => :market_value_recheck_days)
            END,
            updated_at = now()
        WHERE account_id = :account_id
        """
    )
    with engine.begin() as conn:
        params = {
            "account_id": account_id,
            "refresh_days": config.refresh_days,
            "quality_status": quality_status,
            "quality_flags": "{" + ",".join(quality_flags) + "}",
            "market_value_present": market_value_present,
            "market_value_recheck_days": config.market_value_recheck_days,
        }
        conn.execute(sql, params)
        conn.execute(
            text(
                f"""
                UPDATE {_accounts_table(config)}
                SET data_quality_status = :quality_status,
                    data_quality_flags = CAST(:quality_flags AS text[]),
                    canonical_account_id = NULL
                WHERE account_id = :account_id
                """
            ),
            params,
        )
        conn.execute(
            text(
                f"""
                UPDATE {_reconciliations_table(config)}
                SET status = 'source_confirmed',
                    canonical_account_id = :account_id,
                    match_method = 'direct_retry',
                    match_confidence = 1,
                    lease_expires_at = NULL,
                    worker_id = NULL,
                    last_error = NULL,
                    resolved_at = now(),
                    updated_at = now()
                WHERE source_account_id = :account_id
                  AND status IN ('pending_search', 'retry', 'leased')
                """
            ),
            {"account_id": account_id},
        )
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


def record_market_value_assessment(
    engine: Engine,
    config: WorkerConfig,
    account_id: str,
    assessment: CompletenessAssessment,
) -> None:
    """Track value availability for a canonical ID found by address recovery."""

    market_value_present = assessment.market_value_present
    quality_status = (
        "complete" if market_value_present else "complete_missing_market_value"
    )
    quality_flags = (
        []
        if market_value_present
        else ["missing_market_value", "possible_active_protest"]
    )
    params = {
        "account_id": account_id,
        "refresh_days": config.refresh_days,
        "market_value_present": market_value_present,
        "market_value_recheck_days": config.market_value_recheck_days,
        "quality_status": quality_status,
        "quality_flags": "{" + ",".join(quality_flags) + "}",
    }
    with engine.begin() as conn:
        conn.execute(
            text(
                f"""
                INSERT INTO {_state_table(config)} AS existing (
                    account_id, status, attempts, last_attempt_at,
                    last_success_at, next_attempt_at, quality_status,
                    quality_flags, market_value_status,
                    market_value_attempts, market_value_missing_since,
                    market_value_last_checked_at, market_value_next_check_at,
                    updated_at
                ) VALUES (
                    :account_id, 'succeeded', 0, now(), now(),
                    now() + make_interval(days => :refresh_days),
                    :quality_status, CAST(:quality_flags AS text[]),
                    CASE WHEN :market_value_present THEN 'present' ELSE 'pending' END,
                    CASE WHEN :market_value_present THEN 0 ELSE 1 END,
                    CASE WHEN :market_value_present THEN NULL ELSE now() END,
                    now(),
                    CASE
                        WHEN :market_value_present THEN NULL
                        ELSE now() + make_interval(days => :market_value_recheck_days)
                    END,
                    now()
                )
                ON CONFLICT (account_id) DO UPDATE
                SET quality_status = EXCLUDED.quality_status,
                    quality_flags = EXCLUDED.quality_flags,
                    market_value_status = EXCLUDED.market_value_status,
                    market_value_attempts = CASE
                        WHEN :market_value_present THEN 0
                        ELSE existing.market_value_attempts + 1
                    END,
                    market_value_missing_since = CASE
                        WHEN :market_value_present THEN NULL
                        ELSE COALESCE(
                            existing.market_value_missing_since,
                            now()
                        )
                    END,
                    market_value_last_checked_at = now(),
                    market_value_next_check_at = EXCLUDED.market_value_next_check_at,
                    updated_at = now()
                """
            ),
            params,
        )
        conn.execute(
            text(
                f"""
                UPDATE {_accounts_table(config)}
                SET data_quality_status = :quality_status,
                    data_quality_flags = CAST(:quality_flags AS text[])
                WHERE account_id = :account_id
                """
            ),
            params,
        )


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
    incomplete = isinstance(error, IncompleteScrapeError)
    quality_status = "incomplete" if incomplete else "scrape_error"
    quality_flags = (
        list(error.assessment.reasons) if incomplete else ["scrape_error"]
    )
    sql = text(
        f"""
        UPDATE {state}
        SET status = 'retry',
            attempts = attempts + 1,
            next_attempt_at = now() + make_interval(secs => :delay_seconds),
            lease_expires_at = NULL,
            worker_id = NULL,
            last_error = :last_error,
            quality_status = :quality_status,
            quality_flags = CAST(:quality_flags AS text[]),
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
                "quality_status": quality_status,
                "quality_flags": "{" + ",".join(quality_flags) + "}",
            },
        )
        conn.execute(
            text(
                f"""
                UPDATE {_accounts_table(config)}
                SET data_quality_status = :quality_status,
                    data_quality_flags = CAST(:quality_flags AS text[])
                WHERE account_id = :account_id
                """
            ),
            {
                "account_id": account_id,
                "quality_status": quality_status,
                "quality_flags": "{" + ",".join(quality_flags) + "}",
            },
        )
    return delay


def release_claim(engine: Engine, config: WorkerConfig, account_id: str) -> None:
    state = _state_table(config)
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


def claim_next_market_value_recheck(
    engine: Engine,
    config: WorkerConfig,
    worker_id: str,
) -> Optional[tuple[str, int]]:
    state = _state_table(config)
    sql = text(
        f"""
        WITH candidate AS (
            SELECT s.account_id
            FROM {state} s
            WHERE s.market_value_status IN ('pending', 'retry')
              AND COALESCE(s.market_value_next_check_at, now()) <= now()
              AND (s.lease_expires_at IS NULL OR s.lease_expires_at <= now())
            ORDER BY s.market_value_next_check_at NULLS FIRST, s.account_id
            FOR UPDATE OF s SKIP LOCKED
            LIMIT 1
        )
        UPDATE {state} s
        SET market_value_status = 'leased',
            lease_expires_at = now() + make_interval(mins => :lease_minutes),
            worker_id = :worker_id,
            updated_at = now()
        FROM candidate c
        WHERE s.account_id = c.account_id
        RETURNING s.account_id, s.market_value_attempts
        """
    )
    with engine.begin() as conn:
        row = conn.execute(
            sql,
            {
                "lease_minutes": config.lease_minutes,
                "worker_id": worker_id,
            },
        ).mappings().first()
    if row is None:
        return None
    return str(row["account_id"]), int(row["market_value_attempts"])


def mark_market_value_recheck_failure(
    engine: Engine,
    config: WorkerConfig,
    account_id: str,
    prior_attempts: int,
    error: BaseException,
) -> int:
    delay = retry_delay_seconds(config, prior_attempts)
    message = f"{error.__class__.__name__}: {error}"[:2000]
    with engine.begin() as conn:
        conn.execute(
            text(
                f"""
                UPDATE {_state_table(config)}
                SET market_value_status = 'retry',
                    market_value_attempts = market_value_attempts + 1,
                    market_value_last_checked_at = now(),
                    market_value_next_check_at = now() + make_interval(secs => :delay_seconds),
                    lease_expires_at = NULL,
                    worker_id = NULL,
                    last_error = :last_error,
                    quality_status = 'complete_missing_market_value',
                    quality_flags = ARRAY['missing_market_value', 'possible_active_protest'],
                    updated_at = now()
                WHERE account_id = :account_id
                """
            ),
            {
                "account_id": account_id,
                "delay_seconds": delay,
                "last_error": message,
            },
        )
    return delay


def release_market_value_claim(
    engine: Engine, config: WorkerConfig, account_id: str
) -> None:
    with engine.begin() as conn:
        conn.execute(
            text(
                f"""
                UPDATE {_state_table(config)}
                SET market_value_status = 'pending',
                    lease_expires_at = NULL,
                    worker_id = NULL,
                    market_value_next_check_at = now(),
                    updated_at = now()
                WHERE account_id = :account_id
                """
            ),
            {"account_id": account_id},
        )


def claim_next_owner_recovery(
    engine: Engine,
    config: WorkerConfig,
    worker_id: str,
) -> Optional[tuple[str, int]]:
    queue = _owner_recovery_table(config)
    sql = text(
        f"""
        WITH candidate AS (
            SELECT q.account_id
            FROM {queue} q
            WHERE q.status IN ('pending', 'retry')
              AND q.next_attempt_at <= now()
              AND (q.lease_expires_at IS NULL OR q.lease_expires_at <= now())
            ORDER BY q.next_attempt_at, q.account_id
            FOR UPDATE OF q SKIP LOCKED
            LIMIT 1
        )
        UPDATE {queue} q
        SET status = 'leased',
            last_attempt_at = now(),
            lease_expires_at = now() + make_interval(mins => :lease_minutes),
            worker_id = :worker_id,
            updated_at = now()
        FROM candidate c
        WHERE q.account_id = c.account_id
        RETURNING q.account_id, q.attempts
        """
    )
    with engine.begin() as conn:
        row = conn.execute(
            sql,
            {
                "lease_minutes": config.lease_minutes,
                "worker_id": worker_id,
            },
        ).mappings().first()
    if row is None:
        return None
    return str(row["account_id"]), int(row["attempts"])


def owner_name_is_complete(
    engine: Engine, config: WorkerConfig, account_id: str
) -> bool:
    owner_summary = _owner_summary_table(config)
    with engine.connect() as conn:
        owner_name = conn.execute(
            text(
                f"""
                SELECT owner_name
                FROM {owner_summary}
                WHERE account_id = :account_id
                ORDER BY tax_year DESC
                LIMIT 1
                """
            ),
            {"account_id": account_id},
        ).scalar_one_or_none()
    return bool(owner_name and not re.search(r"&\s*$", str(owner_name)))


def mark_owner_recovery_success(
    engine: Engine, config: WorkerConfig, account_id: str
) -> None:
    with engine.begin() as conn:
        conn.execute(
            text(
                f"""
                UPDATE {_owner_recovery_table(config)}
                SET status = 'succeeded',
                    attempts = 0,
                    last_success_at = now(),
                    lease_expires_at = NULL,
                    worker_id = NULL,
                    last_error = NULL,
                    updated_at = now()
                WHERE account_id = :account_id
                """
            ),
            {"account_id": account_id},
        )


def mark_owner_recovery_failure(
    engine: Engine,
    config: WorkerConfig,
    account_id: str,
    prior_attempts: int,
    error: BaseException,
) -> int:
    delay = retry_delay_seconds(config, prior_attempts)
    message = f"{error.__class__.__name__}: {error}"[:2000]
    with engine.begin() as conn:
        conn.execute(
            text(
                f"""
                UPDATE {_owner_recovery_table(config)}
                SET status = 'retry',
                    attempts = attempts + 1,
                    next_attempt_at = now() + make_interval(secs => :delay_seconds),
                    lease_expires_at = NULL,
                    worker_id = NULL,
                    last_error = :last_error,
                    updated_at = now()
                WHERE account_id = :account_id
                """
            ),
            {
                "account_id": account_id,
                "delay_seconds": delay,
                "last_error": message,
            },
        )
    return delay


def release_owner_recovery_claim(
    engine: Engine, config: WorkerConfig, account_id: str
) -> None:
    with engine.begin() as conn:
        conn.execute(
            text(
                f"""
                UPDATE {_owner_recovery_table(config)}
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


def claim_next_field_repair(
    engine: Engine,
    config: WorkerConfig,
    worker_id: str,
) -> Optional[tuple[str, int]]:
    queue = _field_repair_table(config)
    with engine.begin() as conn:
        row = conn.execute(
            text(
                f"""
                WITH candidate AS (
                    SELECT q.account_id
                    FROM {queue} q
                    WHERE q.status IN ('pending', 'retry')
                      AND q.next_attempt_at <= now()
                      AND (q.lease_expires_at IS NULL OR q.lease_expires_at <= now())
                    ORDER BY q.next_attempt_at, q.account_id
                    FOR UPDATE OF q SKIP LOCKED
                    LIMIT 1
                )
                UPDATE {queue} q
                SET status = 'leased',
                    last_attempt_at = now(),
                    lease_expires_at = now() + make_interval(mins => :lease_minutes),
                    worker_id = :worker_id,
                    updated_at = now()
                FROM candidate c
                WHERE q.account_id = c.account_id
                RETURNING q.account_id, q.attempts
                """
            ),
            {
                "lease_minutes": config.lease_minutes,
                "worker_id": worker_id,
            },
        ).mappings().first()
    if row is None:
        return None
    return str(row["account_id"]), int(row["attempts"])


def mark_field_repair_success(
    engine: Engine, config: WorkerConfig, account_id: str
) -> None:
    with engine.begin() as conn:
        conn.execute(
            text(
                f"""
                UPDATE {_field_repair_table(config)}
                SET status = 'succeeded',
                    attempts = 0,
                    last_success_at = now(),
                    lease_expires_at = NULL,
                    worker_id = NULL,
                    last_error = NULL,
                    updated_at = now()
                WHERE account_id = :account_id
                """
            ),
            {"account_id": account_id},
        )


def mark_field_repair_failure(
    engine: Engine,
    config: WorkerConfig,
    account_id: str,
    prior_attempts: int,
    error: BaseException,
) -> int:
    delay = retry_delay_seconds(config, prior_attempts)
    message = f"{error.__class__.__name__}: {error}"[:2000]
    with engine.begin() as conn:
        conn.execute(
            text(
                f"""
                UPDATE {_field_repair_table(config)}
                SET status = 'retry',
                    attempts = attempts + 1,
                    next_attempt_at = now() + make_interval(secs => :delay_seconds),
                    lease_expires_at = NULL,
                    worker_id = NULL,
                    last_error = :last_error,
                    updated_at = now()
                WHERE account_id = :account_id
                """
            ),
            {
                "account_id": account_id,
                "delay_seconds": delay,
                "last_error": message,
            },
        )
    return delay


def release_field_repair_claim(
    engine: Engine, config: WorkerConfig, account_id: str
) -> None:
    with engine.begin() as conn:
        conn.execute(
            text(
                f"""
                UPDATE {_field_repair_table(config)}
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


def enqueue_address_recovery(
    engine: Engine,
    config: WorkerConfig,
    account_id: str,
    reason: str,
) -> bool:
    targets = _targets_table(config)
    accounts = _accounts_table(config)
    reconciliations = _reconciliations_table(config)
    with engine.begin() as conn:
        source = conn.execute(
            text(
                f"""
                SELECT COALESCE(NULLIF(btrim(t.source_address), ''),
                               NULLIF(btrim(a.address), '')) AS source_address,
                       COALESCE(NULLIF(btrim(t.source_city), ''),
                                NULLIF(btrim(a.city), '')) AS source_city,
                       COALESCE(NULLIF(btrim(t.source_postal_code), ''),
                                NULLIF(btrim(a.postal_code), '')) AS source_postal_code
                FROM {accounts} a
                LEFT JOIN {targets} t ON t.account_id = a.account_id
                WHERE a.account_id = :account_id
                """
            ),
            {"account_id": account_id},
        ).mappings().first()
        if source is None:
            return False

        has_address = bool(str(source["source_address"] or "").strip())
        status = "pending_search" if has_address else "needs_review"
        conn.execute(
            text(
                f"""
                INSERT INTO {reconciliations} (
                    source_account_id, source_address, source_city,
                    source_postal_code, status, next_attempt_at, evidence
                ) VALUES (
                    :account_id, :source_address, :source_city,
                    :source_postal_code, :status, now(),
                    CAST(:evidence AS jsonb)
                )
                ON CONFLICT (source_account_id) DO UPDATE SET
                    source_address = COALESCE(EXCLUDED.source_address,
                                              {reconciliations}.source_address),
                    source_city = COALESCE(EXCLUDED.source_city,
                                           {reconciliations}.source_city),
                    source_postal_code = COALESCE(EXCLUDED.source_postal_code,
                                                  {reconciliations}.source_postal_code),
                    status = CASE
                        WHEN {reconciliations}.status IN (
                            'auto_matched', 'manual_matched', 'source_confirmed',
                            'verified_invalid'
                        ) THEN {reconciliations}.status
                        ELSE EXCLUDED.status
                    END,
                    next_attempt_at = CASE
                        WHEN {reconciliations}.status IN (
                            'auto_matched', 'manual_matched', 'source_confirmed',
                            'verified_invalid'
                        ) THEN {reconciliations}.next_attempt_at
                        ELSE now()
                    END,
                    evidence = {reconciliations}.evidence || EXCLUDED.evidence,
                    updated_at = now()
                """
            ),
            {
                "account_id": account_id,
                "source_address": source["source_address"],
                "source_city": source["source_city"],
                "source_postal_code": source["source_postal_code"],
                "status": status,
                "evidence": json.dumps(
                    {"reason": reason, "queued_by": "continuous_worker"}
                ),
            },
        )
        conn.execute(
            text(
                f"""
                UPDATE {accounts}
                SET data_quality_status = :quality_status,
                    data_quality_flags = ARRAY['incomplete_scrape', 'address_recovery']
                WHERE account_id = :account_id
                """
            ),
            {
                "account_id": account_id,
                "quality_status": "recovery_queued" if has_address else "needs_review",
            },
        )
    return has_address


def claim_next_reconciliation(
    engine: Engine,
    config: WorkerConfig,
    worker_id: str,
) -> Optional[dict[str, object]]:
    reconciliations = _reconciliations_table(config)
    sql = text(
        f"""
        WITH candidate AS (
            SELECT source_account_id
            FROM {reconciliations}
            WHERE status IN ('pending_search', 'retry')
              AND next_attempt_at <= now()
              AND (lease_expires_at IS NULL OR lease_expires_at <= now())
            ORDER BY next_attempt_at, created_at
            FOR UPDATE SKIP LOCKED
            LIMIT 1
        )
        UPDATE {reconciliations} r
        SET status = 'leased',
            attempts = r.attempts + 1,
            last_attempt_at = now(),
            lease_expires_at = now() + make_interval(mins => :lease_minutes),
            worker_id = :worker_id,
            last_error = NULL,
            updated_at = now()
        FROM candidate c
        WHERE r.source_account_id = c.source_account_id
        RETURNING r.source_account_id, r.source_address, r.source_city,
                  r.source_postal_code, r.attempts
        """
    )
    with engine.begin() as conn:
        row = conn.execute(
            sql,
            {"lease_minutes": config.lease_minutes, "worker_id": worker_id},
        ).mappings().first()
    return dict(row) if row else None


def mark_reconciliation_retry(
    engine: Engine,
    config: WorkerConfig,
    claim: dict[str, object],
    error: BaseException,
) -> int:
    reconciliations = _reconciliations_table(config)
    attempts = int(claim.get("attempts") or 1)
    delay = retry_delay_seconds(config, max(0, attempts - 1))
    with engine.begin() as conn:
        conn.execute(
            text(
                f"""
                UPDATE {reconciliations}
                SET status = 'retry',
                    next_attempt_at = now() + make_interval(secs => :delay),
                    lease_expires_at = NULL,
                    worker_id = NULL,
                    last_error = :error,
                    updated_at = now()
                WHERE source_account_id = :account_id
                """
            ),
            {
                "account_id": claim["source_account_id"],
                "delay": delay,
                "error": f"{error.__class__.__name__}: {error}"[:2000],
            },
        )
    return delay


def mark_reconciliation_review(
    engine: Engine,
    config: WorkerConfig,
    claim: dict[str, object],
    *,
    reason: str,
    candidates: list[object],
) -> None:
    reconciliations = _reconciliations_table(config)
    accounts = _accounts_table(config)
    targets = _targets_table(config)
    evidence_candidates = [
        {
            "account_id": getattr(candidate, "account_id", None),
            "address": getattr(candidate, "address", None),
            "city": getattr(candidate, "city", None),
        }
        for candidate in candidates
    ]
    with engine.begin() as conn:
        conn.execute(
            text(
                f"""
                UPDATE {reconciliations}
                SET status = 'needs_review',
                    candidate_count = :candidate_count,
                    lease_expires_at = NULL,
                    worker_id = NULL,
                    last_error = :reason,
                    evidence = evidence || CAST(:evidence AS jsonb),
                    updated_at = now()
                WHERE source_account_id = :account_id
                """
            ),
            {
                "account_id": claim["source_account_id"],
                "candidate_count": len(candidates),
                "reason": reason,
                "evidence": json.dumps(
                    {"review_reason": reason, "candidates": evidence_candidates}
                ),
            },
        )
        conn.execute(
            text(
                f"""
                UPDATE {accounts}
                SET data_quality_status = CASE
                        WHEN EXISTS (
                            SELECT 1 FROM {targets} t
                            WHERE t.account_id = :account_id
                        ) THEN 'needs_review'
                        ELSE 'legacy_review'
                    END,
                    data_quality_flags = CASE
                        WHEN EXISTS (
                            SELECT 1 FROM {targets} t
                            WHERE t.account_id = :account_id
                        ) THEN ARRAY['incomplete_scrape', 'review_required']
                        ELSE ARRAY['legacy_account', 'review_required']
                    END
                WHERE account_id = :account_id
                """
            ),
            {"account_id": claim["source_account_id"]},
        )


def complete_reconciliation(
    engine: Engine,
    config: WorkerConfig,
    claim: dict[str, object],
    canonical_account_id: str,
    candidate: object,
    candidate_postal_code: str | None,
) -> None:
    source_account_id = str(claim["source_account_id"])
    reconciliations = _reconciliations_table(config)
    accounts = _accounts_table(config)
    state = _state_table(config)
    targets = _targets_table(config)
    campaign = _campaign_table(config)
    is_alias = canonical_account_id != source_account_id
    evidence = json.dumps(
        {
            "selected_candidate": {
                "account_id": canonical_account_id,
                "address": getattr(candidate, "address", None),
                "city": getattr(candidate, "city", None),
                "postal_code": candidate_postal_code,
            },
            "validation": (
                "unique_exact_normalized_address_city_postal_with_complete_detail"
                if candidate_postal_code
                else "unique_exact_normalized_address_and_city_with_complete_detail"
            ),
        }
    )
    with engine.begin() as conn:
        conn.execute(
            text(
                f"""
                UPDATE {reconciliations}
                SET status = 'auto_matched',
                    canonical_account_id = :canonical_account_id,
                    match_method = :match_method,
                    match_confidence = 1,
                    candidate_count = 1,
                    lease_expires_at = NULL,
                    worker_id = NULL,
                    last_error = NULL,
                    evidence = evidence || CAST(:evidence AS jsonb),
                    resolved_at = now(),
                    updated_at = now()
                WHERE source_account_id = :source_account_id
                """
            ),
            {
                "source_account_id": source_account_id,
                "canonical_account_id": canonical_account_id,
                "match_method": (
                    "exact_address_city_postal"
                    if candidate_postal_code
                    else "exact_address_city"
                ),
                "evidence": evidence,
            },
        )
        conn.execute(
            text(
                f"""
                UPDATE {accounts}
                SET data_quality_status = :quality_status,
                    data_quality_flags = :quality_flags,
                    canonical_account_id = :canonical_account_id
                WHERE account_id = :source_account_id
                """
            ),
            {
                "source_account_id": source_account_id,
                "canonical_account_id": canonical_account_id if is_alias else None,
                "quality_status": "legacy_resolved" if is_alias else "complete",
                "quality_flags": (
                    ["legacy_account", "canonical_account_available"] if is_alias else []
                ),
            },
        )
        conn.execute(
            text(
                f"""
                UPDATE {accounts}
                SET data_quality_status = COALESCE(data_quality_status, 'complete')
                WHERE account_id = :canonical_account_id
                """
            ),
            {"canonical_account_id": canonical_account_id},
        )
        conn.execute(
            text(
                f"""
                UPDATE {state}
                SET status = 'succeeded',
                    attempts = 0,
                    last_success_at = now(),
                    next_attempt_at = now() + make_interval(days => :refresh_days),
                    lease_expires_at = NULL,
                    worker_id = NULL,
                    last_error = NULL,
                    quality_status = :quality_status,
                    quality_flags = :quality_flags,
                    canonical_account_id = :canonical_account_id,
                    updated_at = now()
                WHERE account_id = :source_account_id
                """
            ),
            {
                "source_account_id": source_account_id,
                "canonical_account_id": canonical_account_id,
                "refresh_days": config.refresh_days,
                "quality_status": "legacy_resolved" if is_alias else "complete",
                "quality_flags": (
                    ["legacy_account", "canonical_account_available"] if is_alias else []
                ),
            },
        )
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
                  AND t.account_id = :source_account_id
                """
            ),
            {
                "campaign_key": config.campaign_key,
                "source_account_id": source_account_id,
            },
        )


def process_reconciliation(
    engine: Engine,
    config: WorkerConfig,
    claim: dict[str, object],
) -> str:
    source_account_id = str(claim["source_account_id"])
    source_address = str(claim.get("source_address") or "").strip()
    source_city = str(claim.get("source_city") or "").strip() or None
    source_postal_code = re.sub(
        r"\D", "", str(claim.get("source_postal_code") or "")
    )[:5] or None
    if not source_address:
        mark_reconciliation_review(
            engine,
            config,
            claim,
            reason="No source address is available for DCAD recovery",
            candidates=[],
        )
        return "needs_review"

    with browser() as session:
        if not dcad_site_is_healthy(session, config.recovery_health_account_id):
            raise RuntimeError("DCAD health probe failed; address recovery deferred")
        candidates = search_by_address(session, source_address, source_city)
    matches = exact_candidates(candidates, source_address, source_city)
    if len(matches) != 1:
        reason = (
            "No exact DCAD address match"
            if not matches
            else "Multiple exact DCAD address matches"
        )
        mark_reconciliation_review(
            engine,
            config,
            claim,
            reason=reason,
            candidates=matches or candidates,
        )
        return "needs_review"

    selected = matches[0]
    with engine.connect() as conn:
        candidate_postal_code = conn.execute(
            text(
                f"""
                SELECT COALESCE(NULLIF(btrim(t.source_postal_code), ''),
                               NULLIF(btrim(a.postal_code), ''))
                FROM {_accounts_table(config)} a
                LEFT JOIN {_targets_table(config)} t
                  ON t.account_id = a.account_id
                WHERE a.account_id = :account_id
                """
            ),
            {"account_id": selected.account_id},
        ).scalar_one_or_none()
    candidate_postal_code = re.sub(
        r"\D", "", str(candidate_postal_code or "")
    )[:5] or None
    if source_postal_code and candidate_postal_code != source_postal_code:
        mark_reconciliation_review(
            engine,
            config,
            claim,
            reason=(
                "Exact address candidate ZIP does not match the source ZIP"
                if candidate_postal_code
                else "Exact address candidate has no ZIP available for verification"
            ),
            candidates=matches,
        )
        return "needs_review"

    assessment = run_for_account(selected.account_id)
    complete_reconciliation(
        engine,
        config,
        claim,
        selected.account_id,
        selected,
        candidate_postal_code,
    )
    record_market_value_assessment(
        engine, config, selected.account_id, assessment
    )
    log.warning(
        "DCAD account reconciled source_account_id=%s canonical_account_id=%s address=%s",
        source_account_id,
        selected.account_id,
        source_address,
    )
    return "auto_matched"


def campaign_status(engine: Engine, config: WorkerConfig) -> dict[str, object]:
    campaign = _campaign_table(config)
    targets = _targets_table(config)
    state = _state_table(config)
    events = _events_table(config)
    reconciliations = _reconciliations_table(config)
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
                         c.current_cycle_started_at, c.last_cycle_completed_at
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
        quality = conn.execute(
            text(
                f"""
                SELECT count(*) FILTER (
                           WHERE status IN ('pending_search', 'retry', 'leased')
                       ) AS recovery_pending,
                       count(*) FILTER (
                           WHERE status = 'needs_review'
                       ) AS needs_review,
                       count(*) FILTER (
                           WHERE status IN (
                               'auto_matched', 'manual_matched', 'source_confirmed'
                           )
                       ) AS resolved
                FROM {reconciliations}
                """
            )
        ).mappings().one()
        market_value_quality = conn.execute(
            text(
                f"""
                SELECT count(*) FILTER (
                           WHERE market_value_status IN ('pending', 'retry', 'leased')
                       ) AS market_value_pending,
                       count(*) FILTER (
                           WHERE market_value_status = 'present'
                       ) AS market_value_present
                FROM {state}
                """
            )
        ).mappings().one()
        owner_quality = conn.execute(
            text(
                f"""
                SELECT count(*) FILTER (
                           WHERE status IN ('pending', 'retry', 'leased')
                       ) AS owner_recovery_pending,
                       count(*) FILTER (
                           WHERE status = 'succeeded'
                       ) AS owner_recovery_succeeded
                FROM {_owner_recovery_table(config)}
                """
            )
        ).mappings().one()
        field_repair_quality = conn.execute(
            text(
                f"""
                SELECT count(*) FILTER (
                           WHERE status IN ('pending', 'retry', 'leased')
                       ) AS field_repair_pending,
                       count(*) FILTER (
                           WHERE status = 'succeeded'
                       ) AS field_repair_succeeded
                FROM {_field_repair_table(config)}
                """
            )
        ).mappings().one()

    result = dict(row)
    result["loaded"] = True
    if result["phase"] != "full_cycle":
        result["cycle_completed"] = 0
        result["cycle_remaining"] = result["total_valid_targets"]
    result["latest_event"] = dict(event) if event else None
    result["data_quality"] = {
        **dict(quality),
        **dict(market_value_quality),
        **dict(owner_quality),
        **dict(field_repair_quality),
    }
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


def process_reconciliation_claim_safely(
    engine: Engine,
    config: WorkerConfig,
    claim: dict[str, object],
) -> None:
    try:
        outcome = process_reconciliation(engine, config, claim)
        log.info(
            "Address recovery finished source_account_id=%s outcome=%s",
            claim["source_account_id"],
            outcome,
        )
    except Exception as error:
        delay = mark_reconciliation_retry(engine, config, claim, error)
        log.error(
            "Address recovery failed source_account_id=%s retry_in_seconds=%d error=%s",
            claim["source_account_id"],
            delay,
            error,
            exc_info=True,
        )


def process_market_value_recheck_safely(
    engine: Engine,
    config: WorkerConfig,
    account_id: str,
    prior_attempts: int,
) -> None:
    if _stop_requested:
        release_market_value_claim(engine, config, account_id)
        return
    try:
        assessment = run_for_account(account_id)
    except Exception as error:
        delay = mark_market_value_recheck_failure(
            engine, config, account_id, prior_attempts, error
        )
        log.error(
            "Market value recheck failed account_id=%s retry_in_seconds=%d error=%s",
            account_id,
            delay,
            error,
            exc_info=True,
        )
        return

    mark_success(engine, config, account_id, assessment)
    if assessment.market_value_present:
        log.info("Market value recheck resolved account_id=%s", account_id)
    else:
        log.info(
            "Market value still omitted account_id=%s next_check_days=%d",
            account_id,
            config.market_value_recheck_days,
        )


def process_owner_recovery_safely(
    engine: Engine,
    config: WorkerConfig,
    account_id: str,
    prior_attempts: int,
) -> None:
    if _stop_requested:
        release_owner_recovery_claim(engine, config, account_id)
        return

    try:
        assessment = run_for_account(account_id)
        if not owner_name_is_complete(engine, config, account_id):
            raise RuntimeError(
                "Corrected scrape did not produce a complete current owner name"
            )
    except Exception as error:
        delay = mark_owner_recovery_failure(
            engine, config, account_id, prior_attempts, error
        )
        log.error(
            "Owner recovery failed account_id=%s retry_in_seconds=%d error=%s",
            account_id,
            delay,
            error,
            exc_info=True,
        )
        return

    record_market_value_assessment(engine, config, account_id, assessment)
    mark_owner_recovery_success(engine, config, account_id)
    log.info("Owner recovery succeeded account_id=%s", account_id)


def process_field_repair_safely(
    engine: Engine,
    config: WorkerConfig,
    account_id: str,
    prior_attempts: int,
) -> None:
    if _stop_requested:
        release_field_repair_claim(engine, config, account_id)
        return

    try:
        assessment = run_for_account(account_id)
    except Exception as error:
        delay = mark_field_repair_failure(
            engine, config, account_id, prior_attempts, error
        )
        log.error(
            "Field repair failed account_id=%s retry_in_seconds=%d error=%s",
            account_id,
            delay,
            error,
            exc_info=True,
        )
        return

    record_market_value_assessment(engine, config, account_id, assessment)
    mark_field_repair_success(engine, config, account_id)
    log.info("Field repair succeeded account_id=%s", account_id)


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
    processed_since_recovery = 0 if once else config.recovery_every_accounts
    processed_since_market_value = 0
    processed_since_owner_recovery = (
        0 if once else config.owner_recovery_every_accounts
    )
    processed_since_field_repair = (
        0 if once else config.field_repair_every_accounts
    )
    while not _stop_requested:
        if (
            not once
            and processed_since_field_repair >= config.field_repair_every_accounts
        ):
            field_claim = claim_next_field_repair(engine, config, worker_id)
            if field_claim is not None:
                process_field_repair_safely(engine, config, *field_claim)
                processed_since_field_repair = 0
                _sleep(config.delay_seconds)
                continue

        if (
            not once
            and processed_since_owner_recovery
            >= config.owner_recovery_every_accounts
        ):
            owner_claim = claim_next_owner_recovery(engine, config, worker_id)
            if owner_claim is not None:
                process_owner_recovery_safely(engine, config, *owner_claim)
                processed_since_owner_recovery = 0
                _sleep(config.delay_seconds)
                continue

        if not once and processed_since_recovery >= config.recovery_every_accounts:
            recovery_claim = claim_next_reconciliation(engine, config, worker_id)
            if recovery_claim is not None:
                process_reconciliation_claim_safely(engine, config, recovery_claim)
                processed_since_recovery = 0
                _sleep(config.delay_seconds)
                continue

        if (
            not once
            and processed_since_market_value
            >= config.market_value_recheck_every_accounts
        ):
            market_value_claim = claim_next_market_value_recheck(
                engine, config, worker_id
            )
            if market_value_claim is not None:
                process_market_value_recheck_safely(
                    engine, config, *market_value_claim
                )
                processed_since_market_value = 0
                _sleep(config.delay_seconds)
                continue

        claim = claim_next_account(engine, config, worker_id)
        if claim is None:
            field_claim = claim_next_field_repair(engine, config, worker_id)
            if field_claim is not None:
                process_field_repair_safely(engine, config, *field_claim)
                if once:
                    return 0
                _sleep(config.delay_seconds)
                continue
            owner_claim = claim_next_owner_recovery(engine, config, worker_id)
            if owner_claim is not None:
                process_owner_recovery_safely(engine, config, *owner_claim)
                if once:
                    return 0
                _sleep(config.delay_seconds)
                continue
            recovery_claim = claim_next_reconciliation(engine, config, worker_id)
            if recovery_claim is not None:
                process_reconciliation_claim_safely(engine, config, recovery_claim)
                if once:
                    return 0
                _sleep(config.delay_seconds)
                continue
            market_value_claim = claim_next_market_value_recheck(
                engine, config, worker_id
            )
            if market_value_claim is not None:
                process_market_value_recheck_safely(
                    engine, config, *market_value_claim
                )
                if once:
                    return 0
                _sleep(config.delay_seconds)
                continue
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
                "cycle=%s cycle_remaining=%s retry_targets=%s sleeping=%.1f",
                progress.get("phase"),
                progress.get("initial_remaining"),
                progress.get("cycle_number"),
                progress.get("cycle_remaining"),
                progress.get("retry_targets"),
                config.idle_seconds,
            )
            _sleep(config.idle_seconds)
            continue

        account_id, prior_attempts = claim
        if _stop_requested:
            release_claim(engine, config, account_id)
            break

        started = time.monotonic()
        try:
            assessment = run_for_account(account_id)
        except Exception as error:
            failures += 1
            delay = mark_failure(engine, config, account_id, prior_attempts, error)
            if (
                isinstance(error, IncompleteScrapeError)
                and prior_attempts + 1 >= config.recovery_attempt_threshold
            ):
                queued = enqueue_address_recovery(
                    engine,
                    config,
                    account_id,
                    reason=str(error),
                )
                log.warning(
                    "Incomplete account recovery %s account_id=%s attempt=%d",
                    "queued" if queued else "requires_manual_review",
                    account_id,
                    prior_attempts + 1,
                )
            log.error(
                "Scrape failed account_id=%s attempt=%d retry_in_seconds=%d error=%s",
                account_id,
                prior_attempts + 1,
                delay,
                error,
                exc_info=True,
            )
        else:
            successes += 1
            mark_success(engine, config, account_id, assessment)
            log.info(
                "Scrape succeeded account_id=%s duration_seconds=%.2f totals_success=%d totals_failed=%d",
                account_id,
                time.monotonic() - started,
                successes,
                failures,
            )

        processed_since_recovery += 1
        processed_since_market_value += 1
        processed_since_owner_recovery += 1
        processed_since_field_repair += 1

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

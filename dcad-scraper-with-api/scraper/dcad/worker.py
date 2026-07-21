from __future__ import annotations

import argparse
import logging
import os
import re
import signal
import socket
import time
from dataclasses import dataclass
from typing import Optional

from sqlalchemy import Engine, text

from dcad.run_once import run_for_account
from dcad.upsert import get_engine


log = logging.getLogger("dcad.worker")
_stop_requested = False


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
    excluded_counties: tuple[str, ...]
    refresh_days: int
    delay_seconds: float
    idle_seconds: float
    lease_minutes: int
    retry_base_seconds: int
    retry_max_seconds: int
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
            excluded_counties=excluded,
            refresh_days=max(1, int(os.getenv("SCRAPE_REFRESH_DAYS", "30"))),
            delay_seconds=max(0.0, float(os.getenv("SCRAPE_DELAY_SECONDS", "2"))),
            idle_seconds=max(1.0, float(os.getenv("SCRAPE_IDLE_SECONDS", "60"))),
            lease_minutes=max(1, int(os.getenv("SCRAPE_LEASE_MINUTES", "15"))),
            retry_base_seconds=max(30, int(os.getenv("SCRAPE_RETRY_BASE_SECONDS", "300"))),
            retry_max_seconds=max(300, int(os.getenv("SCRAPE_RETRY_MAX_SECONDS", "604800"))),
            auto_migrate=_env_bool("SCRAPE_AUTO_MIGRATE", True),
            account_id_regex=os.getenv("SCRAPE_ACCOUNT_ID_REGEX", r"^[[:alnum:]]{17}$"),
        )


def _state_table(config: WorkerConfig) -> str:
    return f'"{config.state_schema}"."dcad_scrape_state"'


def _accounts_table(config: WorkerConfig) -> str:
    return f'"{config.data_schema}"."accounts"'


def _raw_table(config: WorkerConfig) -> str:
    return f'"{config.data_schema}"."dcad_json_raw"'


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
    accounts = _accounts_table(config)
    sql = text(
        f"""
        SELECT count(*)
        FROM {accounts} a
        WHERE a.account_id ~ :account_id_regex
          AND NOT (
              UPPER(COALESCE(a.county, '')) = ANY(CAST(:excluded_counties AS text[]))
          )
        """
    )
    with engine.connect() as conn:
        return int(
            conn.execute(
                sql,
                {
                    "account_id_regex": config.account_id_regex,
                    "excluded_counties": list(config.excluded_counties),
                },
            ).scalar_one()
        )


def claim_next_account(
    engine: Engine,
    config: WorkerConfig,
    worker_id: str,
) -> Optional[tuple[str, int]]:
    accounts = _accounts_table(config)
    raw = _raw_table(config)
    state = _state_table(config)
    sql = text(
        f"""
        WITH candidate AS (
            SELECT a.account_id,
                   COALESCE(s.last_success_at, r.fetched_at) AS effective_last_success
            FROM {accounts} a
            LEFT JOIN {state} s ON s.account_id = a.account_id
            LEFT JOIN {raw} r ON r.account_id = a.account_id
            WHERE a.account_id ~ :account_id_regex
              AND NOT (
                  UPPER(COALESCE(a.county, '')) = ANY(CAST(:excluded_counties AS text[]))
              )
              AND COALESCE(s.status, 'pending') <> 'disabled'
              AND (s.lease_expires_at IS NULL OR s.lease_expires_at <= now())
              AND COALESCE(s.next_attempt_at, now()) <= now()
              AND (
                  COALESCE(s.last_success_at, r.fetched_at) IS NULL
                  OR COALESCE(s.last_success_at, r.fetched_at)
                     <= now() - make_interval(days => :refresh_days)
              )
            ORDER BY
              CASE WHEN COALESCE(s.last_success_at, r.fetched_at) IS NULL THEN 0 ELSE 1 END,
              COALESCE(s.next_attempt_at, '-infinity'::timestamptz),
              COALESCE(s.last_success_at, r.fetched_at),
              a.account_id
            FOR UPDATE OF a SKIP LOCKED
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
               c.effective_last_success,
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
                "account_id_regex": config.account_id_regex,
                "excluded_counties": list(config.excluded_counties),
                "refresh_days": config.refresh_days,
                "lease_minutes": config.lease_minutes,
                "worker_id": worker_id,
            },
        ).mappings().first()
    if row is None:
        return None
    return str(row["account_id"]), int(row["attempts"])


def mark_success(engine: Engine, config: WorkerConfig, account_id: str) -> None:
    state = _state_table(config)
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
    worker_id = f"{socket.gethostname()}:{os.getpid()}"
    log.info(
        "Worker ready id=%s targets=%d existing_successes_bootstrapped=%d "
        "refresh_days=%d excluded_counties=%s",
        worker_id,
        total_targets,
        bootstrapped,
        config.refresh_days,
        ",".join(config.excluded_counties) or "(none)",
    )

    successes = 0
    failures = 0
    while not _stop_requested:
        claim = claim_next_account(engine, config, worker_id)
        if claim is None:
            if once:
                return 0
            log.info("No account is currently due; sleeping %.1f seconds", config.idle_seconds)
            _sleep(config.idle_seconds)
            continue

        account_id, prior_attempts = claim
        if _stop_requested:
            release_claim(engine, config, account_id)
            break

        started = time.monotonic()
        try:
            run_for_account(account_id)
        except Exception as error:
            failures += 1
            delay = mark_failure(engine, config, account_id, prior_attempts, error)
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
            mark_success(engine, config, account_id)
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
        return 0
    return run_worker(config, once=args.once)


if __name__ == "__main__":
    raise SystemExit(main())

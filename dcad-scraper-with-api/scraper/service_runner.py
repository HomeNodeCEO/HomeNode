from __future__ import annotations

import logging
import os
import signal
import subprocess
import sys
import time
from collections.abc import Sequence
from pathlib import Path


log = logging.getLogger("dcad.service_runner")
_stop_requested = False


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _request_stop(signum: int, _frame) -> None:
    global _stop_requested
    _stop_requested = True
    log.info("Received signal %s; stopping child processes", signum)


def _start_process(
    name: str, command: Sequence[str], *, env: dict[str, str] | None = None
) -> subprocess.Popen:
    log.info("Starting %s: %s", name, " ".join(command))
    return subprocess.Popen(list(command), env=env)


def _stop_process(name: str, process: subprocess.Popen, timeout_seconds: int = 30) -> None:
    if process.poll() is not None:
        return

    log.info("Stopping %s pid=%s", name, process.pid)
    process.terminate()
    try:
        process.wait(timeout=timeout_seconds)
    except subprocess.TimeoutExpired:
        log.warning("%s did not stop in %s seconds; killing it", name, timeout_seconds)
        process.kill()
        process.wait(timeout=10)


def run() -> int:
    port = os.getenv("PORT", "8080")
    run_worker = _env_bool("RUN_DCAD_WORKER", True)
    children: list[tuple[str, subprocess.Popen]] = []

    # Render can inject a service-level PYTHONPATH that overrides the image's
    # ENV value. Build the child path here so the dcad package is always
    # importable regardless of any inherited platform setting.
    child_env = os.environ.copy()
    scraper_dir = str(Path(__file__).resolve().parent)
    inherited_pythonpath = child_env.get("PYTHONPATH", "")
    child_env["PYTHONPATH"] = os.pathsep.join(
        part for part in (scraper_dir, inherited_pythonpath) if part
    )

    api_command = (
        sys.executable,
        "-m",
        "uvicorn",
        "scraper.api.main:app",
        "--host",
        "0.0.0.0",
        "--port",
        port,
    )
    children.append(("api", _start_process("api", api_command, env=child_env)))

    if run_worker:
        worker_command = (sys.executable, "-m", "dcad.worker")
        children.append(("worker", _start_process("worker", worker_command, env=child_env)))
    else:
        log.warning("RUN_DCAD_WORKER is disabled; only the API will run")

    unexpected_exit = False
    try:
        while not _stop_requested:
            for name, process in children:
                return_code = process.poll()
                if return_code is None:
                    continue
                log.error("%s exited unexpectedly with code %s", name, return_code)
                unexpected_exit = True
                return 1
            time.sleep(1)
    finally:
        for name, process in reversed(children):
            _stop_process(name, process)

    return 1 if unexpected_exit else 0


def main() -> int:
    logging.basicConfig(
        level=os.getenv("LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    signal.signal(signal.SIGTERM, _request_stop)
    signal.signal(signal.SIGINT, _request_stop)
    return run()


if __name__ == "__main__":
    raise SystemExit(main())

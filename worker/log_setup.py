#!/usr/bin/env python3
"""
Shared structured logging for the worker.

Same shape as virtual-agent-lookup: a per-day file handler under logs/ plus a
stdout stream handler, so a run is both tailable live and archived on disk.
"""
import sys
import logging
import datetime as dt
from pathlib import Path

ROOT = Path(__file__).resolve().parent
LOG_DIR = ROOT / "logs"


def get_logger(name: str = "worker") -> logging.Logger:
    log = logging.getLogger(name)
    if log.handlers:                        # already configured (idempotent)
        return log
    log.setLevel(logging.INFO)
    LOG_DIR.mkdir(exist_ok=True)
    fmt = logging.Formatter(
        "%(asctime)s %(levelname)s [%(name)s] %(message)s", "%Y-%m-%d %H:%M:%S")
    fh = logging.FileHandler(LOG_DIR / f"worker_{dt.date.today()}.log")
    fh.setFormatter(fmt)
    sh = logging.StreamHandler(sys.stdout)
    sh.setFormatter(fmt)
    log.addHandler(fh)
    log.addHandler(sh)
    return log

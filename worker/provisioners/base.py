#!/usr/bin/env python3
"""
Base types shared by every browser provisioner.

Each provisioner exposes create(person) and deactivate(person) and returns a
result dict. EVERY provisioner MUST honor config.DRY_RUN: in dry-run it logs what
it WOULD do and returns a clearly-labelled simulated result, and NEVER submits a
real create/deactivate on the live portal.
"""
from __future__ import annotations

import json
from dataclasses import dataclass

import config
from log_setup import get_logger

log = get_logger("provisioner")


class Skip(Exception):
    """A row the worker cannot complete and must NOT retry as an error - it needs
    human/portal work (e.g. CMA's OTP/2FA gate). The poll loop catches this and
    writes the terminal `skipped` status with the reason (CONTRACTS.md section 3).
    """
    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


@dataclass
class Person:
    """The subject of a provisioning action, decoded from a queue row."""
    full_name: str = ""
    first_name: str = ""
    id_number: str = ""
    quay_email: str = ""
    cell: str = ""
    payload: dict = None            # system-specific extras from payload_json

    @classmethod
    def from_queue_row(cls, qr) -> "Person":
        raw = qr.get("payload_json")
        try:
            payload = json.loads(raw) if raw else {}
        except (ValueError, TypeError):
            payload = {}
        return cls(
            full_name=qr.get("full_name"),
            first_name=qr.get("first_name"),
            id_number=qr.get("id_number"),
            quay_email=qr.get("quay_email"),
            cell=qr.get("cell"),
            payload=payload,
        )


def result(ok: bool, action: str, system: str, **extra) -> dict:
    """Uniform result shape written back to the queue's result_json column.

    `dry_run` is always stamped so downstream audit can tell a simulated result
    from a real one at a glance.
    """
    out = {
        "ok": ok,
        "system": system,
        "action": action,
        "dry_run": config.DRY_RUN,
    }
    out.update(extra)
    return out


def dry_run_result(system: str, action: str, person: Person, would: str,
                   **extra) -> dict:
    """Build + log the standard simulated result for a dry-run. Clearly labelled
    so it can never be mistaken for a real provisioning outcome. The `would` field
    is the machine-readable description CONTRACTS.md section 3 mandates."""
    log.info("[DRY_RUN] %s.%s WOULD: %s (person=%s email=%s)",
             system, action, would, person.full_name or "?", person.quay_email or "-")
    return result(True, action, system,
                  simulated=True,
                  would=would,
                  **extra)


class Provisioner:
    """Base class. Subclasses implement _create_live / _deactivate_live for the
    real portal flow; the public create/deactivate wrap them with the dry-run
    gate so no subclass can accidentally submit while DRY_RUN is on."""

    system: str = "base"

    def create(self, person: Person) -> dict:
        if config.DRY_RUN:
            return self._create_dry(person)
        return self._create_live(person)

    def deactivate(self, person: Person) -> dict:
        if config.DRY_RUN:
            return self._deactivate_dry(person)
        return self._deactivate_live(person)

    # ---- dry-run defaults (subclasses may override to add specifics) --------
    def _create_dry(self, person: Person) -> dict:
        return dry_run_result(self.system, "create", person,
                              would=f"create a {self.system} account/seat")

    def _deactivate_dry(self, person: Person) -> dict:
        return dry_run_result(self.system, "deactivate", person,
                              would=f"deactivate the {self.system} account/seat")

    # ---- live flows (subclasses MUST implement) -----------------------------
    def _create_live(self, person: Person) -> dict:
        raise NotImplementedError

    def _deactivate_live(self, person: Person) -> dict:
        raise NotImplementedError

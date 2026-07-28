#!/usr/bin/env python3
"""
CMA provisioner (cmainfo.co.za; browser-driven, no user-management API).

============================ NEEDS-PORTAL-MAP ============================
The LOGIN + landing navigation is ported from cma-lookup/src/_explore.py (that
project mapped cmainfo.co.za sign-in). What is NOT solved anywhere yet:
  - The OTP / 2FA step after password submit (cma-lookup is PARKED on exactly
    this). It is a BLOCKING TODO below. We do NOT fake success through it.
  - The user-management screens (add user / disable user) DOM is unmapped:
    every `# TODO(portal-map)` selector is a placeholder.
Until both are solved this runs in dry-run and NEVER submits.
=========================================================================
"""
from __future__ import annotations

import config
from log_setup import get_logger
from .base import Person, Provisioner, Skip
from .browser import portal_page

log = get_logger("cma")

URL = "https://www.cmainfo.co.za/"
PROFILE_NAME = "cma"


class OtpRequired(Exception):
    """Raised when cmainfo.co.za demands an OTP/2FA code we cannot supply
    headlessly. The row is left for a human-in-the-loop path - never faked."""


_SKIP_REASON = ("CMA OTP/2FA gate is unsolved - cannot complete headlessly "
                "(see cma-lookup, parked). TODO: solve OTP, then map user-admin DOM.")


class CmaProvisioner(Provisioner):
    system = "cma"

    # CMA is OTP/2FA-gated and cannot be completed headlessly today (CONTRACTS.md
    # section 1: worker returns `skipped` with a TODO note). We raise Skip for BOTH
    # dry-run and live so the row is honestly marked `skipped`, never a fake `done`
    # and never a retriable `error`. The _login/_create_live scaffolding below is
    # the mapped reference flow to build on once OTP is solved.
    def create(self, person: Person) -> dict:
        log.info("cma.create -> SKIP (email=%r): %s", person.quay_email, _SKIP_REASON)
        raise Skip(_SKIP_REASON)

    def deactivate(self, person: Person) -> dict:
        log.info("cma.deactivate -> SKIP (email=%r): %s", person.quay_email, _SKIP_REASON)
        raise Skip(_SKIP_REASON)

    # ---- login (ported from cma-lookup, real flow) --------------------------
    def _login(self, page) -> None:
        """Open cmainfo.co.za, open the login modal, submit credentials.
        Ends by raising OtpRequired at the 2FA gate (the unsolved step)."""
        acct = config.PORTAL_ACCOUNTS["cma"]
        pw = config.get_password(acct["keychain_service"], acct["user"])

        page.goto(URL, wait_until="domcontentloaded", timeout=45000)
        page.wait_for_timeout(2000)

        # open the login modal (selectors verified in cma-lookup exploration)
        for sel in ("a:has-text('CLICK HERE TO LOGIN')",
                    "button:has-text('CLICK HERE TO LOGIN')",
                    "a:has-text('LOGIN')", "a[href*=login i]", "[onclick*=login i]"):
            loc = page.locator(sel).first
            if loc.count():
                loc.click(timeout=4000)
                page.wait_for_timeout(1500)
                break

        for sel in ("input[type=email]:visible", "#username:visible",
                    "#email:visible", "input[name*=user i]:visible",
                    "input[type=email]", "#username", "#email"):
            loc = page.locator(sel).first
            if loc.count():
                loc.fill(acct["user"], timeout=5000)
                break
        for sel in ("input[type=password]:visible", "#password:visible",
                    "input[type=password]", "#password", "#Password", "#pwd"):
            loc = page.locator(sel).first
            if loc.count():
                loc.fill(pw, timeout=5000)
                break
        for sel in ("button[type=submit]", "input[type=submit]",
                    "button:has-text('Login')", "button:has-text('Sign in')",
                    "a:has-text('Login')"):
            if page.locator(sel).count():
                page.locator(sel).first.click(timeout=4000)
                break
        page.wait_for_timeout(4000)

        # BLOCKING TODO(otp): cmainfo.co.za presents an OTP / 2FA challenge here.
        # cma-lookup is PARKED on this exact step. We must NOT guess our way past
        # it or report success. A future human-in-the-loop path (prompt for the
        # code, or an email/SMS reader) plugs in here. Until then: stop cleanly.
        raise OtpRequired(
            "CMA login reached the OTP/2FA gate - unsolved (see cma-lookup, parked)")

    # ---- live flows (guarded) ----------------------------------------------
    def _create_live(self, person: Person) -> dict:
        with portal_page(PROFILE_NAME) as page:
            self._login(page)   # raises OtpRequired today
            # TODO(portal-map): after OTP, navigate to user admin > add user,
            # fill name/email, submit, read back the new user id.
            raise NotImplementedError(
                "CMA live create not armed: OTP unsolved + TODO(portal-map) selectors")

    def _deactivate_live(self, person: Person) -> dict:
        with portal_page(PROFILE_NAME) as page:
            self._login(page)   # raises OtpRequired today
            # TODO(portal-map): after OTP, find user by email, disable.
            raise NotImplementedError(
                "CMA live deactivate not armed: OTP unsolved + TODO(portal-map) selectors")


_provisioner = CmaProvisioner()


def create(person: Person) -> dict:
    return _provisioner.create(person)


def deactivate(person: Person) -> dict:
    return _provisioner.deactivate(person)

#!/usr/bin/env python3
"""
Dialfire provisioner (browser-driven for user/seat management).

============================ NEEDS-PORTAL-MAP ============================
Dialfire has an API for campaign/contact data, but the user-management path
(add/remove an agent seat) is not confirmed for API use, so we drive the admin
UI. The live DOM is unmapped: every `# TODO(portal-map)` selector is a guess.
Before arming live (DRY_RUN=0) a human must walk the add-seat and remove-seat
flows and replace the selectors + confirm the success signal.
Until then this runs in dry-run and NEVER submits.
=========================================================================
"""
from __future__ import annotations

import config
from log_setup import get_logger
from .base import Person, Provisioner, result
from .browser import portal_page

log = get_logger("dialfire")

LOGIN_URL = "https://www.dialfire.com/en/login.html"    # TODO(portal-map): confirm admin/login host
PROFILE_NAME = "dialfire"


class DialfireProvisioner(Provisioner):
    system = "dialfire"

    # ---- dry-run overrides --------------------------------------------------
    def _create_dry(self, person: Person) -> dict:
        log.info("[DRY_RUN] dialfire.create WOULD: log in as %s, open Users/Seats, "
                 "invite agent email=%r name=%r, submit",
                 config.PORTAL_ACCOUNTS["dialfire"]["user"] or "<unset>",
                 person.quay_email, person.full_name)
        return result(True, "create", self.system, simulated=True,
                      would="add Dialfire agent seat",
                      would_email=person.quay_email)

    def _deactivate_dry(self, person: Person) -> dict:
        log.info("[DRY_RUN] dialfire.deactivate WOULD: log in, find seat "
                 "email=%r, remove it", person.quay_email)
        return result(True, "deactivate", self.system, simulated=True,
                      would="remove Dialfire agent seat",
                      would_email=person.quay_email)

    # ---- live flows (guarded) ----------------------------------------------
    def _login(self, page) -> None:
        acct = config.PORTAL_ACCOUNTS["dialfire"]
        pw = config.get_password(acct["keychain_service"], acct["user"])
        page.goto(LOGIN_URL, wait_until="domcontentloaded", timeout=45000)
        page.fill("input[name='email']", acct["user"])      # TODO(portal-map)
        page.fill("input[name='password']", pw)             # TODO(portal-map)
        page.click("button[type='submit']")                 # TODO(portal-map)
        page.wait_for_load_state("domcontentloaded", timeout=30000)

    def _create_live(self, person: Person) -> dict:
        with portal_page(PROFILE_NAME) as page:
            self._login(page)
            # TODO(portal-map): open Users/Seats > invite, fill email+name, submit,
            # read back seat id / invite confirmation.
            raise NotImplementedError(
                "Dialfire live create not armed: replace TODO(portal-map) selectors first")

    def _deactivate_live(self, person: Person) -> dict:
        with portal_page(PROFILE_NAME) as page:
            self._login(page)
            # TODO(portal-map): find seat by email, remove it, confirm.
            raise NotImplementedError(
                "Dialfire live deactivate not armed: replace TODO(portal-map) selectors first")


_provisioner = DialfireProvisioner()


def create(person: Person) -> dict:
    return _provisioner.create(person)


def deactivate(person: Person) -> dict:
    return _provisioner.deactivate(person)

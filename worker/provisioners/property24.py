#!/usr/bin/env python3
"""
Property24 provisioner (browser-driven; Property24 has no user-management API).

============================ NEEDS-PORTAL-MAP ============================
The live Property24 admin DOM is not mapped yet. Every selector below marked
`# TODO(portal-map)` is a placeholder guessed from the SPEC, not a verified
selector. Before arming live (DRY_RUN=0), a human must:
  1. Log into the Property24 agency admin as the P24_ADMIN_USER.
  2. Walk the "add agent" and "deactivate agent" flows.
  3. Replace each TODO selector with the real one and confirm the success
     signal (URL / toast / row appearing).
Until then this runs in dry-run and NEVER submits.
=========================================================================

Notes from SPEC section 4:
  - Property24 auto-links a broker when they later log in with their Quay1
    Google account, but we still create the profile explicitly here.
  - Google account is the linchpin and is created first (by Apps Script).
"""
from __future__ import annotations

import config
from log_setup import get_logger
from .base import Person, Provisioner, result
from .browser import portal_page

log = get_logger("property24")

ADMIN_URL = "https://www.property24.com/admin"          # TODO(portal-map): confirm real admin host/path
PROFILE_NAME = "property24"


class Property24Provisioner(Provisioner):
    system = "property24"

    # ---- dry-run overrides: spell out the intended live steps ---------------
    def _create_dry(self, person: Person) -> dict:
        log.info("[DRY_RUN] property24.create WOULD: log in as %s, open Add Agent, "
                 "fill name=%r email=%r cell=%r, submit, capture new agent id",
                 config.PORTAL_ACCOUNTS["property24"]["user"] or "<unset>",
                 person.full_name, person.quay_email, person.cell)
        return result(True, "create", self.system, simulated=True,
                      would="add Property24 agent",
                      would_email=person.quay_email)

    def _deactivate_dry(self, person: Person) -> dict:
        log.info("[DRY_RUN] property24.deactivate WOULD: log in, find agent by "
                 "email=%r, open their profile, set status inactive, confirm",
                 person.quay_email)
        return result(True, "deactivate", self.system, simulated=True,
                      would="deactivate Property24 agent",
                      would_email=person.quay_email)

    # ---- live flows (guarded: only reached when DRY_RUN=0) ------------------
    def _login(self, page) -> None:
        acct = config.PORTAL_ACCOUNTS["property24"]
        pw = config.get_password(acct["keychain_service"], acct["user"])
        page.goto(ADMIN_URL, wait_until="domcontentloaded", timeout=45000)
        # TODO(portal-map): the login form may be a separate SSO page. Confirm.
        page.fill("input[name='username']", acct["user"])   # TODO(portal-map)
        page.fill("input[name='password']", pw)             # TODO(portal-map)
        page.click("button[type='submit']")                 # TODO(portal-map)
        page.wait_for_load_state("domcontentloaded", timeout=30000)

    def _create_live(self, person: Person) -> dict:
        with portal_page(PROFILE_NAME) as page:
            self._login(page)
            # TODO(portal-map): navigate to Agents > Add Agent
            page.goto(ADMIN_URL + "/agents/add", wait_until="domcontentloaded")  # TODO(portal-map)
            page.fill("input[name='fullName']", person.full_name)   # TODO(portal-map)
            page.fill("input[name='email']", person.quay_email)     # TODO(portal-map)
            page.fill("input[name='cell']", person.cell)            # TODO(portal-map)
            page.click("button:has-text('Save')")                   # TODO(portal-map)
            # TODO(portal-map): read back the created agent id / success toast.
            raise NotImplementedError(
                "Property24 live create not armed: replace TODO(portal-map) selectors first")

    def _deactivate_live(self, person: Person) -> dict:
        with portal_page(PROFILE_NAME) as page:
            self._login(page)
            # TODO(portal-map): search for the agent by email, open profile, set inactive.
            raise NotImplementedError(
                "Property24 live deactivate not armed: replace TODO(portal-map) selectors first")


# module-level singletons for the dispatch table in poll.py
_provisioner = Property24Provisioner()


def create(person: Person) -> dict:
    return _provisioner.create(person)


def deactivate(person: Person) -> dict:
    return _provisioner.deactivate(person)

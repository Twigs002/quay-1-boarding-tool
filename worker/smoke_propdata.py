#!/usr/bin/env python3
"""
Standalone PropData (PDMS) smoke test.

Creates ONE clearly-named throwaway agent profile on the LIVE portal so the mapped
"Add User" selectors can be verified end to end before PropData is wired into the
queue-driven worker. Mirrors the Google smokeTestGoogleLive safety pattern:

  * REFUSES to run the live create unless you pass --yes-create-real-user;
  * runs HEADED by default so you watch every step (pass --headless to hide);
  * names the user "ZZ Smoke <timestamp>" so it is obvious and trivial to delete;
  * does NOT touch the sheet bus or the global DRY_RUN switch - it calls the live
    create path directly for this single record only.

Usage (from the worker/ directory):
    ./.venv/bin/python smoke_propdata.py --dry                     # no browser, just print the plan
    ./.venv/bin/python smoke_propdata.py --yes-create-real-user    # headed, candidate ("-") profile
    ./.venv/bin/python smoke_propdata.py --yes-create-real-user --full   # full-status designation

After a live run, delete the ZZ Smoke user in PDMS (Users list -> search "ZZ Smoke").
"""
from __future__ import annotations

import argparse
import sys
from datetime import datetime

import config
from provisioners import propdata
from provisioners.base import Person


def _build_person(full: bool) -> Person:
    stamp = datetime.now().strftime("%m%d-%H%M%S")
    first = "ZZ"
    last = "Smoke " + stamp
    payload = {
        "last_name": last,
        "email": "zzsmoke.%s@quay1.co.za" % stamp.replace("-", ""),
        "ffc_status": "full" if full else "",
        # photo_path omitted -> falls back to the repo Quay 1 logo asset
    }
    return Person(
        full_name="%s %s" % (first, last),
        first_name=first,
        quay_email=payload["email"],
        cell="082 000 0000",
        payload=payload,
    )


def main() -> int:
    ap = argparse.ArgumentParser(description="PropData PDMS smoke test")
    ap.add_argument("--yes-create-real-user", action="store_true",
                    help="actually create a throwaway user on the LIVE portal")
    ap.add_argument("--full", action="store_true",
                    help="full-status profile (Designation = Non-Principal Property Practitioner)")
    ap.add_argument("--dry", action="store_true",
                    help="print the intended field values only; opens no browser")
    ap.add_argument("--headless", action="store_true",
                    help="run without a visible window (default is headed so you can watch)")
    args = ap.parse_args()

    person = _build_person(args.full)
    prov = propdata._provisioner

    if args.dry or not args.yes_create_real_user:
        if not args.dry:
            print("Refusing to create a real PDMS user without --yes-create-real-user.\n"
                  "Showing the dry-run plan instead:\n")
        res = prov._create_dry(person)
        print("\nDRY plan result:", res)
        return 0

    # --- live create (explicit opt-in) --------------------------------------
    if not config.PORTAL_ACCOUNTS["propdata"]["user"]:
        print("ERROR: PROPDATA_ADMIN_USER is not set (worker/.env). Cannot log in.", file=sys.stderr)
        return 2

    config.HEADLESS = args.headless  # headed by default so the run is watchable
    print("Creating LIVE throwaway PDMS user: %s (%s), designation=%s, headless=%s"
          % (person.full_name, person.quay_email,
             "Non-Principal Property Practitioner" if args.full else "-", config.HEADLESS))
    print("Watch the window. Delete the 'ZZ Smoke ...' user in PDMS afterwards.\n")

    res = prov._create_live(person)
    print("\nLIVE create result:", res)
    return 0 if res.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())

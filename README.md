# Quay 1 Boarding Tool

One repo for staff **onboarding**, account **provisioning**, and **offboarding** across two
entities: **Quay 1** (broker onboarding) and **Aqua Promotions** (contractor onboarding).

It replaces and consolidates the old `quay-hubspot` frontend + Apps Script `1apqpQ...` and
the `quay-dashboard-v2` Staff>Contracts flow + Apps Script `16tzth...` into a single codebase.

## What is where

- `apps-script/` - the core web app: HTTP router, Supabase-JWT auth, both contract flows,
  FICA intake, induction booking + digest, Google + PropData provisioning (inline), the queue
  writer, and offboarding with a 30-minute one-shot trigger.
- `worker/` - a Python + Playwright poller that runs on the Mac (like `virtual-agent-lookup`).
  It executes the browser-only portals (Property24, CMA, Dialfire) off the Provisioning Queue.
- `web/` - one static page (GitHub Pages) with three sections: Onboard, Provisioning status,
  Offboard.
- `docs/` - `SPEC.md` (behaviour, single source of truth), `CONTRACTS.md` (the frozen queue
  schemas + CAS protocol + offboarding state machine), `ARCHITECTURE.md` (module boundaries).

Read `docs/SPEC.md` and `docs/CONTRACTS.md` before changing anything.

## Safety defaults (this repo ships inert)

This repo builds and dry-runs only. Nothing here mutates a live account until a human arms it.

- `DRY_RUN=1` (Script Property + worker env) - provisioners log the action they WOULD take.
- `OFFBOARD_ARMED=0` - `fireOffboarding_()` runs the flow but does NOT suspend real Google
  accounts until explicitly armed.
- `HUBSPOT_SEAT_ENABLED=0` - paid HubSpot seat create/release stays off by default.
- `PROPDATA_LIVE=0` - PropData runs dry until `api_key` + vendor id are provisioned.

Offboarding suspends real accounts and has **no cancel window** once armed and fired. Treat
arming as a production change.

## Deploy / arm (all steps are user-run - no automated deploy from this repo)

### 1. Apps Script (the core)
```bash
# from apps-script/
clasp login                       # pagan@ Google account (may be stale - re-login if push 401s)
clasp push                        # upload source to the consolidated script project
clasp deploy --description "..."   # create a new web-app version
```
Then in the Apps Script project → Project Settings → Script Properties, set (never commit):
`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY`, `TRACKER_SHEET_ID`,
`HUBSPOT_TOKEN`, `PROPDATA_API_KEY`, `PROPDATA_VENDOR_ID`, and the flags
`DRY_RUN`, `OFFBOARD_ARMED`, `HUBSPOT_SEAT_ENABLED`, `PROPDATA_LIVE`.

### 2. Worker (the Mac poller)
```bash
# from worker/
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
playwright install chromium
cp .env.example .env              # then fill SHEET_ID, SA_CREDS_PATH, DRY_RUN=1, portal logins
python poll.py                    # DRY_RUN default ON - logs intended actions only
```
Runs headless on the Mac like `virtual-agent-lookup`; schedule via launchd/cron when armed.

### 3. Frontend (GitHub Pages)
```bash
# from web/
cp config.example.js config.js    # fill LIFECYCLE_ENDPOINT, SUPABASE_URL, SUPABASE_ANON_KEY
# commit everything EXCEPT config.js (gitignored); enable Pages on the repo
```

## Arming order (when the user says go)
1. Confirm the worker runs clean in `DRY_RUN=1` end to end.
2. Provision PropData creds → set `PROPDATA_LIVE=1`.
3. Flip worker `DRY_RUN=0` for the browser portals once each provisioner is verified live.
4. Only last, and only on explicit instruction, set `OFFBOARD_ARMED=1`.

## Conventions
- Files under 500 lines; split modules before they grow.
- No secrets in committed source - Script Properties / `.env` / keychain only.
- No em/en dashes. No dark mode. Dark text on the yellow brand colour.
- Emails draft-only, except the scoped onboarding/induction pipeline (contract/induction/digest
  may auto-send). Offboarding notifications draft unless told otherwise.

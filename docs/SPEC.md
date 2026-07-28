# Quay 1 Boarding Tool - Master Spec (single source of truth)

> Every build agent reads this file first and builds to these contracts. Do NOT invent
> field names, sheet columns, or endpoint shapes that aren't here - if something is
> missing, add it to this file (don't diverge silently).

## 0. What this repo is

A single repo that unifies **staff onboarding**, **account provisioning**, and
**offboarding** for two entities:

- **Quay 1** broker onboarding (was: `quay-hubspot` frontend + Apps Script `1apqpQ…`)
- **Aqua Promotions** contractor onboarding (was: `quay-dashboard-v2` Staff>Contracts + Apps Script `16tzth…`)

Decision (user, 2026-07-28): **FULL CONSOLIDATION** - both contract pipelines are rebuilt
inside this repo as one codebase. Stack: **Apps Script + static frontend** core, plus a
**Python + Playwright worker** for browser-only portals. Offboarding fires **automatically
after a 30-minute delay, no cancel window**.

## 1. Architecture

```
web/  (static frontend, GitHub Pages)
  └── one UI: Onboard request · Provisioning status · Offboard request
        │  POST (text/plain, no-preflight)  + Supabase JWT auth
        ▼
apps-script/  (ONE consolidated Apps Script web app - the core)
  ├── Router (doGet/doPost)                → dispatch by {kind}
  ├── Onboarding
  │     ├── Quay 1 contract gen  (2026 v2.1G Sale/Rental templates)
  │     └── Aqua MOA gen         (monthly/fixed/permanent selector)
  ├── FICA intake  (self-service form + upload → tracker ticks)
  ├── Induction booking + progress report + Tue digest   (Quay 1 only)
  ├── Provisioning
  │     ├── Google Workspace  (AdminDirectory advanced service - TO BUILD; no prior impl exists)
  │     ├── PropData REST API  (feeds-api.propdata.net - needs api_key+vendor id)
  │     └── QUEUE writer  → drops rows on "Provisioning Queue" tab for the worker
  └── Offboarding
        ├── request handler  → writes "Offboarding Queue" row, schedules +30min trigger
        └── fireOffboarding_()  → Google suspend + groups + HubSpot seat + Drive revoke,
                                   and drops browser-portal teardown rows on the queue
        │  reads/writes queue tabs (Google Sheet)
        ▼
worker/  (Python + Playwright, runs on the Mac like virtual-agent-lookup)
  ├── poll.py            → reads Provisioning/Offboarding Queue tabs (Sheets API)
  └── provisioners/
        ├── property24.py → create/deactivate agent (no API; browser)
        ├── cma.py        → create/deactivate (cmainfo.co.za; OTP-gated - see cma-lookup)
        └── dialfire.py   → create/deactivate agent seat (browser)
```

**Why the split:** Apps Script cannot drive a browser. Google + PropData are API-based →
they live in Apps Script. Property24 / CMA / Dialfire have no usable API → Apps Script
enqueues a job, the Python worker executes it and writes status back. One Google Sheet is
the shared bus between the two halves.

## 2. Auth (unchanged from existing apps)

- Writes are **Supabase JWT only** (the browser holds the logged-in user's JWT).
  Backend verifies against Supabase `/auth/v1/user` then reads the `staff` row for role.
- Roles: `is_super`, `is_admin`, `is_broker`. Onboarding actions allow
  `is_super || is_admin || is_broker` (a broker submits only for their own hire;
  `requester_email` is force-set from the JWT server-side, matching quay-hubspot).
  Offboarding and provisioning require `is_super || is_admin`; retry requires `is_super`.
  Brokers see only their own requested candidates (requester_email) and have no Offboard tab.
- POSTs use `Content-Type: text/plain` to dodge CORS preflight (existing pattern).
- Supabase project: `dqszbqiimbfvmmnpgpsb` ("quay-clock", PRODUCTION). `staff` table has a
  `staff_admin_write_guard_tg` trigger - never auto-toggle is_super/is_admin.

## 3. Data model - Google Sheet tabs (the shared bus)

One tracker Sheet holds all tabs. (Consolidation may keep the two existing trackers or
create one new - architect decides; default: NEW single tracker, migrate later.)

### 3.1 `Onboarding` tab (merged Quay1 + Aqua)
Keyed on folderId (hidden). Columns (superset of both existing trackers):
`entity`(quay1|aqua), name, id_number, email, contact, start_date, senior_name,
senior_email, requester_name, requester_email, designation, team, division,
agreement_type(monthly|fixed|permanent - aqua), work_hours, remuneration(aqua),
commission(quay1), programs(JSON), FICA ticks (R - V per-doc), induction_wed, induction_thu,
status, folderId(hidden key).

### 3.2 `Provisioning Queue` tab  (Apps Script → worker)
One row per (person × system). The worker polls this.
| col | field | notes |
|-----|-------|-------|
| A | queue_id | unique, apps-script generated |
| B | folderId | links back to Onboarding row |
| C | full_name | |
| D | first_name | |
| E | id_number | |
| F | quay_email | provisioned Google address |
| G | cell | |
| H | system | `google`\|`propdata`\|`property24`\|`cma`\|`dialfire` |
| I | action | `create`\|`deactivate` |
| J | payload_json | system-specific extra fields |
| K | status | `pending`\|`in_progress`\|`done`\|`error`\|`skipped` |
| L | result_json | worker writes: account id/username, or error text |
| M | attempts | int, worker increments |
| N | updated_at | ISO |

- Apps Script writes rows with status=`pending` for google/propdata (it does those itself
  and flips them done inline) OR for the browser systems (worker does them).
  **Decision:** google + propdata are executed INLINE by Apps Script and written as
  `done`/`error` for audit; property24/cma/dialfire are written `pending` for the worker.
- Worker claims a row by CAS: only act if status still `pending`, set `in_progress` first.

### 3.3 `Offboarding Queue` tab  (Apps Script → worker + self)
| col | field | notes |
|-----|-------|-------|
| A | offb_id | unique |
| B | full_name | |
| C | quay_email | |
| D | requested_by | requester email |
| E | requested_at | ISO |
| F | fire_at | requested_at + 30min |
| G | systems_json | list to tear down (default: all) |
| H | status | `scheduled`\|`firing`\|`done`\|`error` |
| I | google_result | |
| J | worker_result_json | browser-portal teardown results |
| K | trigger_id | Apps Script time-trigger handle |

**Offboarding lifecycle:** request → write row status=`scheduled`, fire_at=+30min, create a
one-shot `ScriptApp.newTrigger('fireOffboarding_').timeBased().after(30*60*1000)`. When it
fires: set `firing`, suspend Google + remove group memberships + revoke Drive shares +
release HubSpot seat (all in Apps Script), then enqueue property24/cma/dialfire
`deactivate` rows on the Provisioning Queue for the worker. No cancel window (user choice).
Idempotent: re-firing a `done` row is a no-op.

## 4. External systems - provisioning contracts

| System | API? | Home | Create | Deactivate |
|--------|------|------|--------|------------|
| Google Workspace | yes (AdminDirectory advanced service - NOT yet implemented anywhere; build fresh) | Apps Script | `AdminDirectory.Users.insert` name@quay1.co.za (fallback name.surname@), pass `G{First}@002`, changePasswordAtNextLogin=true; then `AdminDirectory.Members.insert` per group | `AdminDirectory.Users.update {suspended:true}`, remove group memberships, transfer/revoke Drive |
| PropData | yes (REST) | Apps Script | POST agent (feeds-api.propdata.net) - needs `api_key`+`vendor id` headers (BLOCKED on creds) | deactivate/remove agent |
| Property24 | no | Worker | browser: admin → add agent (auto-links via Google login too) | browser: deactivate agent |
| CMA (cmainfo.co.za) | no | Worker | browser: create user - OTP/2FA gated (see cma-lookup, parked) | browser: disable user |
| Dialfire | no (for user mgmt) | Worker | browser: add agent seat | browser: remove seat |

- Google account is the **linchpin**: created first; P24 auto-links when the broker later
  logs into Property24 with the Quay1 gmail (still also create explicitly for the profile).
- PropData `api_key`/vendor-id: provisioned by emailing api-support@propdata.net. Until then
  the propdata provisioner runs in **dry-run** (logs the payload it WOULD send).
- Passwords: temp password in the induction email packet only (email, never WhatsApp).

## 5. Frontend (web/) - built with the `ui-ux-pro-max` skill

Single page, three sections behind the JWT gate, Quay 1 brand
(#3D5BA6 navy / #FDC503 yellow / #98C5ED / #D20A03; Montserrat). Aqua surfaces use the
Aqua gold theme (#F4B400 / #3A2D00 / #8A6D0B). No dark mode (user pref). No em/en dashes.

1. **Onboard** - entity toggle (Quay 1 / Aqua) → contract request form (fields per §3.1),
   provisioning checkboxes (which systems to create), submit → generates contract + enqueues
   provisioning.
2. **Provisioning status** - live table from the queue tabs (per-system pill:
   pending/in progress/done/error), retry button (super only).
3. **Offboard** - pick person, confirm, submit → shows "will fire at HH:MM (in 30 min)".

Accessibility: WCAG AA contrast, keyboard nav, dark text on yellow (never white-on-yellow).

## 6. Non-negotiables (from user memory)

- **Never auto-send general emails** - the recruitment/onboarding pipeline is the ONLY
  scoped exception (contract/induction/digest auto-send OK). Offboarding notifications:
  DRAFT unless explicitly told to send.
- **No em/en dashes** anywhere.
- **No dark mode.**
- Destructive ops (offboarding suspends real accounts) - build + dry-run only in this repo;
  live arming is user-gated. Every provisioner supports `DRY_RUN=1`.
- Secrets (tokens, api keys) live in Script Properties / gitignored config / keychain -   NEVER in committed source.
- Files under 500 lines; split modules.

## 7. Build order / ownership

1. researcher → pull live Quay `1apqpQ…` source via clasp, confirm Aqua `16tzth…` shape,
   confirm sheet schemas. Fills any gaps in this SPEC.
2. architect → finalize repo layout + module boundaries + the two queue-tab contracts.
3. backend (apps-script) → consolidated Code.js (router, both contract flows, FICA,
   induction, Google+PropData provisioning, queue writer, offboarding + 30min trigger).
4. worker (python) → poll.py + property24/cma/dialfire provisioners (create+deactivate),
   all with DRY_RUN default on.
5. ui (ui-ux-pro-max skill) → web/ single page per §5.
6. tester → node --check on Code.js, python -m py_compile, offline dry-run harnesses.
7. reviewer → /code-review pass; report findings.

## 8. Known blockers to surface, not silently skip

- clasp login may be stale → pulling the live Quay backend needs `clasp login` (pagan@).
- PropData creds not yet provisioned → propdata provisioner dry-run only.
- CMA OTP/2FA → cma provisioner is a stub with a TODO + clean interface, not a fake success.
- Dialfire user-management portal path unconfirmed → dialfire provisioner scaffolded, marked
  NEEDS-PORTAL-MAP.
- HubSpot seat auto-create/release has licensing cost → gate behind a config flag, default off.

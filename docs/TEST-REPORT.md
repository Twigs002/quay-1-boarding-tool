# Test Report - Quay 1 Boarding Tool (offline verification)

Owner: tester. Scope: OFFLINE ONLY. No live API, sheet, portal, or email was ever
touched. Every check runs against mocks / DRY_RUN / a fake queue. Generated 2026-07-28.

## Verdict

| Area | Result |
|------|--------|
| Syntax: `node --check` (18 .js) + `py_compile` (10 .py) | PASS |
| Backend harness (Config/Util/Auth/Queue/Provisioning/Offboarding) | PASS |
| Worker harness (poll + provisioners, DRY_RUN, no network) | PASS |
| Queue-column contract cross-check (backend writer <-> worker reader) | PASS |
| End-to-end `doPost` (Router -> Auth -> handler) | PASS |
| **UI <-> backend POST seam** | **PASS - conformed to CONTRACTS section 8** |

Overall: **GREEN.** The two halves of the shared bus (Apps Script writer <-> Python
worker reader) are correct field-for-field, the offboarding lifecycle is sound, and
the frontend<->backend POST seam - which CONTRACTS.md had not frozen - is now frozen
as **CONTRACTS.md section 8** and both sides conform to it (verified end-to-end
through the real `doPost`). The earlier 9 mismatches are resolved: backend
`_quay1Fields_`/`_aquaFields_` accept the canonical SPEC-3.1 names, `readForUi_`
returns `rows`, the UI sends `systems` (was `provision`) and collects `end_date` for
fixed-term Aqua. 6/6 offline suites pass.

Final hardening round (all verified): worker DRY_RUN fail-safe (typo/garbage stays
dry), backend offboarding reaper + `LockService` dup-guard, UI split of `app.js`
(now `app.js` 497 + `app.offboard.js` 138, every file < 500 lines). Suite extended to
cover all of them; `node --check` globs `web/*.js` so the split files are included.

## How to reproduce (all offline, exit 0 = pass)

```
cd /Users/paganstorm/Projects/quay-1-boarding-tool
# 1. syntax (web/*.js glob covers the split app.js + app.offboard.js)
for f in apps-script/*.js web/*.js; do node --check "$f"; done
python3 -m py_compile worker/poll.py worker/config.py worker/sheets.py worker/log_setup.py worker/provisioners/*.py
# 2. harnesses (all exit 0)
node   tests/node_harness.js     # backend + column cross-check + offboarding lifecycle
python3 tests/py_harness.py      # worker dry-run + column cross-check
node   tests/e2e_doPost.js       # AUTHORITATIVE seam gate: real Router->Auth->handler vs CONTRACTS 8
node   tests/seam_check.js       # static seam heuristic (advisory)
```

`tests/e2e_doPost.js` is the authoritative seam conformance gate (behavioral, drives
real `doPost`); `tests/seam_check.js` is a static grep heuristic and can lag a
normalize-shim, so trust the end-to-end gate when they disagree.

Test scaffolding (all under `tests/`): `contracts.json` (the ONE canonical column
contract, from docs/CONTRACTS.md), `contracts.js` / `contracts.py` (both load it),
`gas_mocks.js` (in-memory GAS services), `load_gas.js` (runs real apps-script in a
vm), `fake_queue.py` (in-memory queue + hard socket network-guard).

---

## 1. Syntax

- `node --check`: all 15 `apps-script/*.js` + `web/app.js`, `web/auth.js`,
  `web/config.example.js` pass.
- `python3 -m py_compile`: all 10 worker files pass.

## 2. Backend (Apps Script) - `tests/node_harness.js`

Loads the real implemented modules into a vm seeded with GAS mocks and exercises
them. All PASS:

- **Config**: `CFG.SYSTEMS/WORKER_SYSTEMS/INLINE_SYSTEMS/ACTIONS/QUEUE_STATUS/`
  `OFFB_STATUS` all match the contract; `MAX_ATTEMPTS=3`, `OFFBOARD_DELAY_MIN=30`.
  Safety flags default SAFE: `DRY_RUN_()` on, `offboardArmed_/hubspotSeatEnabled_/`
  `propdataLive_` off.
- **Util**: `uid_('OFF')` matches `OFF-<ts>-<rand>`; `firstName_/lastName_` keep
  multi-word surnames; `fmtRemuneration_('8000') == 'R8,000.00'`.
- **Queue writer (live)**: `enqueueProvision_` and `writeOffboard_` land every field
  in its exact CONTRACTS column (A..N / A..K), `queue_id` = `PQ-<folderId>-<system>-<ts>`,
  status `pending` for worker systems, `attempts=0`, `updated_at` stamped;
  offboarding `systems_json` defaults to the 6-system list incl. `hubspot`.
- **Offboarding lifecycle**: `offboardRequest_` schedules exactly ONE
  `fireOffboarding_` trigger at `+30min` (1,800,000 ms); a due row fires to `done`
  and enqueues a `property24` deactivate for the worker; **with `OFFBOARD_ARMED`
  off there is NO live Google suspend** (destructive op suppressed); a re-fire of a
  `done` row is a no-op and enqueues **no duplicate** deactivate rows (the
  `enqueueDeactivate_` dup-guard now runs inside a `LockService` script lock to
  close the TOCTOU race).
- **Offboarding reaper** (`reapOffboarding_`, every 15 min): recovers a
  due-but-unfired `scheduled` row (drives it to `done` + enqueues the deactivate),
  is idempotent on re-sweep (no status flip, no duplicate row), does NOT auto-retry
  an `error` row, and DRAFTS (never sends) a one-time manual-completion alert for it.
- **DRY_RUN suppression**: `googleCreate_` under DRY_RUN makes zero AdminDirectory /
  UrlFetch calls.
- **Never-auto-send**: no email was SENT during the run (offboard notice is a Gmail
  DRAFT; the onboarding contract email is the one scoped auto-send exception).

## 3. Worker (Python) - `tests/py_harness.py`

Drives the REAL `poll.process_row` against a `FakeBus` with `DRY_RUN=1` and a hard
socket network-guard (any real connection raises). All PASS:

- `property24` + `dialfire`, create AND deactivate -> `done`, result stamped
  `dry_run=true` with a `would` field.
- `cma` create + deactivate -> terminal `skipped` (Skip; never a faked `done` or a
  retriable `error`).
- Row at `MAX_ATTEMPTS` -> `error {"error":"max attempts"}` WITHOUT being claimed.
- Row not `pending` at claim -> `lost_claim`, no write-back.
- Happy path transitions observed exactly `pending -> in_progress -> done`.
- Network guard confirmed live.
- **DRY_RUN fail-safe** (`_dry_run_from_env`): only an exact, trimmed, lowercased
  member of the live-set `{0,false,no,off}` arms live provisioning; unset, empty, and
  every typo/garbage value (`ture`, `flase`, `yes`, `xyz`, ...) keep DRY_RUN ON. The
  switch cannot fail open. 20 assertions, all green.

## 4. Queue-column contract cross-check (the #1 correctness gate)

Backend writer (`apps-script/Queue.js` `PQ_COL`/`OQ_COL`, 0-based) and worker reader
(`worker/sheets.py` `PROV_COLS`/`OFFB_COLS`, 1-based) are BOTH parsed from source
and diffed against the single canon (`tests/contracts.json`, from CONTRACTS.md).

Result: **field-for-field identical.** Provisioning `A=queue_id .. N=updated_at`
(14 cols), Offboarding `A=offb_id .. K=trigger_id` (11 cols). `hubspot` correctly
lives only in the offboarding `systems_json` default + master vocab, never in the
Provisioning-Queue `system` enum. No drift.

---

## 5. UI <-> backend POST seam - PASS (frozen as CONTRACTS section 8)

`docs/CONTRACTS.md` had frozen only the backend<->worker queue columns, so the
frontend<->backend POST contract drifted (9 mismatches were found). Per the team
lead, one canonical contract was written - **`docs/CONTRACTS.md` section 8, "Per-kind
request/response field contract"** (SPEC-3.1 field names, `systems: string[]`,
`accessToken` JWT, `status` -> `rows`) - and both sides were pointed at it. Both now
conform, verified end-to-end through the real `doPost` (`tests/e2e_doPost.js`).

### Conformance (all verified at runtime)
- All 5 `kind`s dispatch; JWT is `accessToken` end-to-end; flat body envelope.
- **onboard_quay1 / onboard_aqua** accept the canonical SPEC-3.1 names - backend
  `_quay1Fields_` / `_aquaFields_` map `name->full_name`, `email->candidate_email`,
  `contact->contact_number`, `senior_name->senior_broker`, `designation->activity`
  (legacy names still accepted). The canonical payload now clears field validation
  (only a user-gated Script-Property config error remains, which is expected).
- **status** returns `{ ok, rows:[...], offboarding:[...] }`; the UI reads `rows`,
  pills read `rows[].status`.
- **systems**: the UI sends the checkbox selection as `systems` (was `provision`);
  backend `resolveSystems_` consumes it as the explicit list.
- **Aqua fixed-term**: the UI now collects `end_date` (shown when
  `agreement_type=fixed`), satisfying `onboardAqua_` validation.
- **offboard** returns `{ok, offb_id, fire_at}`; **retry** is super-gated.

### Residual adjudicated (team lead's ask)
- **systems vs provision key:** canon 8.1 names it `systems`. The UI sends `systems`;
  backend `_provisionList_` reads `provision || systems`, so it accepts the canonical
  key. No deviation to route - resolved.
- **deal_type (Sale/Rental):** the UI added a Sale/Rental selector sending `deal_type`
  (lowercase `sale|rental`, matching the backend's lowercased `quay1TemplateFor_`), so
  Rental is now reachable. Fully resolved (no longer an open item).
- **enum casing:** `deal_type` = `sale|rental`, `agreement_type` = `monthly|fixed|`
  `permanent` - lowercase on both sides.

`tests/e2e_doPost.js` is the authoritative gate (exit 0 = conformed);
`tests/seam_check.js` reports `SEAM OK: 0 drift, 12 aligned`. Both sides landed
independent fixes; this is the authoritative re-run after both.

---

## Notes / known non-blockers surfaced (not silently skipped)

- Worker P24 + Dialfire portals are `NEEDS-PORTAL-MAP` (TODO selectors); CMA is
  OTP-gated -> terminal `skipped`. All correct and dry-run safe.
- Backend live paths (Google/AdminDirectory, PropData, HubSpot seat) are gated
  behind flags defaulting OFF and were exercised only in DRY_RUN; live arming is
  user-gated and cannot be tested from here (no creds, by design).
- `config.js` / `.env` / `service-account*.json` / `browser_profile/` are
  gitignored; no secret was read or committed.

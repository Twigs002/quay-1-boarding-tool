# Code Review - Quay 1 Boarding Tool

Reviewer (final gate). Scope: the whole consolidated build on branch `swarm-build`
(review baseline commit `build: initial consolidated lifecycle hub (swarm)`), checked
against `docs/SPEC.md` and `docs/CONTRACTS.md`. Review only: nothing was deployed, armed,
or run live.

Method: full manual read of every source file, the offline test suite re-run, the
`code-review` skill (high effort, 3 finder angles + verification), plus the six targeted
hand-checks the lead asked for.

## Verdict: PASS with fixes (not yet arm-ready)

The two halves of the shared bus are correct field-for-field, the offboarding lifecycle is
sound, auth is enforced server-side, DRY_RUN gates every live mutation, and no secret is
committed. The UI-to-backend seam that the tester put on HOLD has since been reconciled by
the backend and UI agents (verified in source and by re-running the harnesses). No confirmed
release-blocking correctness bug remains.

What stands between here and arming live (updated after the build agents' final hardening round):
ALL six review findings are now resolved and re-verified - DRY_RUN fail-safe direction, offboarding
stuck-row reaper, seam-test staleness, docs dash sweep, the `web/app.js` split (now app.js 497 +
app.offboard.js 138, every source file under 500), and the `enqueueDeactivate_` lock. The full
offline suite is 6/6 green, with added coverage for the reaper and the DRY_RUN fail-safe. What
remains is only the known external blockers in SPEC section 8 (PropData creds, CMA OTP, portal DOM
maps, Drive teardown wiring), which are outside this repo. Note: the repo was renamed to
`quay-1-boarding-tool` and committed on `swarm-build` (`06c34f4`).

## Contract + safety hand-checks (all PASS)

- **Queue-tab column contract is identical between the Apps Script writer and the Python
  reader.** `Queue.js` `PQ_COL` (A..N) and `sheets.py` `PROV_COLS` (A..N) match field for
  field; `OQ_COL` (A..K) and `OFFB_COLS` (A..K) match. `hubspot` appears only in the
  offboarding `systems_json` default, never in the Provisioning-Queue `system` enum. The
  worker claims only `{property24, cma, dialfire}`; Apps Script does google/propdata inline.
- **DRY_RUN gates every destructive/external call in both halves.** Backend: `googleCreate_`,
  `googleSuspend_` (also behind `OFFBOARD_ARMED`), `_propdata_` (behind `PROPDATA_LIVE` + creds),
  `hubspotReleaseSeat_` (behind `HUBSPOT_SEAT_ENABLED`) all short-circuit under `DRY_RUN_()`.
  Worker: `Provisioner.create/deactivate` route to the dry path before `_create_live` (the only
  place Playwright is imported / a browser opens); CMA raises `Skip` in both modes. Flags default
  SAFE (DRY_RUN on, everything else off), seeded by `_seedFlagDefaults_` without clobbering.
- **Offboarding is idempotent and no cancel-window code exists.** `fireOffboarding_` processes
  every due `scheduled` row; a re-fire of a `done` row is a no-op; `enqueueDeactivate_` guards
  against duplicate open deactivate rows; the one-shot trigger deletes itself by id.
- **Auth.** Every admin kind asserts `requireAdmin_` (`onboard_quay1`, `onboard_aqua`,
  `provision`->`provisionAll_`, `offboard`) or `requireSuper_` (`retry`) server-side. `status`
  is read-only and broker-scoped by `requester_email`. Token-less kinds (`fica_upload`,
  `book_induction`) are candidate-facing and gated by the unguessable folderId; none mutate a
  privileged resource. No shared-secret fallback; JWT is verified against Supabase every call.
- **No secrets committed.** Grep for keys/tokens/passwords found only key NAMES, keychain
  refs, and comments. `.gitignore` covers `web/config.js`, `.env`/`worker/.env*`, `.clasp.json`,
  `service-account*.json`, `browser_profile/`, `__pycache__`, `*.log`. Only `config.example.js`
  (placeholders) is tracked.
- **No dark mode.** Only "No dark mode" comments; no `prefers-color-scheme` / theme toggles.

## Findings (prioritized)

No confirmed release-blocking bug. Ranked should-fix and nice-to-have below.

### Should-fix

> Re-verified after the build agents' follow-up fixes: findings 1, 2, 3, and 6 are RESOLVED.
> The only open should-fix is 4 (app.js line count). Full suite remains 6/6 green.

1. **RESOLVED - DRY_RUN fail-safe direction fixed (worker).**
   `worker/config.py` now defines `_DRY_RUN_LIVE_VALUES = {"0","false","no","off"}` and
   `DRY_RUN = raw not in _DRY_RUN_LIVE_VALUES`, so any unrecognized/typo value fails safe to
   dry-run, and the comment is corrected. Verified in the working tree.

2. **RESOLVED - offboarding stuck-row reaper added (backend).**
   `reapOffboarding_()` (`Offboarding.js:129`) now re-fires idempotently a `scheduled` row whose
   one-shot trigger never fired and a hung `firing` row, and drafts (never sends) a
   manual-completion alert to `CFG.INTERNAL_NOTIFY` for an `error` row. It is wired to a 15-minute
   time trigger in `Setup.js` (`setupTriggers`). Verified. (Original risk: a `firing`-interrupted
   or `error` OQ row was terminal with no recovery, silently leaving live Google access.)

3. **RESOLVED - seam tests updated to the frozen canon (tester).**
   Earlier the two seam tests encoded the old drift as their pass condition and failed on correct
   code. The tester has since frozen a single canon (`docs/CONTRACTS.md` section 8, per-kind
   request/response fields) and updated `seam_check.js` + `e2e_doPost.js` to assert it. Re-verified
   by the reviewer: full offline suite is 6/6 green (`node --check` + `py_compile`, node_harness,
   py_harness, e2e_doPost, seam_check all exit 0; `SEAM OK: 0 drift, 12 aligned`). No action left.

4. **`web/app.js` is 601 lines, over the 500-line rule (ui).**
   CLAUDE.md (repo root and global): "Keep files under 500 lines." `app.js` bundles the three
   views plus the login gate; split one out (e.g. the offboard view or the login gate).

5. **`enqueueDeactivate_` duplicate guard is not atomic (backend).**
   `Queue.js:110` reads the queue and decides to append outside any lock (`enqueueProvision_`
   locks only its own append). Two overlapping `fireOffboarding_` runs (two offboards seconds
   apart, or a re-fire racing the first) can both pass the guard and enqueue duplicate
   `deactivate` rows for the same (email, system), which the worker then runs twice. Low
   probability on a single host and a deactivate is near-idempotent, but the check-then-append
   should hold the document lock across both.

6. **RESOLVED - em/en dashes stripped from the docs.**
   The five markdown docs were swept; a fresh grep for U+2013/U+2014 across all `*.md` now returns
   nothing. Code and email/HTML strings remain clean.

### Nice-to-have

7. **A worker claim interrupted mid-write strands a row `in_progress` (worker).**
   `poll.py:64` calls `bus.claim()` outside the try/except, and `claim()` does three separate
   `update_cell` writes after flipping to `in_progress` (`sheets.py:158-160`). A transient Sheets
   429/500 on the 2nd/3rd write raises out of `claim` -> out of `process_row` (documented "never
   raises") -> aborts the pass, leaving the row `in_progress`, which `pending_provisioning` never
   re-scans. Same class as (2): no reaper for stale `in_progress`. Consider a stale-claim reaper
   or wrapping claim so a partial write releases back to `pending`.

8. **Login `attempt()` has no try/catch; a network reject freezes the PIN gate (ui).**
   `web/app.js` `attempt()` awaits `AUTH.signIn` and is called un-awaited from the keypad/keydown
   handlers. If `signInWithPassword`/the staff query rejects on a network blip, the rejection is
   unhandled, `pin` is never cleared, and the gate sits with six filled dots and no error.
   Recoverable by reload, but wrap `attempt()` in try/catch and show an error.

9. **Dead code: `provisionNoticeHtml_` + `SYSTEM_PROVISION_TO` (cleanup).**
   `Email.js:93` (a ~28-line branded builder) and `Config.js:112` are defined but never
   referenced. Either wire the "please set up these accounts" notice into provisioning or remove
   both, so the repo does not imply a notification that is never sent.

10. **Cell-by-cell Sheet writes and duplicated lookups (cleanup/efficiency).**
    `Tracker.js:111` writes ~15 columns one `setValue` at a time inside the document lock (Queue.js
    already batches via `_appendTextRow_`); `sheets.py` claim+finish spend ~6 round-trips per row.
    The find-row-by-column scan is copy-pasted 4x (`Queue.js:170,191`, `_findOffbRow_`,
    `Tracker.findOnboardingRow_`) and the PDF-gen tail 2x (`Onboarding_Quay1`/`_Aqua`); and
    `DRY_RUN_()` re-implements `flag_`. None affect correctness; batch and share when convenient.

## Known external blockers (surface, do not silently skip - from SPEC section 8)

- Google/AdminDirectory has no prior implementation; ships behind DRY_RUN, cannot be
  live-tested here (needs a Workspace super-admin deployer).
- PropData `api_key`/vendor-id not provisioned -> dry-run only.
- CMA OTP/2FA unsolved -> the CMA provisioner returns terminal `skipped`, never a fake success.
- Property24 / Dialfire admin DOM unmapped -> selectors are `TODO(portal-map)`, dry-run only.
- **Drive teardown is a logged no-op even when armed** (`Provisioning.js:207-210`): `googleSuspend_`
  suspends the user and removes group memberships, but Drive transfer/revoke is a TODO string
  unless `DRIVE_TRANSFER_TO` is set and the Data Transfer API is wired. SPEC lists Drive revoke as
  part of offboarding, so wire it (or accept it explicitly) before arming.
- HubSpot seat release endpoint is a `TODO(B5)` guess, gated off by `HUBSPOT_SEAT_ENABLED`.

## What remains before the user can arm it live

The two safety should-fixes (DRY_RUN direction #1, offboarding recovery #2) are now RESOLVED and
re-verified, as is the seam (#3) and the docs sweep (#6). What is left:

1. Provision the external creds/DOM maps and wire Drive teardown (SPEC section 8): PropData
   `api_key`/vendor-id, CMA OTP, Property24 + Dialfire admin DOM selectors, and the Drive
   transfer/revoke step in `googleSuspend_` (currently a logged no-op unless `DRIVE_TRANSFER_TO`
   is set and the Data Transfer API is wired).
2. Optional code-hygiene: split `web/app.js` (615 lines, over the 500-line rule) and clear the
   nice-to-have items below.
3. Then, per SPEC section 6, arming is a deliberate, user-gated flag flip (DRY_RUN=0 /
   OFFBOARD_ARMED=1), never automatic.

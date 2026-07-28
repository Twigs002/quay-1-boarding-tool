# Contracts - the frozen wire between Apps Script and the worker

> This file is the single machine-readable source for the two queue-tab schemas, the
> claim/CAS protocol, and the offboarding state machine. Backend (apps-script/) and worker
> (worker/) BOTH import field names from here. Do NOT rename a column or add a status value
> without editing this file first. Column letters are load-bearing: they map 1:1 to Google
> Sheet columns A, B, C, ... in order.

Source of truth for higher-level design: `docs/SPEC.md`. This file freezes only the shared
bus so the two halves cannot drift.

---

## 1. `Provisioning Queue` tab  (Apps Script writes, worker executes browser rows)

One row per (person x system). Header row is row 1; data starts row 2. Columns A..N.

| col | field         | writer                    | type   | notes |
|-----|---------------|---------------------------|--------|-------|
| A   | queue_id      | apps-script               | string | unique, e.g. `PQ-<folderId>-<system>-<ts>` |
| B   | folderId      | apps-script               | string | links back to the `Onboarding` row (hidden key) |
| C   | full_name     | apps-script               | string | |
| D   | first_name    | apps-script               | string | |
| E   | id_number     | apps-script               | string | SA ID |
| F   | quay_email    | apps-script               | string | provisioned Google address (may be blank if google not yet done) |
| G   | cell          | apps-script               | string | |
| H   | system        | apps-script               | enum   | `google` \| `propdata` \| `property24` \| `cma` \| `dialfire` |
| I   | action        | apps-script               | enum   | `create` \| `deactivate` |
| J   | payload_json  | apps-script               | json   | system-specific extra fields; `{}` if none |
| K   | status        | apps-script + worker (CAS)| enum   | `pending` \| `in_progress` \| `done` \| `error` \| `skipped` |
| L   | result_json   | worker                    | json   | worker writes account id/username on success, or `{"error": "..."}` |
| M   | attempts      | worker                    | int    | worker increments on each claim; start 0 |
| N   | updated_at    | apps-script + worker      | iso    | ISO-8601 UTC on every write |

### Who executes which system
- `google`, `propdata` are executed **INLINE by Apps Script**. Apps Script writes the row
  already resolved to `done` (or `error`) for audit. The worker MUST ignore rows where
  `system in {google, propdata}` - they are never `pending`.
- `property24`, `cma`, `dialfire` are written `pending` by Apps Script. The worker owns them.

### payload_json shapes (by system)
- `google`:      `{ "groups": ["team@quay1.co.za", ...], "designation": "...", "temp_pw": "G...@002" }`
- `propdata`:    `{ "vendor_branch": "...", "role": "agent" }`
- `property24`:  `{ "branch": "...", "google_linked": true }`
- `cma`:         `{ }`  (OTP-gated; worker returns `skipped` with a TODO note)
- `dialfire`:    `{ "campaign": "..." }`  (portal path unconfirmed; NEEDS-PORTAL-MAP)

---

## 2. `Offboarding Queue` tab  (Apps Script writes + self-executes google, worker executes browser teardown)

One row per offboarded person. Header row 1; data row 2+. Columns A..K.

| col | field               | writer      | type   | notes |
|-----|---------------------|-------------|--------|-------|
| A   | offb_id             | apps-script | string | unique, e.g. `OFF-<ts>-<rand>` |
| B   | full_name           | apps-script | string | |
| C   | quay_email          | apps-script | string | the Google account to suspend (linchpin key) |
| D   | requested_by        | apps-script | string | requester email (from JWT) |
| E   | requested_at        | apps-script | iso    | ISO-8601 UTC |
| F   | fire_at             | apps-script | iso    | requested_at + 30 min |
| G   | systems_json        | apps-script | json   | list to tear down, default `["google","propdata","property24","cma","dialfire","hubspot"]` |
| H   | status              | apps-script | enum   | `scheduled` \| `firing` \| `done` \| `error` |
| I   | google_result       | apps-script | json   | suspend + group-removal + Drive-revoke outcome |
| J   | worker_result_json  | worker      | json   | browser-portal teardown results, keyed by system |
| K   | trigger_id          | apps-script | string | ScriptApp time-trigger unique id (for idempotency/cleanup) |

The browser teardown for an offboard is NOT executed off this tab by the worker directly.
When `fireOffboarding_()` runs it enqueues `deactivate` rows on the **Provisioning Queue**
(section 1) for property24/cma/dialfire. Column J here is a roll-up the worker/back-end can
optionally mirror; the authoritative per-system browser results live on the Provisioning
Queue rows. This keeps the worker reading exactly one execution tab.

---

## 3. Claim / CAS protocol (worker <-> Provisioning Queue)

The Sheet is the lock. There is no separate mutex. Compare-and-set on column K:

```
for each row where system in {property24, cma, dialfire}:
    read (row_index, status_K, attempts_M)          # fresh read
    if status_K != "pending":        continue        # someone else owns it / already done
    write K = "in_progress", M = attempts+1, N = now # CLAIM
    re-read K                                         # verify our write stuck
    if K != "in_progress":           continue        # lost the race, back off
    try:
        result = provisioner.run(action, row)
        write L = result_json, K = "done", N = now
    except Skip as s:                                 # e.g. CMA OTP not solvable headless
        write L = {"skipped": s.reason}, K = "skipped", N = now
    except Exception as e:
        write L = {"error": str(e)}, K = "error", N = now   # M already incremented
```

Rules:
- Only ONE worker process runs (single Mac host, like virtual-agent-lookup). The CAS + re-read
  is belt-and-suspenders against a double-run, not a full distributed lock.
- Never act on a row unless it is `pending` at claim time.
- `error` rows are ret/riable by a human (super clicks retry in the UI, which flips K back to
  `pending`). The worker does NOT auto-retry `error`; it only picks up `pending`.
- `skipped` is terminal for the worker (needs human/portal work) and is distinct from `error`.
- `attempts` (M) bounds runaway retries: if a row re-enters `pending` with M >= MAX_ATTEMPTS
  (config, default 3) the worker writes `error` with `{"error":"max attempts"}` and stops.
- `DRY_RUN=1` (worker default ON): the provisioner logs the action it WOULD take and writes
  `L = {"dry_run": true, "would": "..."}`, `K = "done"`. No live portal mutation.

---

## 4. Offboarding lifecycle state machine (Apps Script)

States are column H of the Offboarding Queue. No cancel window (user choice).

```
                 request (doPost kind=offboard)
                        │
                        ▼
   [write row]  status = scheduled ────────────────────────────────┐
   fire_at = now + 30min                                            │
   ScriptApp.newTrigger('fireOffboarding_')                         │
       .timeBased().after(30*60*1000)  → trigger_id → col K         │
                        │                                           │
                 (~30 min later, trigger fires)                     │
                        ▼                                           │
   fireOffboarding_()  looks up row by trigger_id                   │
        │                                                           │
        ├─ if status == done  → NO-OP (idempotent re-fire)          │
        │                                                           │
        ├─ set status = firing                                      │
        │     · Google: Users.update {suspended:true}              │
        │     · remove group memberships                            │
        │     · revoke / transfer Drive shares                      │
        │     · release HubSpot seat  (ONLY if HUBSPOT_SEAT_ENABLED)│
        │     · write google_result (col I)                         │
        │     · enqueue Provisioning Queue `deactivate` rows for    │
        │       each browser system in systems_json (worker picks up)│
        │                                                           │
        ├─ on success → status = done ──────────────────────────────┘
        └─ on throw   → status = error   (col I holds partial result; human re-runs)
```

Idempotency guarantees:
- Re-firing a `done` row is a no-op (guard on entry).
- Google suspend is naturally idempotent (`Users.update {suspended:true}` on an already
  suspended user succeeds).
- Enqueue is guarded: do not add a Provisioning Queue `deactivate` row for a (quay_email,
  system) pair that already has an open (`pending`/`in_progress`) deactivate row.
- The one-shot trigger deletes itself after firing (clean up by `trigger_id`).

---

## 5. Enums (shared vocabulary - import these exact strings)

```
SYSTEMS        = ["google", "propdata", "property24", "cma", "dialfire", "hubspot"]
WORKER_SYSTEMS = ["property24", "cma", "dialfire"]        # rows the worker claims
INLINE_SYSTEMS = ["google", "propdata"]                   # Apps Script executes inline
ACTIONS        = ["create", "deactivate"]
QUEUE_STATUS   = ["pending", "in_progress", "done", "error", "skipped"]
OFFB_STATUS    = ["scheduled", "firing", "done", "error"]
ENTITIES       = ["quay1", "aqua"]
```

`hubspot` appears in offboarding `systems_json` and is handled inline by Apps Script (seat
release), gated on `HUBSPOT_SEAT_ENABLED`. It is never a worker row.

---

## 6. Program -> System mapping  (architect decision, 2026-07-28)

Quay1's broker-facing `PROGRAM_OPTIONS` are NOT the `SYSTEMS` enum. A "program" describes what
a broker is trained on / set up for; a "system" is an account we provision. The mapping below
is the single source both the frontend (which checkbox pre-checks what) and the backend
(which program enqueues a Provisioning Queue row) import.

| Quay1 program (label)      | provisions system | notes |
|----------------------------|-------------------|-------|
| `cma` ("CMA account")      | `cma`             | enqueues a `cma` create row (worker, OTP-gated) |
| `dialfire` ("Dialfire")    | `dialfire`        | enqueues a `dialfire` create row (worker) |
| `whatsapp` ("WhatsApp Business") | (none)      | informational only; WATI is provisioned manually |
| `training` ("Calling training")  | (none)      | informational only; internal, no account |
| `other` (free-text + note) | (none)            | note stored on the Onboarding row |

Core broker stack, provisioned by DEFAULT on every Quay1 onboard (NOT program-gated; the UI
shows them as provisioning checkboxes default-checked):

```
CORE_QUAY1_SYSTEMS = ["google", "propdata", "property24"]
```

So the systems enqueued for a Quay1 onboard = `CORE_QUAY1_SYSTEMS` (minus any the operator
unchecks) PLUS `cma`/`dialfire` when their program is ticked. `google`/`propdata` run inline;
`property24`/`cma`/`dialfire` go to the worker. Aqua onboards do not use Quay1 programs; their
provisioning selection comes straight from the UI system checkboxes.

---

## 7. API request envelope  (frontend <-> Apps Script router)

Every POST is `Content-Type: text/plain;charset=utf-8` (no-preflight) with a JSON body:

```
{ "kind": "<see dispatch table>", "accessToken": "<supabase jwt>", ...fields }
```

- The JWT field is named **`accessToken`** (NOT `token`). Backend verifies it via Supabase
  `/auth/v1/user`, then reads `staff` keyed on `auth_user_id`, and rejects when `active===false`.
  This is the exact `_verifyCaller_` lifted from the live Aqua Code.js.
- Admin/write kinds require a valid `accessToken` (is_super || is_admin). There is NO shared-
  secret fallback in the consolidated app (SPEC section 2: JWT only).
- Candidate-facing kinds (`fica_upload`, `book_induction`) are **token-less**, gated only by an
  unguessable `folderId` present in the tracker. They carry no `accessToken`.
- `requester_name` / `requester_email` on onboard requests are force-overridden server-side
  from the verified JWT; any client-supplied value is ignored (frontend lock is UX only).

Dispatch `kind` values (see docs/ARCHITECTURE.md section 3 for the handler map):
`onboard_quay1`, `onboard_aqua`, `fica_upload`, `book_induction`, `provision`, `offboard`,
`status`, `retry`. The live Quay1 candidate page calls FICA upload `candidate_upload`; the
consolidated app standardizes on `fica_upload` (accept `candidate_upload` as an alias).

---

## 8. Per-kind request/response field contract  (frozen 2026-07-28, tester)

> THE SINGLE SOURCE OF TRUTH for the frontend <-> backend seam. Frontend (`web/app.js`)
> and backend (`apps-script/*`) each conform to THIS, not to each other. Field names are
> the SPEC section 3.1 names (the UI already uses them); the backend maps to its internal
> names where they differ. Body is the flat envelope from section 7:
> `{ kind, accessToken, ...fields }` (text/plain). Every response is a plain JSON object with
> an `ok` boolean; on failure `{ ok:false, error:"..." }` with HTTP 200.

### 8.1 `onboard_quay1`  (admin; entity = quay1)

Request fields:

| field | type | req | notes |
|-------|------|-----|-------|
| `name` | string | yes | full name (backend maps -> full_name) |
| `id_number` | string | yes | SA ID |
| `email` | string | yes | personal email, contract delivery (backend maps -> candidate_email) |
| `contact` | string | no | cell (backend maps -> contact_number) |
| `start_date` | string | no | ISO or `YYYY-MM-DD` |
| `division` | string | no | |
| `team` | string | no | |
| `designation` | string | no | `agent\|senior_agent\|candidate\|admin` (backend maps -> activity) |
| `senior_name` | string | no | reporting senior (backend maps -> senior_broker) |
| `senior_email` | string | no | |
| `commission` | string | no | |
| `deal_type` | string | no | `sale\|rental`, default `sale`; selects the contract template |
| `programs` | string[] | no | broker program codes: `cma,dialfire,whatsapp,training,other` (section 6) |
| `program_other_note` | string | no | present when `other` is in `programs` |
| `systems` | string[] | no | systems to provision (`google,propdata,property24,cma,dialfire`); default = `CORE_QUAY1_SYSTEMS` + program-mapped. This is the operator's checkbox selection and IS authoritative (section 6). Canonical key is `systems`; backend `_provisionList_` also accepts a legacy `provision` alias |
| `requester_name` / `requester_email` | string | no | IGNORED server-side; forced from the JWT |
| `files` | array | no | `[{name, mimeType, dataBase64}]` optional at contract-gen |

Response: `{ ok:true, folderId, folderUrl, pdfUrl, provisioning:{ <system>:<status> } }`.
The UI keys off `folderId`.

### 8.2 `onboard_aqua`  (admin; entity = aqua)

Request fields: `name`(req), `id_number`(req), `email`(req), `contact`, `start_date`,
`division`, `designation`, `remuneration`, `work_hours`, `systems`(string[], default
`["google"]`), plus:

| field | type | req | notes |
|-------|------|-----|-------|
| `agreement_type` | string | yes | `monthly\|fixed\|permanent` |
| `end_date` | string | **required when `agreement_type=fixed`** | must be > `start_date`, span <= 6 months |
| `probation_months` | number | no | permanent only, default 3 |
| `retirement_age` | number | no | permanent only, default 65 |

Response: `{ ok:true, folderId, folderUrl, pdfUrl }`.

### 8.3 `status`  (admin; brokers see only their own candidates)

Request: no extra fields. Response:

```
{ ok:true,
  rows: [ { queue_id, folderId, full_name, first_name, id_number, quay_email, cell,
            system, action, payload_json, status, result_json, attempts, updated_at } ],
  offboarding: [ { offb_id, full_name, quay_email, status, fire_at, ... } ] }
```

The provisioning rows the UI renders (status pills read `status`) live under **`rows`**.
`status` values are the frozen `QUEUE_STATUS` enum (section 5). `offboarding` is optional
extra context (admin-only).

### 8.4 `retry`  (super only)

Request: `{ queue_id }`. Response: `{ ok:true }` or `{ ok:false, error }`. Flips an `error`
Provisioning row back to `pending`.

### 8.5 `offboard`  (admin)

Request: `{ full_name, quay_email(req), systems?:string[] }` (default `systems` = the full
`SYSTEMS` list). `requested_by` is taken from the JWT; a client-sent `requested_by` /
`requested_by_name` is accepted but not trusted. Response: `{ ok:true, offb_id, fire_at }`
(`fire_at` = now + 30 min).

### 8.6 Token-less candidate kinds (backend-rendered forms, NOT the SPA)

`fica_upload` (alias `candidate_upload`) and `book_induction` are posted by the backend's own
`doGet`-rendered candidate pages, folderId-gated, no `accessToken`. They are not part of the
SPA seam; their contract is owned by backend.

### 8.7 Conformance punch list (each side conforms to 8.1-8.5, not to the other)

**web/app.js (ui):**
1. Onboard: rename the systems array field `provision` -> **`systems`** (backend already reads `systems`).
2. Aqua: add an **`end_date`** input, shown/required when `agreement_type=fixed`.
3. (optional) add a Sale/Rental control that sets `deal_type`; else Rental is unreachable.
4. JWT already `accessToken`, names already SPEC-3.1 - no change.

**apps-script (backend):**
1. `onboardQuay1_` / `onboardAqua_`: accept the canonical names by mapping at entry -
   `name->full_name`, `email->candidate_email`, `contact->contact_number`,
   `senior_name->senior_broker`, `designation->activity`. (Keep internal names if you like;
   just normalize the incoming body first.)
2. `readForUi_`: return the provisioning array under **`rows`** (currently `provisioning`).
3. `resolveSystems_` already consumes `f.systems` as the explicit list - no change once the
   UI sends `systems`.
4. `deal_type` already supported - no change.

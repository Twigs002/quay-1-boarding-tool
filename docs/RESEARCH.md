# RESEARCH - live backend contracts for both onboarding pipelines

> Produced by the researcher (read-only pass). Confirms/annotates SPEC.md §3 and §4.
> Where the SPEC was wrong I edited SPEC.md and noted it under "SPEC corrections" below.
> Sources: live Aqua Apps Script source on disk, the Quay 1 frontend hooks (the live
> Quay 1 Apps Script could NOT be cloned - see Blocker B1 - so its contract is
> reconstructed from the frontend, which is authoritative for the wire shape).

---

## 0. SPEC corrections made (only file I edited)

1. **Google/AdminDirectory is NOT "DONE, verified".** The SPEC (§1 diagram + §4 table)
   claimed the Google Workspace provisioning was a "DONE pattern, verified". A disk-wide
   grep (`AdminDirectory|Users.insert|admin/directory` over `~/Projects` + `~/Documents`)
   returns **zero** implementation - only the SPEC/ARCHITECTURE docs mention it. It must be
   built from scratch as an AdminDirectory **advanced service**. I rewrote both lines to say
   "advanced service - NOT yet implemented anywhere; build fresh" and corrected the API calls
   to `AdminDirectory.Users.insert` / `.Members.insert` / `.Users.update`. Also removed a
   stray `──` glyph inside the old table cell.

No other SPEC changes - §3 sheet/queue schemas match what the code implies; CONTRACTS.md
already freezes the queue tabs precisely and needs no correction.

---

## 1. Quay 1 recruitment backend - the `1apqpQ…` web app

**Endpoint (live /exec):**
`https://script.google.com/macros/s/<QUAY1_RECRUIT_EXEC_ID>/exec`
(hardcoded as `RECRUIT_ENDPOINT` in `quay-hubspot/app.js:89`, and as `ENDPOINT` in both
`intake.html:199` and `induction.html:96`). All three frontends hit the SAME web app.

**Auth:** Supabase JWT in the POST body as `accessToken` (project `dqszbqiimbfvmmnpgpsb`,
same as Aqua). Backend verifies via `/auth/v1/user` → reads `staff` row → role. No shared
token on the admin path. The two candidate-facing pages (intake, induction) are token-less
and gated ONLY by the unguessable `folderId`. All POSTs use
`Content-Type: text/plain;charset=utf-8` to dodge CORS preflight.

### 1.1 doPost kinds (reconstructed from frontend callers)

| kind | caller | body (beyond kind+accessToken) | server does |
|------|--------|--------------------------------|-------------|
| *(none)* contract-gen | `app.js` recFormContract | `{ accessToken, fields:{…}, files:[…] }` | copy MOA template, fill, PDF into per-candidate Drive folder, upsert tracker row, email candidate welcome+intake link. Returns `{ ok, folderUrl, pdfUrl }`. NOT idempotent (resubmit re-copies + re-emails - frontend blocks double-submit). |
| `progress` | `app.js` loadProgress | `{ kind, accessToken }` | returns `{ ok, candidates:[…] }` scoped by role (super/admin=all; broker=only own `requester_email` match). |
| `set_programs` | `app.js` _savePrograms | `{ kind, folderId, programs:[{code,label,note?}], accessToken }` | overwrite candidate's programs list on tracker; returns `{ ok, programs }`. Broker may only edit own. |
| `mark_hired` | `app.js` hire checkbox | `{ kind, folderId, accessToken }` | moves candidate to Hired (sets HIRED col + hiredAt); super/admin only. |
| `hired` | `app.js` loadHired | `{ kind, accessToken }` | returns `{ ok, candidates:[…] }` of hired people; super/admin only. |
| `candidate_upload` | `intake.html` | `{ kind, folderId, details:{…}, files:[{label,ext,mimeType,dataBase64}] }` | token-less; store FICA docs+details in candidate folder, tick doc-received flags. Returns `{ ok }`. |
| `book_induction` | `induction.html` | `{ kind, folderId, weekMonday:'YYYY-MM-DD' }` | token-less; books the induction week, returns `{ ok, wed, thu }` (or already-booked). |

### 1.2 doGet
- `?f=<folderId>` (induction.html): returns `{ ok, firstName, booked:bool, induction:{wed,thu} }`
  or `{ ok:false, error:'not_found' }`. Also serves candidate pages in the Aqua analogue.
- Admin GET reads are retired - the dashboard uses `doPost {kind:'progress'}` (JWT in body,
  never in URL).

### 1.3 Contract-gen `fields` (exact names - `app.js:_recruitFields` 1128-1140)
```
full_name, id_number, activity, start_date, team, senior_broker, commission,
candidate_email, contact_number, senior_email,
requester_name  (from session), requester_email (from prefilled field),
programs: [ { code, label } ]           // ticked provisioning toggles
```
`files`: `[ { name, mimeType, dataBase64 } ]` (base64, Apps Script saves to Drive).
**Backend force-overrides `requester_*` from the verified JWT** (frontend lock is UX only).

### 1.4 `PROGRAM_OPTIONS` (provisioning toggles, `app.js:1178`)
```
cma       → "CMA account"
dialfire  → "Dialfire account"
whatsapp  → "WhatsApp Business"
training  → "Calling training"
```
Plus a free-text `other` (carries `note`). NOTE: these are the Quay1 *program* labels shown
to brokers; they are NOT 1:1 the lifecycle-hub `SYSTEMS` enum (`google, propdata,
property24, cma, dialfire, hubspot`). Only `cma` and `dialfire` overlap. The architect must
decide the program→system mapping (e.g. whatsapp/training/whatsapp are non-provisioned or
manual). `google`/`property24`/`propdata` are NOT currently offered as Quay1 toggles.

### 1.5 Candidate `progress` response shape (from `app.js` renderProgress 1249-1348)
Each candidate object: `{ folderId, name, firstName, team, designation, requesterName,
requesterEmail, programs:[{code,label,note?}], allDocsIn:bool,
docs:{ bankConf, poa, idRcv, agreement } (booleans), induction:{wed,thu} (ISO or ''),
confirmSent:bool }`. Hired list adds `hiredAt`. The backend deliberately OMITS `folderUrl`
from broker payloads (FICA docs live there). Doc flags surfaced are exactly the 4 above;
sensitive ID/bank/tax copies are NOT exposed as flags.

### 1.6 `candidate_upload` details (intake.html:240-253) - the FICA superset
```
'ID number', 'Home address', 'Bank - Account holder', 'Bank - Bank',
'Bank - Account number', 'Bank - Branch code', 'Bank - Account type',
'Tax income number', 'PPRA / FFC number', 'Next of kin - Name',
'Next of kin - Contact', 'Next of kin - Relationship'
```
File inputs → labels (FILE_MAP): `f_id`→ID, `f_addr`→POA, `f_bank`→BANK, `f_tax`→TAX,
`f_contract`→signed broker agreement. (Aqua's FICA form is a leaner subset: ID/POA/BANK/TAX,
no NOK/PPRA/signed-contract - see §2.5.)

---

## 2. Aqua contractor backend - `/Users/paganstorm/Projects/aqua-contracts/apps-script/Code.js` (1411 lines, READ IN FULL)

Separate Apps Script, own template/tracker/branding. Endpoint (CONFIG.WEBAPP_URL):
`https://script.google.com/macros/s/<AQUA_EXEC_ID>/exec`

### 2.1 CONFIG (Code.js:20-56)
- `PARENT_FOLDER_ID: '1rbHiMjJ-7xxl3uQIgOSmM-oQMqpk3_ZS'` (Aqua Promotions Contracts Drive folder).
- Script-Properties (NOT in source): `SECRET_TOKEN`, `TEMPLATE_DOC_ID`, `TRACKING_SHEET_ID`,
  `GENERATED_FOLDER_ID`. Set via `setAquaToken()/setAquaTemplate()/setupAqua()`.
- `COMPANY='Aqua Promotions'`, `COMPANY_FULL='Aqua Promotions (Pty) Ltd'`.
- `ALWAYS_CC` = pagan, kat, alan, lieze @quay1.co.za (on every contract email).
- `SYSTEM_PROVISION_TO` = pagan, kat (the "please set up accounts" notice).
- `INTERNAL_NOTIFY` = pagan, kat, alan, lieze (signed alert + Monday digest).
- `SUPABASE_URL` + `SUPABASE_ANON_KEY` - same quay-clock project.

### 2.2 doPost kinds (Code.js:91-170)
`fica_upload` (token-less, folderId-gated, runs BEFORE auth) · then all JWT/token-gated:
`list`, `mark_signed`, `mark_fica`, `weekly_digest_draft`, `hr_tabs`, `hr_add`, `hr_probe`,
`delete_contract`, `patch_template`, `check_hours`. Default branch (no kind) = generate
contract. doGet: `?f=<folderId>` → FICA page; `?token=…&list=1` → rows.

### 2.3 Auth (Code.js:202-234) - SAME pattern lifecycle-hub should reuse verbatim
`_authOk_`: accepts `accessToken` (Supabase JWT; must be `is_admin||is_super`) OR `token`
(shared secret). `_verifyCaller_`: GET `/auth/v1/user` with `Bearer <jwt>` + `apikey:anon`
→ `id` → GET `/rest/v1/staff?auth_user_id=eq.<uid>&select=*` → `{ isSuper, isAdmin }`;
returns null if `active===false`. **This is the exact JWT-verify to lift into the consolidated
router.** (Note it keys on `auth_user_id`; Quay1 dashboard uses the same staff table.)

### 2.4 Tracker columns (Code.js:60-77) - Aqua, 1-indexed, keyed on folderId (col J, hidden)
```
1 CREATED · 2 NAME · 3 ID · 4 START · 5 REMUNERATION · 6 EMAIL · 7 STATUS
(Draft sent|Generated|Signed) · 8 PDF_URL · 9 FOLDER_URL · 10 FOLDER_KEY(hidden) ·
11 FICA (Pending|Received) · 12 WORK_HOURS · 13 TYPE (Month-to-month|Fixed-term|Permanent) ·
14 SYSTEMS (comma labels)
```
All writes via `_putText_` (number-format `@`) to preserve ID/leading zeros.

### 2.5 Agreement-type logic (Code.js:345-448) - the reusable MOA engine
`agreement_type ∈ {monthly(default), fixed, permanent}`. Template carries a `{{term_clause}}`
marker; `_termClauseParts_` returns clause 1.1 body + (permanent only) extra 1.2 probation /
1.3 retirement paragraphs inserted after it. Guardrails (`_validateType_`): fixed needs
`end_date`, end>start, and ≤6 months (company policy). Extra fields: `end_date` (fixed),
`probation_months`(dflt 3), `retirement_age`(dflt 65), `work_hours` (dflt full-time string).
Markers filled: `{{full_name}} {{id}} {{start_date}} {{remuneration}} {{work_hours}}
{{term_clause}}`. `_fmtRemuneration_` normalises to `R8,000.00`.

### 2.6 FICA flow (Code.js:656-864)
`fica_upload` body: `{ kind, folderId, details:{…}, files:[{label,ext,mimeType,dataBase64}] }`.
Gated purely by folderId existing in tracker (`_rowMetaByFolder_`) - no token. Saves files as
`<LABEL> - <name>.<ext>` into a `FICA documents` subfolder, writes a `FICA details … .txt`,
flips tracker FICA→Received, sends branded thank-you. Aqua candidate form labels:
`f_id`→ID, `f_addr`→POA, `f_bank`→BANK, `f_tax`→TAX (optional). Serves its own HTML page from
`_ficaFormPage_` with `setXFrameOptionsMode(ALLOWALL)`.

### 2.7 Email builders (Code.js:1216-1411, all inline HTML, Aqua-branded, no external assets)
`_htmlAgreementEmail_` (contract + FICA button) · `_htmlProvisionEmail_` (account-setup
request to SYSTEM_PROVISION_TO - record-and-notify, creates NO account) · `_htmlSignedAlertEmail_`
(auto-sent on mark_signed transition only) · `_htmlDigestEmail_` (Monday DRAFT, never auto-send)
· `_htmlFicaThankYouEmail_`. Shared shell `_htmlNotifyShell_`. Palette in code is actually the
Quay navy `#3D5BA6/#2E477F` + gold `#FDC503` (NOT a separate "Aqua gold" theme - SPEC §5's
Aqua-gold surface colours are aspirational, not what the live Aqua emails use; flag to ui).

### 2.8 HR sheet push (Code.js:1024-1111) - append-only bridge to HR master
`HR_SHEET_ID='18fBKKsuKJSKKshJ47RHGC44eB_7vRADSy0nzS6Y6DyE'`, tab `AQUA EMPLOYEES`
gid `1128250665`. `hr_add` appends a new-hire row via `AQUA_EMP_COLS` (33-col map: name,
start_date, end_date(default 'Current'), id_number, nationality, email, contact, birthday,
bank, account_number, account_type, tax_number, address, designation, pt_ft, …, NOK×4,
works_with). APPEND-ONLY, never edits. `hr_probe` = self-cleaning write test. This is the
model for the lifecycle-hub "fill HR master sheet" step.

---

## 3. Queue-tab contracts (SPEC §3) - CONFIRMED, already frozen in `docs/CONTRACTS.md`

CONTRACTS.md (already in the repo) precisely freezes both queue tabs, the CAS/claim protocol,
the offboarding state machine, and the enum vocabulary. It MATCHES SPEC §3 with these useful
concretions the backend/worker must honour:
- `Provisioning Queue` A..N; `queue_id` = `PQ-<folderId>-<system>-<ts>`; `google`+`propdata`
  written already-resolved (`done`/`error`) INLINE, worker MUST ignore them; only
  `property24|cma|dialfire` are `pending` for the worker.
- payload_json shapes per system are specified (google groups+temp_pw; propdata vendor_branch;
  property24 branch+google_linked; cma `{}`; dialfire campaign).
- Offboarding Queue A..K; `systems_json` default includes `hubspot`; browser teardown is NOT
  read off this tab - `fireOffboarding_` enqueues `deactivate` rows onto the Provisioning
  Queue so the worker reads exactly ONE execution tab.
- CAS on col K (status), re-read to confirm claim, `attempts` (col M) bounds retries
  (MAX_ATTEMPTS dflt 3), `DRY_RUN=1` default ON writes `{"dry_run":true}` + `done`.
- `error` is human-retriable (super flips K→pending); worker never auto-retries error;
  `skipped` (e.g. CMA OTP) is terminal for the worker.

No corrections needed to §3 / CONTRACTS.md.

---

## 4. External-system provisioning contracts (SPEC §4)

### 4.1 Google Workspace - AdminDirectory advanced service - **BUILD FRESH** (Blocker B0)
No prior implementation exists (disk-wide grep = 0 hits outside docs). Standard pattern to
build:
- Enable **AdminDirectory** advanced service in `appsscript.json` (`enabledAdvancedServices`)
  AND in the Cloud console (Admin SDK API). The executing account must be a Workspace
  **super-admin** (or a delegated admin with User Management + Groups privileges) for
  `AdminDirectory.Users.insert` to succeed.
- Create: `AdminDirectory.Users.insert({ primaryEmail:'first@quay1.co.za'
  (fallback first.surname@ on 409 conflict), name:{givenName,familyName},
  password:'G{First}@002', changePasswordAtNextLogin:true })`. Then per group:
  `AdminDirectory.Members.insert({ email }, groupKey)`.
- Deactivate: `AdminDirectory.Users.update({ suspended:true }, userKey)` (idempotent),
  remove `Members`, transfer/revoke Drive (Drive share revocation is a separate DriveApp /
  Drive API step). Password/temp-pw goes in the induction email packet ONLY (never WhatsApp).
- There is a Google service-account key on disk at
  `virtual-agent-lookup/va-automation-497708-key.json` - that is for a DIFFERENT project
  (VA automation) and is NOT a Workspace admin credential; do NOT assume it authorizes
  Directory writes. Google provisioning should run as the Apps Script owner (a super-admin),
  not that key.

### 4.2 PropData REST - feeds-api.propdata.net - **dry-run only** (Blocker B2)
- No agent/user-provisioning implementation exists. The only PropData code on disk
  (`quay-automations/src/uploaders/propdata_browser.py`) is for **listing** uploads
  (browser, itself stubbed) - NOT user/agent seat creation, so it is NOT a reusable
  reference for this.
- Contract per SPEC/CONTRACTS: POST agent to feeds-api with `api_key` + `vendor id` headers.
  Creds are NOT provisioned (obtain by emailing `api-support@propdata.net`). Until then the
  propdata provisioner logs the payload it WOULD send and writes the queue row `done` with
  `{"dry_run":true}`. Runs INLINE in Apps Script (never a worker row).

### 4.3 Property24 / CMA / Dialfire - worker (browser), all `deactivate`+`create`
- **Property24**: no API; browser add/deactivate agent. Auto-links when the broker later logs
  in with the Quay1 Google account, but still create explicitly. Payload `{branch, google_linked}`.
- **CMA (cmainfo.co.za)**: OTP/2FA-gated (see the parked `cma-lookup` project). Worker
  provisioner is a STUB with a clean interface that returns `skipped` + a TODO note - never a
  fake success. (Blocker B3)
- **Dialfire**: user-management portal path UNCONFIRMED. Scaffold the provisioner, mark
  `NEEDS-PORTAL-MAP`; DOM capture can be done first via claude-in-chrome, production via
  Playwright. (Blocker B4)
- Worker host: the Mac, single process, like `virtual-agent-lookup` (which is the reference
  for Playwright + per-user `browser_profile_*` dirs + launchd `.plist` scheduling).

### 4.4 HubSpot seat - inline Apps Script, gated `HUBSPOT_SEAT_ENABLED` default OFF (Blocker B5)
Seat auto-create/release has licensing cost. Never a worker row.

---

## 5. Known blockers (surface, do not silently skip)

- **B0 (NEW, highest): Google/AdminDirectory has no existing implementation** - the SPEC's
  "DONE, verified" was inaccurate (now corrected). Must be built fresh + needs the
  AdminDirectory advanced service enabled and a super-admin authorizer. Cannot be live-tested
  from source review; build with `DRY_RUN` and hand to the user to arm.
- **B1: could not clone the live Quay 1 `1apqpQ…` script.** `npx clasp clone-script <id>`
  (clasp v3.3.0, login token present at `~/.clasprc.json`) returns **"Invalid script ID"**
  for `1apqpQfzCjPXeM0JLmIwCwUBpdnFv7t5Re9PUGfJ3eLv1mLN9CnUXvpii`. Likely a container-bound
  script id (not clonable by id) and/or the token is stale/lacks the Apps Script API scope.
  **Action for user:** run `clasp login` (as pagan@) with Apps Script API enabled, or paste
  the script id from the editor URL, so the backend agent can diff the real Code.js. The wire
  contract above is reconstructed from the frontend and is authoritative for request/response
  SHAPE, but the server-side field→tracker-column mapping and email copy are unverified.
- **B2: PropData creds not provisioned** → propdata inline provisioner dry-run only.
- **B3: CMA OTP/2FA** → cma worker provisioner is a `skipped` stub with a TODO.
- **B4: Dialfire portal path unconfirmed** → dialfire provisioner scaffolded, NEEDS-PORTAL-MAP.
- **B5: HubSpot seat licensing cost** → behind `HUBSPOT_SEAT_ENABLED`, default off.
- **Minor: Aqua email theme.** SPEC §5 describes an "Aqua gold" surface theme, but the live
  Aqua emails use the Quay navy+gold palette (`#3D5BA6/#2E477F/#FDC503`). Flag to ui so the
  Aqua toggle's styling is a deliberate decision, not an accidental mismatch with live mail.
- **Program→System mapping gap (§1.4):** Quay1's broker-facing `PROGRAM_OPTIONS`
  (cma/dialfire/whatsapp/training) are not 1:1 the lifecycle `SYSTEMS` enum. Architect must
  define the mapping (which toggles enqueue a provisioning row vs. are informational).

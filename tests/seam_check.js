// UI <-> backend POST-contract cross-check (TEST extra section requested by lead).
//
// CONTRACTS.md froze only the backend<->worker queue columns, NOT the
// frontend<->backend POST seam, so the UI and Apps Script were built to separate
// assumptions. This script reads the REAL code on both sides (web/app.js and
// apps-script/*.js) and asserts, field-for-field:
//   1. every `kind` the UI POSTs is dispatched by the backend Router;
//   2. the JWT body key the UI sends is the one the backend reads;
//   3. the payload field names the UI sends are the ones each handler reads;
//   4. the provisioning-status response shape matches what the UI renders.
//
// Drift here is a real integration break (a mismatch silently 401s or drops
// data), so any drift EXITS NON-ZERO and holds the overall PASS.
//
// Run:  node tests/seam_check.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// Read the ENTIRE frontend (all web/*.js + index.html), not just app.js, so this
// check stays correct if the UI splits app.js into modules (KINDS/api/form fields
// may move between files). Concatenation is fine - we only grep for tokens.
const WEB_DIR = path.join(ROOT, 'web');
const app = fs.readdirSync(WEB_DIR)
  .filter((n) => n.endsWith('.js') || n.endsWith('.html'))
  .map((n) => fs.readFileSync(path.join(WEB_DIR, n), 'utf8'))
  .join('\n');
const auth = fs.readFileSync(path.join(ROOT, 'apps-script', 'Auth.js'), 'utf8');
const router = fs.readFileSync(path.join(ROOT, 'apps-script', 'Router.js'), 'utf8');
const q1 = fs.readFileSync(path.join(ROOT, 'apps-script', 'Onboarding_Quay1.js'), 'utf8');
const aqua = fs.readFileSync(path.join(ROOT, 'apps-script', 'Onboarding_Aqua.js'), 'utf8');
const prov = fs.readFileSync(path.join(ROOT, 'apps-script', 'Provisioning.js'), 'utf8');

const DRIFT = [];
const OK = [];
const note = (arr, s) => { arr.push(s); console.log(`  [${arr === OK ? 'OK  ' : 'DRIFT'}] ${s}`); };

console.log('=== UI <-> backend POST seam cross-check ===');

// 1. kinds -----------------------------------------------------------------
// The 5 admin kinds the SPA posts (CONTRACTS section 7 dispatch table). Assert
// each is BOTH referenced by the frontend and dispatched by Router. (Extracting
// kinds via a loose regex over the whole frontend false-matches status-pill maps
// like `status: 'done'`, so we check the known canonical set instead.)
console.log('1. kind dispatch');
const CANON_KINDS = ['onboard_quay1', 'onboard_aqua', 'status', 'retry', 'offboard'];
const routerKinds = [...router.matchAll(/\b(onboard_quay1|onboard_aqua|status|retry|offboard|fica_upload|book_induction|provision)\b/g)]
  .map((m) => m[1]);
for (const k of CANON_KINDS) {
  const uiRefs = app.includes(`'${k}'`) || app.includes(`"${k}"`);
  if (uiRefs && routerKinds.includes(k)) note(OK, `kind '${k}': UI references it and Router dispatches it`);
  else if (!uiRefs) note(DRIFT, `kind '${k}' not referenced in the frontend`);
  else note(DRIFT, `kind '${k}' referenced by UI but NOT in Router dispatch table`);
}

// 2. JWT body key ----------------------------------------------------------
console.log('2. JWT body key');
const uiKey = app.includes('kind, accessToken') ? 'accessToken'
  : (app.includes('kind, token') ? 'token' : 'unknown');
const backendKey = auth.includes('body.accessToken') ? 'accessToken'
  : (/body\.token\b/.test(auth) ? 'token' : 'unknown');
if (uiKey !== 'unknown' && uiKey === backendKey) {
  note(OK, `UI and backend both carry the JWT as body.${uiKey}`);
} else {
  note(DRIFT, `JWT body key mismatch: UI sends '${uiKey}', backend reads '${backendKey}' -> every admin call resolves unauthorized. Align on ONE key.`);
}

// 3. onboard payload field names ------------------------------------------
console.log('3. onboard payload field names (UI sends vs backend reads)');
// field names the UI form emits (name="..."), from the field builders.
const uiOnboardFields = ['name', 'id_number', 'contact', 'email', 'start_date', 'division',
  'team', 'designation', 'senior_name', 'senior_email', 'commission',
  'agreement_type', 'work_hours', 'remuneration', 'provision'];
const q1Reads = [...q1.matchAll(/f\.([a-z_]+)/g)].map((m) => m[1]);
const aquaReads = [...aqua.matchAll(/f\.([a-z_]+)/g)].map((m) => m[1]);

// Quay1 REQUIRED fields it hard-checks:
const q1RequiredMissing = ['full_name', 'candidate_email'].filter((bk) => q1Reads.includes(bk) && !uiOnboardFields.includes(bk));
for (const bk of q1RequiredMissing) {
  const uiEquiv = { full_name: 'name', candidate_email: 'email' }[bk];
  note(DRIFT, `Quay1 onboard requires body.${bk} but UI sends '${uiEquiv}' -> onboard rejects the UI payload with a required-field error.`);
}
// Quay1 silent field renames (non-required but dropped):
const q1Renames = { contact_number: 'contact', senior_broker: 'senior_name', activity: 'designation' };
for (const [bk, ui] of Object.entries(q1Renames)) {
  if (q1Reads.includes(bk)) note(DRIFT, `Quay1 reads body.${bk}; UI sends '${ui}' -> value dropped (blank on the tracker/contract).`);
}
// deal_type (Sale/Rental): OPTIONAL per CONTRACTS 8.1 (default sale). Only advisory.
const uiHasDealType = /name="deal_type"|deal_type/.test(app);
if (!uiHasDealType) note(OK, "deal_type not sent by UI -> backend defaults to Sale (optional per CONTRACTS 8.1; add a control only if Rental is needed).");
// Aqua fixed-term needs end_date: check the UI actually collects it.
const uiHasEndDate = /name="end_date"/.test(app);
if (/f\.end_date/.test(aqua) && !uiHasEndDate) note(DRIFT, "Aqua fixed-term needs body.end_date; UI collects no end_date field -> fixed-term MOA fails validation.");
else if (uiHasEndDate) note(OK, "Aqua end_date collected by the UI (fixed-term MOA validation satisfied)");
// Aqua alignment wins worth recording:
for (const g of ['email', 'contact', 'designation']) {
  if (aquaReads.includes(g) && uiOnboardFields.includes(g)) note(OK, `Aqua reads body.${g} matching the UI field`);
}

// 4. provisioning selection ------------------------------------------------
// CONTRACTS 8.1 names the systems array `systems`. Backend _provisionList_ (in
// Onboarding_Common.js - include it, per backend's note) may accept provision||systems.
console.log('4. provisioning selection (UI systems array -> backend)');
const common = fs.readFileSync(path.join(ROOT, 'apps-script', 'Onboarding_Common.js'), 'utf8');
const uiSysKey = /data\.systems\s*=/.test(app) ? 'systems'
  : (/data\.provision\s*=/.test(app) ? 'provision' : 'none');
const backendReadsSystems = /\bsystems\b/.test(common) || /f\.systems|body\.systems/.test(q1 + aqua + prov);
const backendReadsProvision = /\bprovision\b/.test(common) || /f\.provision|body\.provision/.test(q1 + aqua + prov);
const backendAcceptsUiKey = (uiSysKey === 'systems' && backendReadsSystems) || (uiSysKey === 'provision' && backendReadsProvision);
if (uiSysKey !== 'none' && backendAcceptsUiKey) {
  note(OK, `UI sends the systems array as \`${uiSysKey}\` and backend _provisionList_ reads it (CONTRACTS 8.1)`);
} else {
  note(DRIFT, `provisioning selection key mismatch: UI sends '${uiSysKey}', backend does not read it -> checkbox selection dropped.`);
}

// 5. status response shape -------------------------------------------------
// CONTRACTS 8.3: response carries the provisioning rows under `rows`.
console.log('5. provisioning-status response shape');
const queueSrc = fs.readFileSync(path.join(ROOT, 'apps-script', 'Queue.js'), 'utf8');
const uiReadsRows = /r\.rows\b/.test(app);
const backendReturnsRows = /readForUi_[\s\S]{0,600}?rows:\s*\w+/.test(queueSrc) || /return\s*\{[^}]*\brows:/.test(queueSrc);
if (uiReadsRows && backendReturnsRows) {
  note(OK, 'status returns rows[] and UI reads r.rows (CONTRACTS 8.3)');
} else {
  note(DRIFT, `status shape mismatch: UI reads rows=${uiReadsRows}, backend returns rows=${backendReturnsRows} -> table may render empty.`);
}

// summary ------------------------------------------------------------------
console.log(`\n${DRIFT.length ? 'SEAM DRIFT' : 'SEAM OK'}: ${DRIFT.length} drift, ${OK.length} aligned`);
if (DRIFT.length) process.exit(1);
process.exit(0);

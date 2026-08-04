/**
 * Tracker.js - the Onboarding tracker tab data layer (NOT a queue; the two queue tabs live in
 * Queue.js). Owns the Onboarding column map and every read/write of it. Shared by
 * Onboarding_Quay1, Onboarding_Aqua, Fica, Induction and Provisioning.
 *
 * This file is an addition to the architect's stub set (flagged to tester + architect): the
 * Onboarding tab needed a single owner the same way the queue tabs have Queue.js. It sits at
 * the data-layer level (called DOWN into by the flow modules), imports only Config + Util.
 *
 * Column layout (1-indexed sheet columns). SPEC 3.1 anchors the FICA ticks at R..V, so the 17
 * identity/contract fields fill A..Q, FICA ticks fill R..V, then programs/induction/status and
 * the hidden folderId key. Keyed (upsert) on folderId (col AA, hidden).
 *
 * FICA tick letters follow the team lead's reconciled Quay1 mapping (against the live 1apqp...
 * tracker, pending clasp reconciliation): R=NDA (set manually, not by the self-service form),
 * S=POB bank confirmation, T=POA, U=ID, V=CONTRACT signed agreement. These four auto-tickable
 * cells (S/T/U/V) match the live `progress` doc flags {bankConf, poa, idRcv, agreement}
 * (RESEARCH 1.5). Tax copies are stored as files but NOT a tick column (RESEARCH 1.5).
 *
 *   A entity  B name  C id_number  D email  E contact  F start_date  G senior_name
 *   H senior_email  I requester_name  J requester_email  K designation  L team  M division
 *   N agreement_type  O work_hours  P remuneration  Q commission
 *   R fica_nda  S fica_bank  T fica_poa  U fica_id  V fica_contract          (FICA ticks R..V)
 *   W programs(JSON)  X induction_wed  Y induction_thu  Z status  AA folderId(hidden key)
 *   AB ffc_status  AC ffc_number  AD propdata_profile_type  AE specialist_ref   (FFC / PropData, appended after the key so column numbers above never shift)
 *   AF systems_json  AG provisioned_at   (deferred provisioning: the systems resolved at onboard, and the batch's done-marker; provisioning no longer runs at onboard - see provisionReadyBatch_)
 *
 * Public surface:
 *   ONB_COL / ONB_HEADERS / FICA_COL            - the frozen column map + FICA doc-key->col.
 *   ensureOnboardingTab_(sh)                    - create/repair headers, hide the key column.
 *   upsertOnboardingRow_(data)                  - {row, isNew}  insert/update by folderId.
 *   findOnboardingRow_(folderId)                - Number   sheet row, or 0 if not present.
 *   readOnboardingByFolder_(folderId)           - Object|null  the row as a field object.
 *   setOnboardingCell_(folderId, colNum, val)   - void   write one cell as text.
 *   tickFica_(folderId, docKey, val)            - void   set the R..V cell for a doc key.
 *   setInduction_(folderId, wed, thu)           - void   set X/Y.
 *   setOnboardingStatus_(folderId, status)      - void   set Z.
 *   listOnboarding_(filterFn)                   - Array<Object>  rows (optionally filtered).
 */

var ONB_COL = {
  entity: 1, name: 2, id_number: 3, email: 4, contact: 5, start_date: 6, senior_name: 7,
  senior_email: 8, requester_name: 9, requester_email: 10, designation: 11, team: 12,
  division: 13, agreement_type: 14, work_hours: 15, remuneration: 16, commission: 17,
  fica_nda: 18, fica_bank: 19, fica_poa: 20, fica_id: 21, fica_contract: 22,
  programs: 23, induction_wed: 24, induction_thu: 25, status: 26, folderId: 27,
  // Appended AFTER the folderId key (28..31) so no existing column number shifts. FFC = Fidelity
  // Fund Certificate status the candidate self-declares on FICA; propdata_profile_type is derived
  // from it (full -> agent, candidate/none -> specialist). specialist_ref is filled later when the
  // numbered PropData specialist profile is actually created (not at intake).
  ffc_status: 28, ffc_number: 29, propdata_profile_type: 30, specialist_ref: 31,
  // Deferred provisioning (appended, no shift): systems_json = the systems resolved at onboard time
  // (operator ticks + entitlements), provisioned_at = the provisioning idempotency marker.
  systems_json: 32, provisioned_at: 33,
  // Human approval gate (appended, no shift): an admin reviews the signed contract + FICA docs and
  // clicks "Approve & set up". approved_at/approved_by are the ONLY thing that unlocks provisioning -
  // accounts are never created before this deliberate sign-off. See _approveDispatch_ / _provisionReady_.
  approved_at: 34, approved_by: 35,
  // Last time a "Send reminder" follow-up went out, so the UI can show it + guard against spamming.
  reminded_at: 36,
};

var ONB_HEADERS = [
  'Entity', 'Name', 'ID number', 'Email', 'Contact', 'Start date', 'Senior name',
  'Senior email', 'Requester name', 'Requester email', 'Designation', 'Team', 'Division',
  'Agreement type', 'Work hours', 'Remuneration', 'Commission',
  'FICA NDA', 'FICA bank', 'FICA POA', 'FICA ID', 'FICA contract',
  'Programs', 'Induction Wed', 'Induction Thu', 'Status', 'Folder ID (key)',
  'FFC status', 'FFC number', 'PropData profile', 'Specialist ref',
  'Systems (resolved)', 'Provisioned at', 'Approved at', 'Approved by', 'Reminded at',
];

/** FICA doc key -> the R..V column that records "received". `nda` (R) is set manually, not by
 *  the self-service form. Tax is stored as a file but has no tick column (RESEARCH 1.5). */
var FICA_COL = {
  nda: ONB_COL.fica_nda,
  bank: ONB_COL.fica_bank,
  poa: ONB_COL.fica_poa,
  id: ONB_COL.fica_id,
  contract: ONB_COL.fica_contract,
};

var ONB_WIDTH = ONB_HEADERS.length; // derived from the header list above

/** Ensure the Onboarding tab exists with a header row and the key column hidden. */
function ensureOnboardingTab_(sh) {
  sh.getRange(1, 1, 1, ONB_WIDTH).setValues([ONB_HEADERS]).setFontWeight('bold');
  sh.setFrozenRows(1);
  try { sh.hideColumns(ONB_COL.folderId); } catch (e) { /* already hidden */ }
}

function _onbTab_() { return tab_(CFG.TAB.ONBOARDING); }

/** Write a single cell as text (preserves ID / leading-zero integrity). */
function _putOnb_(sh, row, col, val) {
  sh.getRange(row, col).setNumberFormat('@').setValue(String(val == null ? '' : val));
}

/** Sheet row for a folderId, or 0 when absent. */
function findOnboardingRow_(folderId) {
  var sh = _onbTab_();
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var keys = sh.getRange(2, ONB_COL.folderId, last - 1, 1).getValues();
  for (var i = 0; i < keys.length; i++) {
    if (String(keys[i][0]) === String(folderId)) return i + 2;
  }
  return 0;
}

/**
 * Insert or update the Onboarding row keyed on data.folderId. Only the fields present on
 * `data` (matching ONB_COL keys) are written; omitted fields are left untouched. Returns
 * { row, isNew }. Guarded by a document lock so concurrent doPosts do not interleave.
 */
function upsertOnboardingRow_(data) {
  if (!data || !data.folderId) throw new Error('upsertOnboardingRow_ needs data.folderId');
  var lock = LockService.getDocumentLock();
  lock.waitLock(20000);
  try {
    var sh = _onbTab_();
    var row = findOnboardingRow_(data.folderId);
    var isNew = !row;
    if (isNew) {
      row = Math.max(sh.getLastRow() + 1, 2);
      _putOnb_(sh, row, ONB_COL.folderId, data.folderId);
      if (!data.status) _putOnb_(sh, row, ONB_COL.status, 'Onboarding');
    }
    Object.keys(ONB_COL).forEach(function (k) {
      if (k === 'folderId') return;
      if (data[k] == null) return;
      var v = data[k];
      if (k === 'programs' && typeof v !== 'string') v = JSON.stringify(v);
      _putOnb_(sh, row, ONB_COL[k], v);
    });
    return { row: row, isNew: isNew };
  } finally {
    lock.releaseLock();
  }
}

/** The Onboarding row for a folderId as a plain field object, or null. */
function readOnboardingByFolder_(folderId) {
  var sh = _onbTab_();
  var row = findOnboardingRow_(folderId);
  if (!row) return null;
  var vals = sh.getRange(row, 1, 1, ONB_WIDTH).getValues()[0];
  var out = {};
  Object.keys(ONB_COL).forEach(function (k) { out[k] = String(vals[ONB_COL[k] - 1] || ''); });
  return out;
}

/** Write one cell (by column number) as text. */
function setOnboardingCell_(folderId, colNum, val) {
  var sh = _onbTab_();
  var row = findOnboardingRow_(folderId);
  if (!row) throw new Error('onboarding row not found for folderId');
  _putOnb_(sh, row, colNum, val);
}

/** Mark a FICA doc received. `val` defaults to a dated "Received <iso>". */
function tickFica_(folderId, docKey, val) {
  var col = FICA_COL[docKey];
  if (!col) throw new Error('unknown FICA doc key: ' + docKey);
  setOnboardingCell_(folderId, col, val || ('Received ' + nowIso_()));
}

function setInduction_(folderId, wed, thu) {
  var sh = _onbTab_();
  var row = findOnboardingRow_(folderId);
  if (!row) throw new Error('onboarding row not found for folderId');
  if (wed != null) _putOnb_(sh, row, ONB_COL.induction_wed, wed);
  if (thu != null) _putOnb_(sh, row, ONB_COL.induction_thu, thu);
}

function setOnboardingStatus_(folderId, status) {
  setOnboardingCell_(folderId, ONB_COL.status, status);
}

/** All onboarding rows as field objects (optionally filtered by a predicate). */
function listOnboarding_(filterFn) {
  var sh = _onbTab_();
  var last = sh.getLastRow();
  if (last < 2) return [];
  var vals = sh.getRange(2, 1, last - 1, ONB_WIDTH).getValues();
  var out = [];
  vals.forEach(function (r) {
    if (!r[ONB_COL.folderId - 1] && !r[ONB_COL.name - 1]) return;
    var o = {};
    Object.keys(ONB_COL).forEach(function (k) { o[k] = String(r[ONB_COL[k] - 1] || ''); });
    if (!filterFn || filterFn(o)) out.push(o);
  });
  return out;
}

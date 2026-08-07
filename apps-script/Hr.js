/**
 * Hr.js - mirror onboarding rows into the company "Quay 1 - HR Information Sheet" (18fBKK..., owned
 * by lieze@). This replaces the old aqua-contracts _hrAdd_ append with a two-stage flow the team
 * asked for:
 *
 *   1. TRACKING  - on contract creation, a row is upserted (keyed on ID number) into the shared
 *      "New Starters (Tracking)" tab with whatever is known so far. As FICA data lands, the same
 *      row is updated in place (upsert), so HR can watch a starter fill in.
 *   2. PROMOTE   - once FICA is complete, the finished row is COPIED (append-only) into the entity
 *      destination tab - "New Brokers (Automated)" for Quay 1, "New Aqua (Automated)" for Aqua -
 *      and the tracking row is marked "Moved". Promotion is idempotent (guarded by hr_promoted_at):
 *      it never double-appends. It is non-destructive on the live sheet: the tracking row is marked,
 *      not deleted.
 *
 * Column layout mirrors the sheet's existing "IGSICA EMPLOYEES" / "New Brokers (Automated)" tabs
 * verbatim (HR_HEADERS below), so a promoted row drops straight into HR's normal columns. The Aqua
 * and tracking tabs are auto-created from this same layout if they do not exist yet.
 *
 * SAFETY: every write is gated by the HR_SYNC_ENABLED flag (hrSyncEnabled_), INDEPENDENT of DRY_RUN
 * so HR mirroring can be validated / armed on its own without also arming Google/PropData account
 * creation. Default OFF: nothing is written to the live HR sheet - the intended action is logged via
 * logAudit_ and the function returns { dryRun:true }. All entry points are wrapped by callers in
 * try/catch so an HR-sync failure never breaks onboarding.
 *
 * Public surface:
 *   hrTrackingUpsert_(folderId)   - upsert this candidate's row into "New Starters (Tracking)".
 *   hrPromote_(folderId)          - copy a FICA-complete row into the entity destination tab (once).
 *   saIdBirthday_(idNumber)       - 'YYYY-MM-DD' birthday decoded from a 13-digit SA ID, or ''.
 *   isSaId_(idNumber)             - true for a 13-digit all-numeric SA ID.
 */

/** The HR sheet id: a Script Property override, else the known company sheet. Not a secret. */
function hrSheetId_() {
  return optProp_(PROP.HR_SHEET_ID) || '18fBKKsuKJSKKshJ47RHGC44eB_7vRADSy0nzS6Y6DyE';
}

/** Destination tab per entity + the shared staging tab. Match the live sheet's tab names exactly. */
var HR_TAB = {
  quay1: 'New Brokers (Automated)',
  aqua: 'New Aqua (Automated)',
  tracking: 'New Starters (Tracking)',
};

/** The canonical column layout, verbatim from the live "New Brokers (Automated)" / "IGSICA
 *  EMPLOYEES" tabs. Auto-created Aqua + tracking tabs get this exact header row so every automated
 *  tab lines up column-for-column. Column N of this array = column N+1 on the sheet. */
var HR_HEADERS = [
  'Name & Surname', 'Start Date', 'End/Current Date', 'Identification Number', 'Nationality',
  'Email Address', 'Contact Number', 'Birthday', 'Bank', 'Account Number', 'Type of account',
  'Income Tax Number', 'Residential Address', 'Designation', 'Senior Broker', 'ID/Passport Copy',
  'Work Permit Expiry', 'Non Disclosure Signed', 'Bank Confirmation', 'Proof Of Address',
  'ID Received', 'Agreement Received', 'Ryan Greeff Signed', 'Welcome Email Sent',
  'Calender Check: BIRTHDAY', 'Calender Check: WORK ANNIVERSARY', 'Next of Kin Name',
  'Next of Kin Contact Number', 'Next of Kin Relationship', 'Next of Kin Email',
  'FFC CERTIFICATE NUMBER', 'Team working',
];

/** The tracking tab carries one extra trailing status column so HR can see promotion state without
 *  it colliding with the frozen destination layout. */
var HR_TRACKING_STATUS_HEADER = 'Tracking status';

// ---------------------------------------------------------------- public entry points

/** Upsert the candidate's HR row into the shared tracking tab (keyed on ID number). Called on
 *  contract creation and again as FICA data arrives. DRY_RUN-safe; caller wraps in try/catch. */
function hrTrackingUpsert_(folderId) {
  var o = readOnboardingByFolder_(folderId);
  if (!o) return { ok: false, error: 'onboarding row not found' };
  var row = _hrBuildRow_(o);

  if (!hrSyncEnabled_()) {
    logAudit_('hr_tracking_dryrun', { folderId: folderId, name: o.name, id: o.id_number });
    return { ok: true, dryRun: true, would: 'upsert tracking row for ' + (o.name || o.id_number) };
  }

  var ss = SpreadsheetApp.openById(hrSheetId_());
  var sh = _hrEnsureTab_(ss, HR_TAB.tracking, true);
  var keyCol = HR_HEADERS.indexOf('Identification Number') + 1; // column 4
  var target = _hrFindRowByKey_(sh, keyCol, o.id_number);
  if (!target) target = Math.max(sh.getLastRow() + 1, 2);
  sh.getRange(target, 1, 1, HR_HEADERS.length).setNumberFormat('@').setValues([row]);

  try { setOnboardingCell_(folderId, ONB_COL.hr_tracking_at, nowIso_()); } catch (e) { /* non-fatal */ }
  return { ok: true, row: target };
}

/** Copy a FICA-complete row into the entity destination tab (append-only, once). Idempotent via
 *  hr_promoted_at. Marks the tracking row "Moved <date>" (non-destructive). DRY_RUN-safe. */
function hrPromote_(folderId) {
  var o = readOnboardingByFolder_(folderId);
  if (!o) return { ok: false, error: 'onboarding row not found' };
  if (o.hr_promoted_at) return { ok: true, skipped: 'already promoted' };

  var entity = (o.entity === 'aqua') ? 'aqua' : 'quay1';
  var destName = HR_TAB[entity];
  var row = _hrBuildRow_(o);

  if (!hrSyncEnabled_()) {
    logAudit_('hr_promote_dryrun', { folderId: folderId, name: o.name, entity: entity, dest: destName });
    return { ok: true, dryRun: true, would: 'append ' + (o.name || o.id_number) + ' to "' + destName + '"' };
  }

  var ss = SpreadsheetApp.openById(hrSheetId_());
  var dest = _hrEnsureTab_(ss, destName, true);
  var keyCol = HR_HEADERS.indexOf('Identification Number') + 1; // column 4
  // Idempotent against the LIVE sheet, not just the hr_promoted_at marker: if a prior run appended
  // this person but its marker write failed, re-running must NOT duplicate the destination row.
  var existing = _hrFindRowByKey_(dest, keyCol, o.id_number);
  var target = existing || Math.max(dest.getLastRow() + 1, 2);
  dest.getRange(target, 1, 1, HR_HEADERS.length).setNumberFormat('@').setValues([row]);

  // Mark the tracking row as moved (non-destructive) so HR sees it left the staging list.
  try {
    var track = _hrEnsureTab_(ss, HR_TAB.tracking, false);
    if (track) {
      var keyCol = HR_HEADERS.indexOf('Identification Number') + 1;
      var trow = _hrFindRowByKey_(track, keyCol, o.id_number);
      if (trow) {
        track.getRange(trow, HR_HEADERS.length + 1)
          .setNumberFormat('@').setValue('Moved to ' + destName + ' ' + fmtDate_(nowIso_()));
      }
    }
  } catch (e) { logAudit_('hr_tracking_mark_failed', { folderId: folderId, error: String(e) }); }

  // Log loudly if the idempotency marker fails to write - the append already landed, so a silent
  // failure here is the one thing that could let a retry re-touch the destination row.
  try { setOnboardingCell_(folderId, ONB_COL.hr_promoted_at, nowIso_()); }
  catch (e) { logAudit_('hr_promoted_marker_failed', { folderId: folderId, error: String(e) }); }
  logAudit_('hr_promoted', { folderId: folderId, name: o.name, entity: entity, dest: destName });
  return { ok: true, row: target, dest: destName };
}

// ---------------------------------------------------------------- row builder

/** Build the HR_HEADERS-ordered values array from an onboarding field object. Doc ticks in the
 *  boarding tracker are non-empty strings ("Received <iso>") when a doc is in, so a truthy check =
 *  received. Formula/manual HR columns (cal-checks, Ryan Greeff, welcome email) are left blank for
 *  HR to fill or for the sheet's own formulas. */
function _hrBuildRow_(o) {
  var received = function (v) { return String(v || '').trim() ? 'TRUE' : ''; };
  var sa = isSaId_(o.id_number);
  var nationality = String(o.nationality || '').trim() || (sa ? 'South African' : '');
  var birthday = String(o.birthday || '').trim() || (sa ? saIdBirthday_(o.id_number) : '');
  // A South African needs no work permit; show N/A to match the sheet's existing convention.
  var permit = String(o.work_permit_expiry || '').trim() || (sa ? 'N/A' : '');

  var map = {
    'Name & Surname': o.name,
    'Start Date': o.start_date,
    'End/Current Date': 'Current',
    'Identification Number': o.id_number,
    'Nationality': nationality,
    'Email Address': o.email,
    'Contact Number': o.contact,
    'Birthday': birthday,
    'Bank': o.bank_name,
    'Account Number': o.account_number,
    'Type of account': o.account_type,
    'Income Tax Number': o.tax_number,
    'Residential Address': o.residential_address,
    'Designation': o.designation,
    'Senior Broker': o.senior_name,
    'ID/Passport Copy': String(o.fica_id || '').trim() ? 'ID' : '',
    'Work Permit Expiry': permit,
    'Non Disclosure Signed': received(o.fica_nda),
    'Bank Confirmation': received(o.fica_bank),
    'Proof Of Address': received(o.fica_poa),
    'ID Received': received(o.fica_id),
    'Agreement Received': received(o.fica_contract),
    'Ryan Greeff Signed': '',
    'Welcome Email Sent': '',
    'Calender Check: BIRTHDAY': '',
    'Calender Check: WORK ANNIVERSARY': '',
    'Next of Kin Name': o.nok_name,
    'Next of Kin Contact Number': o.nok_contact,
    'Next of Kin Relationship': o.nok_relationship,
    'Next of Kin Email': o.nok_email,
    'FFC CERTIFICATE NUMBER': o.ffc_number,
    'Team working': o.team,
  };
  return HR_HEADERS.map(function (h) { var v = map[h]; return v == null ? '' : String(v); });
}

// ---------------------------------------------------------------- tab + row helpers

/** Get a tab by name; create it (with the HR_HEADERS header row, + the tracking status column for
 *  the tracking tab) when missing and `createIfMissing`. Returns null if absent and not creating. */
function _hrEnsureTab_(ss, name, createIfMissing) {
  var sh = ss.getSheetByName(name);
  if (sh) return sh;
  if (!createIfMissing) return null;
  sh = ss.insertSheet(name);
  var headers = HR_HEADERS.slice();
  if (name === HR_TAB.tracking) headers.push(HR_TRACKING_STATUS_HEADER);
  sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  sh.setFrozenRows(1);
  return sh;
}

/** Row number whose `keyCol` equals `key` (as text), or 0. Skips the header row. */
function _hrFindRowByKey_(sh, keyCol, key) {
  var k = String(key || '').trim();
  if (!k) return 0;
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var vals = sh.getRange(2, keyCol, last - 1, 1).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][0]).trim() === k) return i + 2;
  }
  return 0;
}

// ---------------------------------------------------------------- SA ID helpers

/** True for a 13-digit, all-numeric South African ID number. */
function isSaId_(idNumber) {
  return /^\d{13}$/.test(String(idNumber || '').trim());
}

/** Decode the birthday ('YYYY-MM-DD') from a 13-digit SA ID (YYMMDD prefix). '' if not an SA ID or
 *  the date is impossible. Century pivot: YY <= current 2-digit year -> 2000s, else 1900s. */
function saIdBirthday_(idNumber) {
  var id = String(idNumber || '').trim();
  if (!isSaId_(id)) return '';
  var yy = parseInt(id.substr(0, 2), 10);
  var mm = parseInt(id.substr(2, 2), 10);
  var dd = parseInt(id.substr(4, 2), 10);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return '';
  var pivot = new Date().getFullYear() % 100;
  var year = (yy <= pivot) ? 2000 + yy : 1900 + yy;
  var d = new Date(year, mm - 1, dd);
  if (d.getFullYear() !== year || d.getMonth() !== mm - 1 || d.getDate() !== dd) return '';
  var p = function (n) { return (n < 10 ? '0' : '') + n; };
  return year + '-' + p(mm) + '-' + p(dd);
}

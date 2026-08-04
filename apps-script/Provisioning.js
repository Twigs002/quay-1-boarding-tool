/**
 * Provisioning.js - account creation. Google Workspace + PropData are API-based and run INLINE
 * here, written to the Provisioning Queue as done/error for audit. Property24, CMA and Dialfire
 * have no usable API, so this module ENQUEUES pending rows for the Python worker.
 *
 * Owner: backend. See docs/SPEC.md section 4 and docs/CONTRACTS.md section 1.
 *
 * BLOCKER B0 (RESEARCH 0 + 4.1): Google/AdminDirectory has NO prior implementation. Built fresh
 * as an AdminDirectory advanced service (enabled in appsscript.json + Cloud console Admin SDK).
 * The Apps Script owner must be a Workspace super-admin for inserts to succeed. Cannot be
 * live-tested from here; ships behind DRY_RUN. The va-automation key on disk is a DIFFERENT
 * project and does NOT authorize Directory writes.
 *
 * Google is the linchpin: created FIRST so quay_email is available to later rows. Property24
 * auto-links on Google login but we still enqueue an explicit create.
 *
 * Public surface:
 *   resolveSystems_(entity, programs, explicit, team, activity) - [system...]  core + mapped programs + team map, then the entitlements matrix strips systems the broker role may not hold.
 *   provisionAll_(folderId, systems, ctx)       - {ok, results:{system:status}}  auth enforced at call site.
 *   provisionReadyBatch_()                      - {provisioned,...}  SCHEDULED Wed 08:00: provision every row whose signed contract + FICA are in (nothing is created at onboard time).
 *   googleCreate_(person)        - {email, tempPw, dryRun?}  Users.insert + Members.insert.
 *   googleSuspend_(email)        - {ok, ...}  Users.update {suspended:true}. Suspend only (user choice).
 *   recordCredential_(entry)     - void  upsert the created email + temp password into the private
 *                                  'Google Credentials' tab (superuser-readable). Live path only.
 *   propdataCreate_(person) / propdataDeactivate_(person) - {ok, dryRun?}  feeds-api REST.
 *   enqueueBrowserSystems_(person, systems, action) - [queue_id...]  pending worker rows.
 *
 * DRY_RUN_() default true: inline provisioners log the payload they WOULD send and write a done
 * row with {"dry_run":true}. No live mutation until armed.
 */

/** Resolve the systems to provision. An explicit list (the form's ticked systems) is the base
 *  selection; when none is given we fall back to the entity core set plus any systems mapped from
 *  ticked programs. On TOP of either, the team's Team-Directory Systems are ALWAYS unioned in as a
 *  baseline (Blocker B.3) - a team configured to always need a system gets it even when the
 *  operator's explicit ticks omit it. Filtered to the SYSTEMS enum; hubspot excluded here (seat
 *  create is a separate flag-gated concern). `team` is optional - behaviour is unchanged when the
 *  team has no mapped systems (the default until the Systems column is filled). */
function resolveSystems_(entity, programs, explicit, team, activity) {
  var set = {};
  var add = function (s) {
    s = String(s || '').toLowerCase();
    if (CFG.SYSTEMS.indexOf(s) >= 0 && s !== 'hubspot') set[s] = true;
  };
  if (explicit && explicit.length) {
    explicit.forEach(add);
  } else {
    (CFG.CORE_SYSTEMS[entity] || []).forEach(add);
    _programCodes_(programs).forEach(function (code) {
      var sys = CFG.PROGRAM_SYSTEM[code];
      if (sys) add(sys);
    });
  }
  // Team-configured systems are a baseline that applies in BOTH branches (see docstring).
  if (team) teamMapping_(team).systems.forEach(add);
  // Entitlements matrix has the FINAL say: strip systems this broker role may not hold, even when
  // explicitly ticked or team-mapped (e.g. a JB assistant never gets Property24/CMA). See Config.
  return entitlementFilter_(Object.keys(set), activity);
}

/** Extract the broker role token ('sb' full Broker | 'jb' Assistant) from a broker-activity value.
 *  Handles BOTH the code form (sell_res_jb) and the human label form ("... (JB)"). '' if unknown. */
function brokerRole_(activity) {
  var s = String(activity == null ? '' : activity).toLowerCase();
  if (/_jb\b/.test(s) || /\(jb\)/.test(s)) return 'jb';
  if (/_sb\b/.test(s) || /\(sb\)/.test(s)) return 'sb';
  return '';
}

/** Apply the entitlements matrix: remove any system barred for this broker role. Logs what it
 *  strips (audit trail) so a missing Property24/CMA on a JB is explained, not silent. */
function entitlementFilter_(systems, activity) {
  var role = brokerRole_(activity);
  var barred = (role && CFG.ENTITLEMENTS_BARRED[role]) || [];
  if (!barred.length) return systems.slice();
  var removed = [];
  var kept = systems.filter(function (s) {
    if (barred.indexOf(s) >= 0) { removed.push(s); return false; }
    return true;
  });
  if (removed.length) logAudit_('entitlement_barred', { role: role, activity: activity, removed: removed });
  return kept;
}

/** Normalise programs (array of {code} / strings / comma string) to lower-case code strings. */
function _programCodes_(programs) {
  var arr = Array.isArray(programs) ? programs
    : (typeof programs === 'string' ? safeJsonParse_(programs, []) : []);
  if (!Array.isArray(arr)) arr = [];
  return arr.map(function (p) {
    return String((p && p.code != null) ? p.code : p).trim().toLowerCase();
  }).filter(Boolean);
}

/** Load the person fields provisioning needs from the Onboarding row. */
function _personFor_(folderId) {
  var o = readOnboardingByFolder_(folderId) || {};
  return {
    folderId: folderId,
    full_name: o.name || '',
    first_name: firstName_(o.name || ''),
    last_name: lastName_(o.name || ''),
    id_number: o.id_number || '',
    cell: o.contact || '',
    email: o.email || '',
    team: o.team || '',
    designation: o.designation || '',
    // FFC intake fields -> PropData profile type (agent|specialist). profile_type is persisted at
    // FICA time; ffc_status is kept as a fallback so the role still derives if it was not.
    ffc_status: o.ffc_status || '',
    propdata_profile_type: o.propdata_profile_type || '',
    quay_email: '',
  };
}

/** The PropData role for a person: the FICA-persisted profile type, else derived from FFC status.
 *  Unknown/empty FFC -> 'specialist' (the conservative numbered profile) - the full agent profile is
 *  only granted once a 'full' FFC is declared at FICA, which happens AFTER onboard-time provisioning.
 *  PropData creation is B2-blocked + dry-run, so a pre-FICA placeholder never becomes a real profile. */
function _propdataRole_(person) {
  return person.propdata_profile_type || propdataProfileType_(person.ffc_status);
}

/**
 * Orchestrate provisioning for one person: Google first (inline), then PropData (inline), then
 * enqueue the browser systems for the worker. Returns { ok, results:{system:status} }.
 */
// NOTE: auth is enforced at the CALL SITE, not here. provisionAll_ runs from two paths:
//   - the scheduled provisionReadyBatch_ (Wednesday 08:00), which provisions a row ONLY once its
//     signed contract + FICA docs are in - NOTHING is created at onboard time anymore;
//   - the standalone 'provision' kind (_provisionDispatch_), which asserts requireAdmin_.
// ctx is passed through for downstream audit/identity use.
function provisionAll_(folderId, systems, ctx) {
  var person = _personFor_(folderId);
  var results = {};

  if (systems.indexOf('google') >= 0) {
    var g = _runInline_(person, 'google', function () { return googleCreate_(person); });
    results.google = g.status;
    if (g.result && g.result.email) person.quay_email = g.result.email;
  }

  if (systems.indexOf('propdata') >= 0) {
    var p = _runInline_(person, 'propdata', function () { return propdataCreate_(person); });
    results.propdata = p.status;
  }

  var browser = systems.filter(function (s) { return CFG.WORKER_SYSTEMS.indexOf(s) >= 0; });
  enqueueBrowserSystems_(person, browser, 'create');
  browser.forEach(function (s) { results[s] = 'pending'; });

  return { ok: true, results: results };
}

// ---------------------------------------------------------------- deferred provisioning batch

/** Docs are in when the signed contract AND the three FICA docs (ID, proof of address, bank) are
 *  all uploaded. NDA (R) is a manual internal doc and does NOT gate provisioning (user decision).
 *  Docs-in is NECESSARY but NOT sufficient - an admin must still approve (see _provisionReady_). */
function _docsReady_(o) {
  return !!(o && o.fica_contract && o.fica_id && o.fica_poa && o.fica_bank);
}

/** Ready to provision = docs are in AND an admin has clicked "Approve & set up" (approved_at stamped).
 *  This is the ONE guard between an onboarded candidate and real account creation. A wrong-but-signed
 *  contract still cannot mint accounts until a human has reviewed and approved it. */
function _provisionReady_(o) {
  return !!(o && _docsReady_(o) && o.approved_at);
}

/**
 * SCHEDULED BATCH (Wednesday 08:00, installed by setupTriggers). Nothing is created at onboard time;
 * this is where accounts are actually provisioned - and ONLY for a row that is _provisionReady_ (a
 * signed contract + full FICA) and not already provisioned (provisioned_at empty). Idempotent: the
 * provisioned_at marker + the queue's own dedup mean a re-run never double-provisions. Uses the
 * systems resolved + persisted at onboard (systems_json); falls back to re-resolving if absent.
 * Google/DRY_RUN gating still applies inside googleCreate_ - an unarmed batch is a safe dry-run.
 */
function provisionReadyBatch_() {
  var ctx = { email: 'batch@' + CFG.DOMAIN, role: 'system', name: 'Provisioning batch' };
  var out = { provisioned: [], not_ready: 0, already: 0, errors: [] };
  listOnboarding_().forEach(function (o) {
    if (o.provisioned_at) { out.already++; return; }        // done in a prior run
    if (!_provisionReady_(o)) { out.not_ready++; return; }   // waiting on signed contract / FICA
    var systems = safeJsonParse_(o.systems_json, null);
    if (!Array.isArray(systems) || !systems.length) {
      systems = resolveSystems_(o.entity || 'quay1', o.programs, null, o.team, o.activity || o.designation);
    }
    try {
      provisionAll_(o.folderId, systems, ctx);
      setOnboardingCell_(o.folderId, ONB_COL.provisioned_at, nowIso_());
      setOnboardingStatus_(o.folderId, 'Provisioned');
      out.provisioned.push(o.folderId);
    } catch (err) {
      out.errors.push({ folderId: o.folderId, error: String(err) });
      logAudit_('provision_batch_failed', { folderId: o.folderId, error: String(err) });
    }
  });
  logAudit_('provision_batch_run', out);
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}

/**
 * IMMEDIATE-ON-APPROVE (kind:'approve'). An admin reviews the signed contract + FICA docs on the site
 * and clicks "Approve & set up". This is the ONLY path that turns a candidate into real accounts, and
 * it happens on that deliberate click - not on onboard, not on a timer. Idempotent: a row already
 * provisioned is a no-op success. requireAdmin_ is asserted at the call site (Router._approveDispatch_).
 */
function approveAndProvision_(folderId, ctx) {
  var o = readOnboardingByFolder_(folderId);
  if (!o) return { ok: false, error: 'onboarding row not found' };
  if (o.provisioned_at) return { ok: true, already: true, message: 'already set up on ' + o.provisioned_at };
  if (!_docsReady_(o)) {
    return { ok: false, error: 'not ready: the signed contract and all FICA documents (ID, proof of address, bank) must be uploaded before approval' };
  }
  // Stamp the approval FIRST so the gate is satisfied even if provisioning is later retried by the batch.
  setOnboardingCell_(folderId, ONB_COL.approved_at, nowIso_());
  setOnboardingCell_(folderId, ONB_COL.approved_by, (ctx && ctx.email) || 'admin');
  logAudit_('onboard_approved', { folderId: folderId, by: (ctx && ctx.email) || '' });

  var systems = safeJsonParse_(o.systems_json, null);
  if (!Array.isArray(systems) || !systems.length) {
    systems = resolveSystems_(o.entity || 'quay1', o.programs, null, o.team, o.activity || o.designation);
  }
  var prov = provisionAll_(folderId, systems, ctx);
  setOnboardingCell_(folderId, ONB_COL.provisioned_at, nowIso_());
  setOnboardingStatus_(folderId, 'Provisioned');
  return { ok: true, approved_at: nowIso_(), approved_by: (ctx && ctx.email) || '', provisioning: prov.results };
}

/** Shallow copy of a provisioner result with the temp password stripped, so it never lands in the
 *  broadly-readable Provisioning Queue. Leaves the plaintext credential to the restricted Credentials tab. */
function _redactResult_(result) {
  if (!result || typeof result !== 'object') return result;
  var out = {}, k;
  for (k in result) { if (result.hasOwnProperty(k) && k !== 'tempPw' && k !== 'temp_password') out[k] = result[k]; }
  if ('tempPw' in result || 'temp_password' in result) out.temp_pw_issued = true;
  return out;
}

/** Run an inline (API) provisioner, write its done/error PQ row, and return {status, result}. */
function _runInline_(person, system, fn) {
  var status = 'done', result;
  try {
    result = fn() || {};
  } catch (err) {
    status = 'error';
    result = { error: String(err) };
  }
  enqueueProvision_({
    folderId: person.folderId, full_name: person.full_name, first_name: person.first_name,
    id_number: person.id_number, quay_email: person.quay_email || (result && result.email) || '',
    cell: person.cell, system: system, action: 'create',
    // The stored result must not carry the plaintext temp password (the Queue is broadly readable);
    // the credential lives only in the restricted Credentials tab. Strip it before persisting.
    payload: _inlinePayload_(person, system, result), status: status, result: _redactResult_(result),
  });
  return { status: status, result: result };
}

/** payload_json written on an inline row (CONTRACTS section 1, payload_json shapes). The temp password
 *  is NOT stored here - the Provisioning Queue is broadly readable, so the credential lives ONLY in the
 *  restricted Credentials tab (recordCredential_). We keep a boolean marker for traceability. */
function _inlinePayload_(person, system, result) {
  if (system === 'google') {
    return { groups: _groupsForTeam_(person.team), designation: person.designation, temp_pw_issued: !!(result && result.tempPw) };
  }
  if (system === 'propdata') {
    return { vendor_branch: person.team || '', role: _propdataRole_(person) };
  }
  return {};
}

// ---------------------------------------------------------------- Google Workspace

/**
 * Groups a newly onboarded broker is added to. TWO are always present (the onboarding rule):
 *   - the company-wide group CFG.COMPANY_GROUP (champions@) - every broker, no exceptions;
 *   - the broker's own team group, derived from the team name (wombats -> wombats@quay1.co.za).
 * Any groups an admin configured in the Team Directory tab (teamMapping_) are UNIONED on top, so a
 * team needing extra groups still gets them. Case-insensitive de-dup. See Teams.js (Blocker B.3).
 */
function _groupsForTeam_(team) {
  var groups = teamMapping_(team).groups.slice(); // admin-configured extras (may be [])
  _pushGroup_(groups, CFG.COMPANY_GROUP);
  _pushGroup_(groups, _teamGroup_(team));
  return groups;
}

/** Derive a team's Google group email from its name: 'Wombats' -> 'wombats@quay1.co.za'.
 *  Non-alphanumerics are stripped. '' when the team name has no usable characters. */
function _teamGroup_(team) {
  var slug = String(team == null ? '' : team).trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  return slug ? slug + '@' + CFG.DOMAIN : '';
}

/** Push a group email onto the list unless a case-insensitive match is already present. */
function _pushGroup_(arr, email) {
  if (!email) return;
  var k = String(email).toLowerCase();
  if (arr.some(function (g) { return String(g).toLowerCase() === k; })) return;
  arr.push(email);
}

/** A random, per-user temporary password that meets Google's complexity rules (mixed case + digit +
 *  symbol, 14 chars). Not derived from any personal detail, so it cannot be guessed from a name.
 *  changePasswordAtNextLogin forces the broker to set their own on first sign-in. */
function _randomTempPw_() {
  var upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ', lower = 'abcdefghijkmnpqrstuvwxyz';
  var digit = '23456789', sym = '!@#$%*?';
  var all = upper + lower + digit + sym;
  var pick = function (set) { return set.charAt(Math.floor(Math.random() * set.length)); };
  var out = pick(upper) + pick(lower) + pick(digit) + pick(sym);  // guarantee one of each class
  for (var i = 0; i < 10; i++) out += pick(all);
  return out.split('').sort(function () { return Math.random() - 0.5; }).join('');
}

/**
 * Create the Google Workspace user. DRY_RUN (default): log + return the payload it WOULD send.
 * Live: Users.insert first@quay1.co.za (fallback first.surname@ on 409), then Members.insert
 * per group. Random per-user temp password (see _randomTempPw_), changePasswordAtNextLogin.
 */
function googleCreate_(person) {
  var first = String(person.first_name || 'user').toLowerCase().replace(/[^a-z0-9]/g, '');
  var last = String(person.last_name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  var primary = first + '@' + CFG.DOMAIN;
  var fallback = (first + (last ? '.' + last : '')) + '@' + CFG.DOMAIN;
  var tempPw = _randomTempPw_();  // random per user; handed over via the private Credentials tab, never guessable
  var groups = _groupsForTeam_(person.team);

  if (DRY_RUN_()) {
    logAudit_('google_create_dryrun', { primary: primary, fallback: fallback, groups: groups });
    return { dryRun: true, email: primary, tempPw: tempPw, would: { primary: primary, groups: groups } };
  }

  var email = primary;
  var body = {
    primaryEmail: primary,
    name: { givenName: person.first_name || 'User', familyName: person.last_name || (person.first_name || 'User') },
    password: tempPw,
    changePasswordAtNextLogin: true,
  };
  try {
    AdminDirectory.Users.insert(body);
  } catch (err) {
    if (/409|dupli|exist/i.test(String(err))) {
      email = fallback;
      body.primaryEmail = fallback;
      AdminDirectory.Users.insert(body);
    } else {
      throw err;
    }
  }
  groups.forEach(function (grp) {
    try { AdminDirectory.Members.insert({ email: email, role: 'MEMBER' }, grp); }
    catch (e) { logAudit_('google_group_add_failed', { email: email, group: grp, error: String(e) }); }
  });
  recordCredential_({ full_name: person.full_name, quay_email: email, temp_password: tempPw,
    team: person.team, folderId: person.folderId });
  return { email: email, tempPw: tempPw, groups: groups };
}

// ---------------------------------------------------------------- Credentials ledger
// A superuser-readable record of every Google account created (email + temp password), so ops can
// hand a broker their login without digging through the Provisioning Queue's payload_json. It lives
// in the PRIVATE tracker Sheet, so who-can-open-the-sheet IS the access control. Only written on the
// LIVE create path (a dry-run makes no real account, so there is nothing to hand out).

var CRED_HEADERS = ['created_at', 'full_name', 'quay_email', 'temp_password', 'team', 'folderId'];

/** Create/repair the Credentials tab with its header row (idempotent). Returns the Sheet. */
function ensureCredentialsTab_(ss) {
  var t = ss.getSheetByName(CFG.TAB.CREDENTIALS) || ss.insertSheet(CFG.TAB.CREDENTIALS);
  t.getRange(1, 1, 1, CRED_HEADERS.length).setValues([CRED_HEADERS]).setFontWeight('bold');
  t.setFrozenRows(1);
  return t;
}

/** Upsert (by quay_email) one credential row so re-provisioning refreshes rather than duplicates.
 *  Best-effort: a ledger write must never fail the account creation, so errors are logged only. */
function recordCredential_(entry) {
  try {
    var email = String((entry && entry.quay_email) || '').trim();
    if (!email) return;
    var t = ensureCredentialsTab_(sheet_());
    var row = [nowIso_(), entry.full_name || '', email, entry.temp_password || '', entry.team || '', entry.folderId || ''];
    var text = function (r) { return r.map(function (v) { return String(v == null ? '' : v); }); };
    var last = t.getLastRow();
    if (last > 1) {
      var emails = t.getRange(2, 3, last - 1, 1).getValues(); // col C = quay_email
      for (var i = 0; i < emails.length; i++) {
        if (String(emails[i][0]).trim().toLowerCase() === email.toLowerCase()) {
          t.getRange(i + 2, 1, 1, CRED_HEADERS.length).setNumberFormat('@').setValues([text(row)]);
          return;
        }
      }
    }
    t.getRange(last + 1, 1, 1, CRED_HEADERS.length).setNumberFormat('@').setValues([text(row)]);
  } catch (e) {
    logAudit_('credential_record_failed', { email: entry && entry.quay_email, error: String(e) });
  }
}

/** Look up a credential row by quay_email; null when absent. (Used by the live smoke test.) */
function _findCredential_(email) {
  var t = sheet_().getSheetByName(CFG.TAB.CREDENTIALS);
  if (!t || t.getLastRow() < 2) return null;
  var key = String(email || '').trim().toLowerCase();
  var vals = t.getRange(2, 1, t.getLastRow() - 1, CRED_HEADERS.length).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][2]).trim().toLowerCase() === key) {
      return { created_at: vals[i][0], full_name: vals[i][1], quay_email: vals[i][2],
        temp_password: vals[i][3], team: vals[i][4], folderId: vals[i][5] };
    }
  }
  return null;
}

/** Delete every credential row for an email (cleanup after the throwaway smoke-test account). */
function _removeCredential_(email) {
  var t = sheet_().getSheetByName(CFG.TAB.CREDENTIALS);
  if (!t || t.getLastRow() < 2) return;
  var key = String(email || '').trim().toLowerCase();
  var col = t.getRange(2, 3, t.getLastRow() - 1, 1).getValues(); // col C = quay_email
  for (var i = col.length - 1; i >= 0; i--) { // bottom-up so row indices stay valid
    if (String(col[i][0]).trim().toLowerCase() === key) t.deleteRow(i + 2);
  }
}

/**
 * Suspend a Google account. Deliberately suspend-ONLY (user choice): a suspended account cannot log
 * in anywhere, so group membership and Drive are left untouched. Gated by BOTH DRY_RUN and
 * OFFBOARD_ARMED: only a live, armed call actually suspends. Idempotent (suspend on an
 * already-suspended user succeeds). Returns a result object for the Offboarding Queue google_result.
 */
function googleSuspend_(email) {
  if (!email) return { ok: false, error: 'no email' };
  if (DRY_RUN_() || !offboardArmed_()) {
    logAudit_('google_suspend_dryrun', { email: email, armed: offboardArmed_() });
    return { ok: true, suspended: false, dryRun: true, armed: offboardArmed_(), would: 'suspend ' + email };
  }
  AdminDirectory.Users.update({ suspended: true }, email); // idempotent
  logAudit_('google_suspended', { email: email });
  return { ok: true, email: email, suspended: true };
}

// ---------------------------------------------------------------- PropData REST (feeds-api)

/** Derive the PropData profile type from the self-declared FFC status. A full FFC holder gets a full
 *  agent profile; a candidate practitioner or no-status hire gets a numbered specialist profile.
 *  Shared by the FICA intake (which persists it) and provisioning (which sends it as the role). */
function propdataProfileType_(ffcStatus) {
  return String(ffcStatus || '').toLowerCase() === 'full' ? 'agent' : 'specialist';
}

function _propdataReady_() {
  return propdataLive_() && !!optProp_(PROP.PROPDATA_API_KEY) && !!optProp_(PROP.PROPDATA_VENDOR_ID);
}

function propdataCreate_(person) { return _propdata_(person, 'create'); }
function propdataDeactivate_(person) { return _propdata_(person, 'deactivate'); }

/** POST an agent create/deactivate to feeds-api.propdata.net. Dry-run unless PROPDATA_LIVE and
 *  both creds present. Endpoint path is a TODO pending PropData docs (Blocker B2). */
function _propdata_(person, action) {
  var payload = {
    action: action, first_name: person.first_name, last_name: person.last_name,
    email: person.quay_email || person.email, id_number: person.id_number,
    vendor_id: optProp_(PROP.PROPDATA_VENDOR_ID), role: _propdataRole_(person),
  };
  if (!_propdataReady_()) {
    logAudit_('propdata_dryrun', { action: action, payload: payload });
    return { ok: true, dryRun: true, would: payload };
  }
  // TODO(B2): confirm the real agent endpoint path with api-support@propdata.net.
  var url = 'https://feeds-api.propdata.net/v1/agents';
  var res = UrlFetchApp.fetch(url, {
    method: action === 'deactivate' ? 'delete' : 'post',
    contentType: 'application/json', muteHttpExceptions: true,
    headers: { api_key: optProp_(PROP.PROPDATA_API_KEY), 'vendor-id': optProp_(PROP.PROPDATA_VENDOR_ID) },
    payload: JSON.stringify(payload),
  });
  var code = res.getResponseCode();
  if (code >= 200 && code < 300) return { ok: true, code: code, body: safeJsonParse_(res.getContentText(), res.getContentText()) };
  throw new Error('propdata ' + action + ' failed: HTTP ' + code + ' ' + res.getContentText());
}

// ---------------------------------------------------------------- browser systems (enqueue)

/** Write pending Provisioning Queue rows for the browser-only systems. Returns the queue_ids. */
function enqueueBrowserSystems_(person, systems, action) {
  var ids = [];
  (systems || []).forEach(function (s) {
    if (CFG.WORKER_SYSTEMS.indexOf(s) < 0) return;
    var id = enqueueProvision_({
      folderId: person.folderId, full_name: person.full_name, first_name: person.first_name,
      id_number: person.id_number, quay_email: person.quay_email, cell: person.cell,
      system: s, action: action || 'create', payload: _browserPayload_(s, person), status: 'pending',
    });
    ids.push(id);
  });
  return ids;
}

/** payload_json for a browser row (CONTRACTS section 1, payload_json shapes). */
function _browserPayload_(system, person) {
  if (system === 'property24') return { branch: person.team || '', google_linked: true };
  if (system === 'dialfire') return { campaign: person.team || '' };
  return {}; // cma: OTP-gated, no payload
}

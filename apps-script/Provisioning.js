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
 *   resolveSystems_(entity, programs, explicit) - [system...]  core systems + mapped programs.
 *   provisionAll_(folderId, systems, ctx)       - {ok, results:{system:status}}  requireAdmin_.
 *   googleCreate_(person)        - {email, tempPw, dryRun?}  Users.insert + Members.insert.
 *   googleSuspend_(email)        - {ok, ...}  Users.update {suspended:true} + group + Drive.
 *   propdataCreate_(person) / propdataDeactivate_(person) - {ok, dryRun?}  feeds-api REST.
 *   enqueueBrowserSystems_(person, systems, action) - [queue_id...]  pending worker rows.
 *
 * DRY_RUN_() default true: inline provisioners log the payload they WOULD send and write a done
 * row with {"dry_run":true}. No live mutation until armed.
 */

/** Resolve the systems to provision: an explicit list wins; else the entity core set plus any
 *  systems mapped from ticked programs. Filtered to the SYSTEMS enum; hubspot excluded here
 *  (seat create is a separate flag-gated concern). */
function resolveSystems_(entity, programs, explicit) {
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
  return Object.keys(set);
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
    quay_email: '',
  };
}

/**
 * Orchestrate provisioning for one person: Google first (inline), then PropData (inline), then
 * enqueue the browser systems for the worker. Returns { ok, results:{system:status} }.
 */
function provisionAll_(folderId, systems, ctx) {
  requireAdmin_(ctx);
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
    payload: _inlinePayload_(person, system, result), status: status, result: result,
  });
  return { status: status, result: result };
}

/** payload_json written on an inline row (CONTRACTS section 1, payload_json shapes). */
function _inlinePayload_(person, system, result) {
  if (system === 'google') {
    return { groups: _groupsForTeam_(person.team), designation: person.designation, temp_pw: (result && result.tempPw) || '' };
  }
  if (system === 'propdata') {
    return { vendor_branch: person.team || '', role: 'agent' };
  }
  return {};
}

// ---------------------------------------------------------------- Google Workspace

/** Groups for a team from the GROUPS_JSON property (team -> [group emails]); [] if unset. */
function _groupsForTeam_(team) {
  var map = safeJsonParse_(optProp_(PROP.GROUPS_JSON), {});
  if (!map || typeof map !== 'object') return [];
  var g = map[team] || map['*'] || [];
  return Array.isArray(g) ? g : [];
}

/**
 * Create the Google Workspace user. DRY_RUN (default): log + return the payload it WOULD send.
 * Live: Users.insert first@quay1.co.za (fallback first.surname@ on 409), then Members.insert
 * per group. Temp password 'G{First}@002', changePasswordAtNextLogin.
 */
function googleCreate_(person) {
  var first = String(person.first_name || 'user').toLowerCase().replace(/[^a-z0-9]/g, '');
  var last = String(person.last_name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  var primary = first + '@' + CFG.DOMAIN;
  var fallback = (first + (last ? '.' + last : '')) + '@' + CFG.DOMAIN;
  var tempPw = 'G' + (person.first_name || 'User').replace(/[^A-Za-z0-9]/g, '') + '@002';
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
  return { email: email, tempPw: tempPw, groups: groups };
}

/**
 * Suspend a Google account and tear down its access. Gated by BOTH DRY_RUN and OFFBOARD_ARMED:
 * only a live, armed call actually suspends. Idempotent (suspend on an already-suspended user
 * succeeds). Returns a result object for the Offboarding Queue google_result column.
 */
function googleSuspend_(email) {
  if (!email) return { ok: false, error: 'no email' };
  if (DRY_RUN_() || !offboardArmed_()) {
    logAudit_('google_suspend_dryrun', { email: email, armed: offboardArmed_() });
    return { ok: true, suspended: false, dryRun: true, armed: offboardArmed_(), would: 'suspend ' + email };
  }
  var out = { ok: true, email: email, suspended: false, groupsRemoved: [], drive: 'noop' };
  AdminDirectory.Users.update({ suspended: true }, email); // idempotent
  out.suspended = true;
  try {
    var resp = AdminDirectory.Groups.list({ userKey: email });
    (resp.groups || []).forEach(function (grp) {
      try { AdminDirectory.Members.remove(grp.email, email); out.groupsRemoved.push(grp.email); }
      catch (e) { logAudit_('google_group_remove_failed', { email: email, group: grp.email, error: String(e) }); }
    });
  } catch (e) { logAudit_('google_group_list_failed', { email: email, error: String(e) }); }
  // Drive transfer/revoke: a Data Transfer / Drive API step. Left as a logged TODO so we never
  // silently claim Drive was handled. Configure DRIVE_TRANSFER_TO to enable a real transfer.
  var transferTo = optProp_(PROP.DRIVE_TRANSFER_TO);
  out.drive = transferTo ? ('transfer_to ' + transferTo + ' (TODO: wire Data Transfer API)') : 'skipped (no DRIVE_TRANSFER_TO)';
  return out;
}

// ---------------------------------------------------------------- PropData REST (feeds-api)

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
    vendor_id: optProp_(PROP.PROPDATA_VENDOR_ID), role: 'agent',
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

/**
 * Programs.js - the Programs page data (who on a team holds CMA + PropData accounts).
 *
 * Owner: backend. Assembles a senior-broker -> team tree from the shared divisions directory
 * (CFG.DIVISIONS_URL) joined, by email, to two PRIVATE roster tabs on the tracker: "CMA Accounts"
 * and "PropData Accounts" (refreshed by pasting the periodic exports; never in the public repo).
 *
 * Matching:
 *   - Email is dot-insensitive in the local part (Google Workspace treats a.b@ == ab@), so
 *     divisions' "liam.stewart@" matches PropData's "liamstewart@". See _normEmail_.
 *   - Agents also get a full-name fallback when the email misses. Numbered specialist profiles
 *     have no personal name (the name field is the slot label) so they match on email only.
 *
 * Role scope (SPEC: only a senior sees their team; a plain broker sees only themselves):
 *   - super || admin        -> every team, every section.
 *   - senior of a team(s)    -> those team(s), in full (senior = the team's FIRST-listed broker).
 *   - any other active staff -> a single "Your account" row (their own CMA/PropData status only).
 *
 * Public surface:
 *   programsData_(ctx)        - { scope:'all'|'senior'|'self', sections:[...], generated } | throws.
 *   ensureAccountsTabs_(ss)   - create/repair the two roster tabs + headers (idempotent).
 */

var CMA_HEADERS = ['First', 'Last', 'Email'];
var PROPDATA_HEADERS = ['First Name', 'Last Name', 'Email', 'Active'];

/** Assemble the Programs tree, scoped to the caller's role. Requires an authed ctx. */
function programsData_(ctx) {
  if (!ctx || !ctx.role) throw new Error('unauthorized');
  var div = _programsDivisions_();
  var cma = _cmaSet_();
  var pd = _propdataMaps_();
  var full = _programsTree_(div, cma, pd);
  var isAdmin = !!(ctx.role.is_super || ctx.role.is_admin);
  var stamp = nowIso_();

  if (isAdmin) return { scope: 'all', sections: full, generated: stamp };

  var me = _normEmail_(ctx.email);

  // Teams where the caller is the senior (first-listed broker).
  var mine = [];
  full.forEach(function (s) {
    var teams = (s.teams || []).filter(function (t) {
      return t.people[0] && _normEmail_(t.people[0].email) === me && !!me;
    });
    if (teams.length) mine.push({ name: s.name, teams: teams });
  });
  if (mine.length) return { scope: 'senior', sections: mine, generated: stamp };

  // Plain broker / other staff: only their own row.
  var self = null;
  full.forEach(function (s) {
    (s.teams || []).forEach(function (t) {
      (t.people || []).forEach(function (p) {
        if (!self && me && _normEmail_(p.email) === me) self = p;
      });
    });
  });
  var sections = self ? [{ name: 'Your account', teams: [{ name: '', senior: '', people: [self] }] }] : [];
  return { scope: 'self', sections: sections, generated: stamp };
}

// ---------------------------------------------------------------- tree build

/** Build sections -> teams -> people[{name,email,senior,cma,pd}] from divisions + rosters. */
function _programsTree_(div, cma, pd) {
  var out = [];
  ((div && div.sections) || []).forEach(function (sec) {
    var teams = [];
    (sec.teams || []).forEach(function (t) {
      var people = [];
      (t.brokers || []).forEach(function (b, i) {
        if (!b || !b.name) return;
        var e = _normEmail_(b.email);
        var rec = _pdLookup_(pd, e, b.name);
        people.push({
          name: b.name, email: b.email || '', senior: i === 0,
          cma: !!e && !!cma[e], pd: rec,
        });
      });
      if (people.length) teams.push({ name: t.name, senior: people[0].name, people: people });
    });
    if (teams.length) out.push({ name: sec.name, teams: teams });
  });
  return out;
}

/** PropData record for a person: email first (dot-insensitive), then full-name fallback (agents
 *  only - specialist profiles carry the slot label, not the person's name). null if none. */
function _pdLookup_(pd, normEmail, name) {
  if (normEmail && pd.byEmail[normEmail]) return pd.byEmail[normEmail];
  var k = _normName_(name);
  if (k && pd.byName[k]) return pd.byName[k];
  return null;
}

// ---------------------------------------------------------------- roster readers

/** CMA holders as a set-like object keyed by normalised email (any @ cell in the tab counts). */
function _cmaSet_() {
  var set = {};
  _tabRows_(CFG.CMA_ACCOUNTS).forEach(function (row) {
    row.forEach(function (cell) {
      var v = String(cell == null ? '' : cell);
      if (v.indexOf('@') >= 0) { var e = _normEmail_(v); if (e) set[e] = true; }
    });
  });
  return set;
}

/** PropData rosters: { byEmail: {email:{type,number,active}}, byName: {normName:{...}} }.
 *  Reads by header name so the raw export (with all its stat columns) pastes in as-is. */
function _propdataMaps_() {
  var rows = _tabRows_(CFG.PROPDATA_ACCOUNTS);
  var maps = { byEmail: {}, byName: {} };
  if (!rows.length) return maps;
  var head = rows[0].map(function (h) { return String(h || '').trim().toLowerCase(); });
  var ci = {
    first: head.indexOf('first name'), last: head.indexOf('last name'),
    email: head.indexOf('email'), active: head.indexOf('active'),
  };
  if (ci.email < 0) return maps; // no usable header row
  for (var r = 1; r < rows.length; r++) {
    var row = rows[r];
    var email = _normEmail_(ci.email >= 0 ? row[ci.email] : '');
    if (!email) continue;
    var first = ci.first >= 0 ? String(row[ci.first] || '') : '';
    var last = ci.last >= 0 ? String(row[ci.last] || '') : '';
    var active = ci.active >= 0 ? String(row[ci.active] || '').trim().toLowerCase() === 'yes' : true;
    var isSpec = /specialist/i.test(first);
    var rec = isSpec
      ? { type: 'specialist', number: String(last).trim(), active: active }
      : { type: 'agent', number: '', active: active };
    // Prefer an active profile if the same email appears twice.
    if (!maps.byEmail[email] || (active && !maps.byEmail[email].active)) maps.byEmail[email] = rec;
    if (!isSpec) {
      var nk = _normName_(first + ' ' + last);
      if (nk && (!maps.byName[nk] || (active && !maps.byName[nk].active))) maps.byName[nk] = rec;
    }
  }
  return maps;
}

/** All rows of a tracker tab as a 2D array; [] when the tab is absent/empty. Never throws. */
function _tabRows_(tabName) {
  try {
    var sh = sheet_().getSheetByName(tabName);
    if (!sh || sh.getLastRow() < 1) return [];
    return sh.getDataRange().getValues();
  } catch (err) {
    logAudit_('programs_tab_read_failed', { tab: tabName, error: String(err) });
    return [];
  }
}

// ---------------------------------------------------------------- divisions + helpers

/** The divisions directory (CFG.DIVISIONS_URL). {sections:[]} on any failure (never throws). */
function _programsDivisions_() {
  try {
    var res = UrlFetchApp.fetch(CFG.DIVISIONS_URL, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) { logAudit_('programs_divisions_failed', { code: res.getResponseCode() }); return { sections: [] }; }
    return safeJsonParse_(res.getContentText(), { sections: [] }) || { sections: [] };
  } catch (err) {
    logAudit_('programs_divisions_failed', { error: String(err) });
    return { sections: [] };
  }
}

/** Dot-insensitive, lower-cased email (Google Workspace ignores dots in the local part). '' if invalid. */
function _normEmail_(e) {
  var s = String(e == null ? '' : e).trim().toLowerCase();
  var at = s.indexOf('@');
  if (at <= 0) return '';
  return s.slice(0, at).replace(/\./g, '') + s.slice(at);
}

/** Normalise a full name for fallback matching (lower, collapse whitespace, strip punctuation). */
function _normName_(name) {
  return String(name == null ? '' : name).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Create/repair the two roster tabs with header rows (idempotent). Returns nothing. */
function ensureAccountsTabs_(ss) {
  _ensureHeaderTab_(ss, CFG.CMA_ACCOUNTS, CMA_HEADERS);
  _ensureHeaderTab_(ss, CFG.PROPDATA_ACCOUNTS, PROPDATA_HEADERS);
}

function _ensureHeaderTab_(ss, name, headers) {
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  var head = sh.getRange(1, 1, 1, headers.length).getValues()[0];
  var needs = headers.some(function (h, i) { return String(head[i] || '').trim() !== h; });
  if (needs && sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

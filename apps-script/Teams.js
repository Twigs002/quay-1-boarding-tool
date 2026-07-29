/**
 * Teams.js - the team -> {Google groups, division, systems} mapping (Blocker B.3).
 *
 * Owner: backend. Replaces the hardcoded GROUPS_JSON Script Property with an editable tab on the
 * tracker Sheet ("Team Directory"), so ops can maintain the team->groups map in a spreadsheet
 * "for the time being" without a code change. The tab is auto-created + auto-seeded (Team +
 * Division) from the shared divisions directory (CFG.DIVISIONS_URL); an admin fills the Google
 * Groups + Systems columns. GROUPS_JSON remains a fallback so nothing breaks before the tab is set.
 *
 * Tab columns (row 1 header, matched by name so column order is not load-bearing):
 *   Team | Division | Google Groups | Systems
 * Groups/Systems cells are comma/semicolon/newline separated lists.
 *
 * Public surface:
 *   teamMapping_(team)          - { groups:[email...], division:'', systems:[system...] }
 *   ensureTeamDirectoryTab_(ss) - Sheet   create/repair the tab + header (idempotent).
 *   setupTeamDirectory()        - String  seed Team+Division rows from divisions.json (idempotent).
 */

var TEAM_DIR_HEADERS = ['Team', 'Division', 'Google Groups', 'Systems'];

// Per-execution cache: { normalisedTeamName: {groups, division, systems} } plus a '*' wildcard row.
var _teamDirCache = null;

/** Resolve one team to its mapping. Case-insensitive on the team name; falls back to the '*'
 *  wildcard row, then (for groups only) the legacy GROUPS_JSON property. Never throws. */
function teamMapping_(team) {
  var key = _normTeam_(team);
  var map = _teamDirectory_();
  var row = (key && map[key]) || map['*'] || null;
  var groups = row ? row.groups.slice() : [];
  var division = row ? row.division : '';
  var systems = row ? row.systems.slice() : [];
  if (!groups.length) groups = _groupsFromJson_(team); // legacy fallback until the tab is filled
  return { groups: groups, division: division, systems: systems };
}

/** Read + cache the whole Team Directory tab as { normTeam: {groups, division, systems} }. */
function _teamDirectory_() {
  if (_teamDirCache) return _teamDirCache;
  var out = {};
  try {
    var sh = sheet_().getSheetByName(CFG.TAB.TEAM_DIRECTORY);
    if (sh && sh.getLastRow() > 1) {
      var values = sh.getDataRange().getValues();
      var head = values[0].map(function (h) { return String(h || '').trim().toLowerCase(); });
      var ci = {
        team: head.indexOf('team'),
        division: head.indexOf('division'),
        groups: head.indexOf('google groups'),
        systems: head.indexOf('systems'),
      };
      for (var r = 1; r < values.length; r++) {
        var row = values[r];
        var name = ci.team >= 0 ? String(row[ci.team] || '').trim() : '';
        if (!name) continue;
        out[_normTeam_(name)] = {
          division: ci.division >= 0 ? String(row[ci.division] || '').trim() : '',
          groups: ci.groups >= 0 ? _splitList_(row[ci.groups]) : [],
          systems: ci.systems >= 0 ? _splitList_(row[ci.systems]).map(function (s) { return s.toLowerCase(); }) : [],
        };
      }
    }
  } catch (err) {
    logAudit_('team_directory_read_failed', { error: String(err) });
  }
  _teamDirCache = out;
  return out;
}

/** Legacy GROUPS_JSON fallback (team -> [group emails], or '*' wildcard). [] if unset/absent. */
function _groupsFromJson_(team) {
  var map = safeJsonParse_(optProp_(PROP.GROUPS_JSON), {});
  if (!map || typeof map !== 'object') return [];
  var g = map[team] || map['*'] || [];
  return Array.isArray(g) ? g : [];
}

/** Create/repair the Team Directory tab with its header row (idempotent). Returns the Sheet. */
function ensureTeamDirectoryTab_(ss) {
  var sh = ss.getSheetByName(CFG.TAB.TEAM_DIRECTORY) || ss.insertSheet(CFG.TAB.TEAM_DIRECTORY);
  var head = sh.getRange(1, 1, 1, TEAM_DIR_HEADERS.length).getValues()[0];
  var needsHeader = TEAM_DIR_HEADERS.some(function (h, i) { return String(head[i] || '').trim() !== h; });
  if (needsHeader) {
    sh.getRange(1, 1, 1, TEAM_DIR_HEADERS.length).setValues([TEAM_DIR_HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

/**
 * Seed the Team Directory with one row per team (Team + Division) from the shared divisions
 * directory, WITHOUT touching teams already present (so admin-entered Groups/Systems are never
 * clobbered). Groups/Systems are left blank for an admin to fill. Idempotent. Runnable from the
 * editor Run picker.
 */
function setupTeamDirectory() {
  var ss = sheet_();
  var sh = ensureTeamDirectoryTab_(ss);
  var existing = {};
  if (sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().forEach(function (r) {
      var n = _normTeam_(r[0]); if (n) existing[n] = true;
    });
  }
  var teams = _divisionsTeams_();
  var toAdd = [];
  teams.forEach(function (t) {
    var n = _normTeam_(t.name);
    if (!n || existing[n]) return;
    existing[n] = true; // guard against duplicates within the source too
    toAdd.push([t.name, t.division, '', '']);
  });
  if (toAdd.length) sh.getRange(sh.getLastRow() + 1, 1, toAdd.length, TEAM_DIR_HEADERS.length).setValues(toAdd);
  _teamDirCache = null; // invalidate so the next read sees the seeded rows
  var msg = 'setupTeamDirectory: ' + toAdd.length + ' team(s) added, ' +
    (Object.keys(existing).length) + ' total. Fill the Google Groups + Systems columns as needed.';
  Logger.log(msg);
  return msg;
}

/** Fetch divisions.json and flatten to [{name, division}] (division = hubspot_division or section). */
function _divisionsTeams_() {
  var out = [];
  try {
    var res = UrlFetchApp.fetch(CFG.DIVISIONS_URL, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) { logAudit_('divisions_fetch_failed', { code: res.getResponseCode() }); return out; }
    var data = safeJsonParse_(res.getContentText(), {}) || {};
    (data.sections || []).forEach(function (sec) {
      (sec.teams || []).forEach(function (t) {
        var name = String(t.name || '').trim();
        if (!name) return;
        out.push({ name: name, division: String(t.hubspot_division || sec.name || '').trim() });
      });
    });
  } catch (err) {
    logAudit_('divisions_fetch_failed', { error: String(err) });
  }
  return out;
}

/** Split a cell into a trimmed, de-duplicated list (comma / semicolon / newline separated). */
function _splitList_(cell) {
  var seen = {}, out = [];
  String(cell == null ? '' : cell).split(/[,;\n]+/).forEach(function (p) {
    var v = String(p || '').trim();
    if (!v) return;
    var k = v.toLowerCase();
    if (seen[k]) return;
    seen[k] = true; out.push(v);
  });
  return out;
}

/** Normalise a team name for case-insensitive matching. */
function _normTeam_(team) { return String(team == null ? '' : team).trim().toLowerCase(); }

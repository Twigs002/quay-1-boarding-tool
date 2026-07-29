/**
 * Setup.js - one-time provisioning helpers. Every function here has NO trailing underscore so it
 * appears in the Apps Script Run picker. They create the tracker tabs, seed the SAFE flag
 * defaults, install the digest trigger, and store secrets in Script Properties (never in source).
 *
 * Addition to the stub set (flagged to tester + architect). BUILD ONLY: none of these deploy or
 * touch a live external account. Run order after the first `clasp push`:
 *   1. setSupabase(url, anon, service)     2. setWebappUrl(deployedExecUrl)
 *   3. setQuay1Templates(...) / setAquaTemplates(...)   4. setupHub()   5. setupTriggers()
 * Optional: setPropdataCreds, setHubspotToken, setGroupsJson, setDriveTransferTo.
 * hubStatus() prints a non-secret summary of what is configured.
 */

/** Create/repair the tracker tabs and seed the safe flag defaults. Idempotent. Needs no args
 *  once TRACKER_SHEET_ID is set (or it creates a new tracker Spreadsheet and stores its id). */
function setupHub() {
  var id = optProp_(PROP.TRACKER_SHEET_ID);
  var ss;
  if (id) {
    ss = SpreadsheetApp.openById(id);
  } else {
    ss = SpreadsheetApp.create('Quay 1 Boarding Tool Tracker');
    _setProp_(PROP.TRACKER_SHEET_ID, ss.getId());
  }
  // Onboarding tab (rename the default first sheet if it is the blank one).
  var onb = ss.getSheetByName(CFG.TAB.ONBOARDING);
  if (!onb) {
    var first = ss.getSheets()[0];
    if (first && first.getLastRow() === 0 && first.getLastColumn() === 0) {
      first.setName(CFG.TAB.ONBOARDING); onb = first;
    } else {
      onb = ss.insertSheet(CFG.TAB.ONBOARDING);
    }
  }
  ensureOnboardingTab_(onb);
  ensureQueueTabs_(ss);
  _seedFlagDefaults_();
  var msg = 'setupHub complete. Tracker: ' + ss.getId() + '. Tabs: ' +
    ss.getSheets().map(function (s) { return s.getName(); }).join(', ') + '.';
  Logger.log(msg);
  return msg;
}

/** Install the recurring time-driven triggers (idempotent): the Tuesday induction digest (~07:00)
 *  and the offboarding stuck-row reaper (every 15 min). */
function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var fn = t.getHandlerFunction();
    if (fn === 'tuesdayDigest_' || fn === 'reapOffboarding_') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('tuesdayDigest_').timeBased()
    .onWeekDay(ScriptApp.WeekDay.TUESDAY).atHour(7).create();
  ScriptApp.newTrigger('reapOffboarding_').timeBased()
    .everyMinutes(15).create();
  return 'Triggers installed: Tuesday induction digest (~07:00) + offboarding reaper (every 15 min).';
}

/** Seed the SAFE flag defaults only when a flag is unset (never clobber an armed value). */
function _seedFlagDefaults_() {
  var defaults = {};
  defaults[FLAG.DRY_RUN] = '1';
  defaults[FLAG.OFFBOARD_ARMED] = '0';
  defaults[FLAG.HUBSPOT_SEAT_ENABLED] = '0';
  defaults[FLAG.PROPDATA_LIVE] = '0';
  Object.keys(defaults).forEach(function (k) {
    if (PropertiesService.getScriptProperties().getProperty(k) == null) _setProp_(k, defaults[k]);
  });
}

/**
 * One-shot LIVE bootstrap for everything non-secret. Run this ONCE from the Apps Script editor
 * after the first deploy: it triggers the OAuth consent for all project scopes (incl.
 * admin.directory - click Allow), seeds WEBAPP_URL (only if unset), stores the PUBLIC Supabase
 * url + anon key (same values already served in web/config.js - NOT secrets, every table is
 * RLS-gated), then creates the tracker tabs and installs the triggers. Idempotent.
 *
 * NOTE on WEBAPP_URL: from the editor, ScriptApp.getService().getUrl() returns the /dev HEAD url,
 * which requires a Workspace login and so is useless for the candidate FICA/induction links.
 * This only SEEDS it when unset; set the real versioned /exec url via setWebappUrl(execUrl) or the
 * Script Properties UI. bootstrapLive never overwrites an existing WEBAPP_URL.
 *
 * Still set separately afterwards (real ids / secrets, never in source): the contract template
 * Doc ids + Drive parent folders (setQuay1Templates / setAquaTemplates) and, once chosen, the
 * team->groups source. hubStatus() prints what remains unset.
 */
function bootstrapLive() {
  var out = [];
  // Seed WEBAPP_URL only when unset - never clobber a real /exec url with the editor's /dev url.
  if (!optProp_(PROP.WEBAPP_URL)) {
    var url = '';
    try { url = ScriptApp.getService().getUrl() || ''; } catch (e) { url = ''; }
    if (url) { setWebappUrl(url); out.push('WEBAPP_URL <- ' + url + ' (SEEDED /dev - replace with the /exec url)'); }
    else { out.push('WEBAPP_URL still unset (run setWebappUrl(execUrl) by hand)'); }
  } else {
    out.push('WEBAPP_URL already set - left as is');
  }
  // PUBLIC values, identical to web/config.js (anon key is public by design; RLS gates all tables).
  setSupabase('https://dqszbqiimbfvmmnpgpsb.supabase.co',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRxc3picWlpbWJmdm1tbnBncHNiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA4NDk4OTQsImV4cCI6MjA5NjQyNTg5NH0.M9RQnJEidyIMZAwbELTSPakiSnvuWBdHTjD7nuOdCZY');
  out.push('SUPABASE_URL + SUPABASE_ANON_KEY <- public values');
  out.push(setupHub());
  out.push(setupTriggers());
  var msg = 'bootstrapLive done:\n  ' + out.join('\n  ');
  Logger.log(msg);
  return msg;
}

// ---------------------------------------------------------------- secret setters

function setSupabase(url, anon, service) {
  _reqArg_(url, 'url'); _reqArg_(anon, 'anon');
  _setProp_(PROP.SUPABASE_URL, url);
  _setProp_(PROP.SUPABASE_ANON_KEY, anon);
  if (service) _setProp_(PROP.SUPABASE_SERVICE_KEY, service);
  return 'Supabase properties set.';
}

function setWebappUrl(url) { _reqArg_(url, 'url'); _setProp_(PROP.WEBAPP_URL, url); return 'WEBAPP_URL set.'; }

function setQuay1Templates(saleId, rentalId, parentFolderId) {
  _reqArg_(saleId, 'saleId'); _reqArg_(parentFolderId, 'parentFolderId');
  _setProp_(PROP.QUAY1_TEMPLATE_SALE, saleId);
  if (rentalId) _setProp_(PROP.QUAY1_TEMPLATE_RENTAL, rentalId);
  _setProp_(PROP.QUAY1_PARENT_FOLDER, parentFolderId);
  return 'Quay1 template + folder properties set.';
}

function setAquaTemplates(monthlyId, fixedId, permanentId, parentFolderId) {
  _reqArg_(monthlyId, 'monthlyId'); _reqArg_(parentFolderId, 'parentFolderId');
  _setProp_(PROP.AQUA_TEMPLATE_MONTHLY, monthlyId);
  if (fixedId) _setProp_(PROP.AQUA_TEMPLATE_FIXED, fixedId);
  if (permanentId) _setProp_(PROP.AQUA_TEMPLATE_PERMANENT, permanentId);
  _setProp_(PROP.AQUA_PARENT_FOLDER, parentFolderId);
  return 'Aqua template + folder properties set.';
}

function setPropdataCreds(apiKey, vendorId) {
  _reqArg_(apiKey, 'apiKey'); _reqArg_(vendorId, 'vendorId');
  _setProp_(PROP.PROPDATA_API_KEY, apiKey);
  _setProp_(PROP.PROPDATA_VENDOR_ID, vendorId);
  return 'PropData creds set (still dry-run until PROPDATA_LIVE=1).';
}

function setHubspotToken(token) { _reqArg_(token, 'token'); _setProp_(PROP.HUBSPOT_TOKEN, token); return 'HubSpot token set.'; }

function setGroupsJson(jsonString) {
  _reqArg_(jsonString, 'jsonString');
  if (!safeJsonParse_(jsonString, null)) throw new Error('jsonString is not valid JSON');
  _setProp_(PROP.GROUPS_JSON, jsonString);
  return 'GROUPS_JSON set.';
}

function setDriveTransferTo(email) { _reqArg_(email, 'email'); _setProp_(PROP.DRIVE_TRANSFER_TO, email); return 'DRIVE_TRANSFER_TO set.'; }

/** Print a non-secret summary of what is configured (which keys are set + the flag values). */
function hubStatus() {
  var isSet = function (k) { return optProp_(k) ? 'set' : '(unset)'; };
  var s = {
    tracker: isSet(PROP.TRACKER_SHEET_ID),
    webapp_url: isSet(PROP.WEBAPP_URL),
    supabase: isSet(PROP.SUPABASE_URL),
    quay1_templates: isSet(PROP.QUAY1_TEMPLATE_SALE) + '/' + isSet(PROP.QUAY1_TEMPLATE_RENTAL),
    aqua_templates: isSet(PROP.AQUA_TEMPLATE_MONTHLY) + '/' + isSet(PROP.AQUA_TEMPLATE_FIXED) + '/' + isSet(PROP.AQUA_TEMPLATE_PERMANENT),
    propdata_creds: isSet(PROP.PROPDATA_API_KEY) + '/' + isSet(PROP.PROPDATA_VENDOR_ID),
    hubspot_token: isSet(PROP.HUBSPOT_TOKEN),
    groups_json: isSet(PROP.GROUPS_JSON),
    flags: {
      DRY_RUN: DRY_RUN_(), OFFBOARD_ARMED: offboardArmed_(),
      HUBSPOT_SEAT_ENABLED: hubspotSeatEnabled_(), PROPDATA_LIVE: propdataLive_(),
    },
  };
  Logger.log(JSON.stringify(s, null, 2));
  return s;
}

// ---------------------------------------------------------------- helpers

function _setProp_(k, v) { PropertiesService.getScriptProperties().setProperty(k, String(v)); }
function _reqArg_(v, name) { if (!v || !String(v).trim()) throw new Error('argument "' + name + '" is required'); }

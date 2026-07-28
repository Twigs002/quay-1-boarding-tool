/**
 * Config.js - all constants, Script-Property secret access, and feature flags.
 *
 * NOTHING else in the codebase reads PropertiesService directly; everything goes through
 * here so secrets have exactly one access path and flags have one definition. No secret
 * literals in this file - only keys and defaults.
 *
 * Owner: backend. See docs/ARCHITECTURE.md section 5 and docs/CONTRACTS.md section 5.
 *
 * Public surface:
 *   CFG                          - non-secret constants (tab names, enums, brand colours,
 *                                  recipient lists, per-entity company info, system defaults).
 *   PROP / FLAG                  - Script-Property key names (spelled ONCE, here).
 *   prop_(key, required)         - String  read one Script Property (throws if required+missing).
 *   optProp_(key)                - String  read one Script Property or '' if unset.
 *   flag_(name, dflt)            - Boolean read a feature flag ('1'/'true' => true).
 *   DRY_RUN_()                   - Boolean convenience for the DRY_RUN flag (default TRUE).
 *   offboardArmed_/hubspotSeatEnabled_/propdataLive_ - the three named safety flags.
 *   sheet_()                     - Spreadsheet the shared tracker (by TRACKER_SHEET_ID prop).
 *   tab_(name)                   - Sheet   a tab on the tracker by name (throws if absent).
 *
 * Feature-flag defaults are the SAFE ones: DRY_RUN on, everything destructive/paid off.
 */

/** Script-Property key names for secrets + ids. Spelled ONCE, here. */
var PROP = {
  // Supabase (quay-clock project, shared with Aqua + the dashboards).
  SUPABASE_URL: 'SUPABASE_URL',
  SUPABASE_ANON_KEY: 'SUPABASE_ANON_KEY',
  SUPABASE_SERVICE_KEY: 'SUPABASE_SERVICE_KEY',
  // The one shared tracker Sheet (Onboarding + both queue tabs).
  TRACKER_SHEET_ID: 'TRACKER_SHEET_ID',
  // This deployment's own /exec url (used to build the candidate FICA + induction links).
  WEBAPP_URL: 'WEBAPP_URL',
  // External-system secrets.
  HUBSPOT_TOKEN: 'HUBSPOT_TOKEN',
  PROPDATA_API_KEY: 'PROPDATA_API_KEY',
  PROPDATA_VENDOR_ID: 'PROPDATA_VENDOR_ID',
  // Quay 1 contract template + Drive parent (Blocker B1: set via setup, never hardcoded).
  QUAY1_TEMPLATE_SALE: 'QUAY1_TEMPLATE_SALE',
  QUAY1_TEMPLATE_RENTAL: 'QUAY1_TEMPLATE_RENTAL',
  QUAY1_PARENT_FOLDER: 'QUAY1_PARENT_FOLDER',
  // Aqua MOA templates (monthly | fixed | permanent) + Drive parent.
  AQUA_TEMPLATE_MONTHLY: 'AQUA_TEMPLATE_MONTHLY',
  AQUA_TEMPLATE_FIXED: 'AQUA_TEMPLATE_FIXED',
  AQUA_TEMPLATE_PERMANENT: 'AQUA_TEMPLATE_PERMANENT',
  AQUA_PARENT_FOLDER: 'AQUA_PARENT_FOLDER',
  // team -> [google group emails] map, JSON. Read by Provisioning for Members.insert.
  GROUPS_JSON: 'GROUPS_JSON',
  // where to transfer/revoke Drive on offboard (a Workspace admin address), optional.
  DRIVE_TRANSFER_TO: 'DRIVE_TRANSFER_TO',
};

/** Feature-flag Script-Property keys (read via flag_ / the named helpers below). */
var FLAG = {
  DRY_RUN: 'DRY_RUN',
  OFFBOARD_ARMED: 'OFFBOARD_ARMED',
  HUBSPOT_SEAT_ENABLED: 'HUBSPOT_SEAT_ENABLED',
  PROPDATA_LIVE: 'PROPDATA_LIVE',
};

/** Non-secret constants shared across modules. */
var CFG = {
  DOMAIN: 'quay1.co.za',

  ENTITIES: ['quay1', 'aqua'],

  // Per-entity company info used by the contract + email builders.
  COMPANY: {
    quay1: { name: 'Quay 1', full: 'Quay 1 Properties', kicker: 'Broker Agreement' },
    aqua: { name: 'Aqua Promotions', full: 'Aqua Promotions (Pty) Ltd', kicker: 'Memorandum of Agreement' },
  },

  // Quay 1 brand palette. Both entities' live emails use navy + gold (see RESEARCH 2.7); the
  // frontend Aqua-gold surface theme is a UI decision, not used by these transactional emails.
  BRAND: {
    navy: '#3D5BA6', navyDark: '#2E477F', gold: '#FDC503', goldInk: '#2A2100',
    ink: '#1F2A44', slate: '#4B4636', paper: '#EEF3FA', muted: '#7A7358',
    green: '#1E7A46', greenT: '#E6F4EA', greenB: '#B7DEC9',
    amber: '#8A6D1B', amberT: '#FFF8E6', red: '#B42318',
  },

  // Tab names on the shared tracker Sheet (mirror docs/CONTRACTS.md).
  TAB: {
    ONBOARDING: 'Onboarding',
    PROVISION_QUEUE: 'Provisioning Queue',
    OFFBOARD_QUEUE: 'Offboarding Queue',
  },

  // Enum vocabulary (mirror docs/CONTRACTS.md section 5). Import these exact strings.
  SYSTEMS: ['google', 'propdata', 'property24', 'cma', 'dialfire', 'hubspot'],
  WORKER_SYSTEMS: ['property24', 'cma', 'dialfire'],
  INLINE_SYSTEMS: ['google', 'propdata'],
  ACTIONS: ['create', 'deactivate'],
  QUEUE_STATUS: ['pending', 'in_progress', 'done', 'error', 'skipped'],
  OFFB_STATUS: ['scheduled', 'firing', 'done', 'error'],

  // Systems provisioned by DEFAULT for a new hire per entity (RESEARCH 1.4 flags the program
  // -> system mapping as the architect's call; this is that decision). Property24 auto-links on
  // Google login but we still create it explicitly. Aqua contractors get Google only by default.
  CORE_SYSTEMS: {
    quay1: ['google', 'propdata', 'property24'],
    aqua: ['google'],
  },
  // Broker-facing program toggle -> lifecycle SYSTEM (RESEARCH 1.4). Only these two overlap the
  // SYSTEMS enum; whatsapp / training / other are informational and enqueue no provisioning row.
  PROGRAM_SYSTEM: { cma: 'cma', dialfire: 'dialfire' },

  // Internal recipient lists (internal @quay1 addresses, not secrets; matches live Aqua CONFIG).
  ALWAYS_CC: ['pagan@quay1.co.za', 'kat@quay1.co.za', 'alan@quay1.co.za', 'lieze@quay1.co.za'],
  INTERNAL_NOTIFY: ['pagan@quay1.co.za', 'kat@quay1.co.za', 'alan@quay1.co.za', 'lieze@quay1.co.za'],
  SYSTEM_PROVISION_TO: ['pagan@quay1.co.za', 'kat@quay1.co.za'],

  MAX_ATTEMPTS: 3,
  OFFBOARD_DELAY_MIN: 30,
  // A row still in 'firing' this many minutes after its fire_at is treated as stuck
  // (interrupted mid-fire) and re-fired idempotently by reapOffboarding_.
  OFFBOARD_FIRING_STALE_MIN: 15,

  // Default hours-of-work clause text (verbatim from the live Aqua template).
  DEFAULT_WORK_HOURS: "08:00 to 17:00 from Monday to Friday and include a 30 (thirty) minute's lunch break each day, full time",
};

// ---------------------------------------------------------------- property access

function _scriptProps_() { return PropertiesService.getScriptProperties(); }

/** Read one Script Property. When required and missing/empty, throw a clear error. */
function prop_(key, required) {
  var v = _scriptProps_().getProperty(key);
  v = (v == null) ? '' : String(v);
  if (required && !v) {
    throw new Error('Missing required Script Property: ' + key + '. Run the matching setup* function.');
  }
  return v;
}

/** Read one Script Property or '' if unset (never throws). */
function optProp_(key) { return prop_(key, false); }

/** Read a feature flag. '1' or 'true' (any case) => true; unset => dflt. */
function flag_(name, dflt) {
  var v = _scriptProps_().getProperty(name);
  if (v == null || v === '') return !!dflt;
  return v === '1' || /^true$/i.test(String(v));
}

/** DRY_RUN defaults ON (safe) when unset - nothing mutates a live system unless armed. */
function DRY_RUN_() {
  var v = _scriptProps_().getProperty(FLAG.DRY_RUN);
  if (v == null || v === '') return true;
  return v === '1' || /^true$/i.test(String(v));
}

function offboardArmed_() { return flag_(FLAG.OFFBOARD_ARMED, false); }
function hubspotSeatEnabled_() { return flag_(FLAG.HUBSPOT_SEAT_ENABLED, false); }
function propdataLive_() { return flag_(FLAG.PROPDATA_LIVE, false); }

// ---------------------------------------------------------------- sheet access

/** The shared tracker Spreadsheet (by TRACKER_SHEET_ID). Throws if unset. */
function sheet_() {
  return SpreadsheetApp.openById(prop_(PROP.TRACKER_SHEET_ID, true));
}

/** A tab on the tracker by name. Throws if the tab is missing (run setupHub). */
function tab_(name) {
  var sh = sheet_().getSheetByName(name);
  if (!sh) throw new Error('Tracker tab not found: "' + name + '". Run setupHub() to create tabs.');
  return sh;
}

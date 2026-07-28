// Loads real apps-script/*.js files into an isolated vm context seeded with the
// GAS service mocks, so the node harness can call the ACTUAL backend functions
// (Config.js, Util.js, Auth.js today; the queue/offboarding modules once they are
// implemented) without a live Google environment.
//
// Apps Script files declare top-level `function foo(){}` and `var X = ...`; run in
// a vm context these attach to the context's global object, so after loading we
// can read ctx.CFG, ctx.uid_, ctx.plusMinutesIso_, etc. directly.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { buildServices } = require('./gas_mocks');

const APPS_DIR = path.join(__dirname, '..', 'apps-script');

// Which apps-script files actually contain executable code (not doc-only stubs).
// A file with zero non-comment lines is a design stub; loading it is a harmless
// no-op, but we surface the distinction so the harness can report BLOCKED items.
function classifyFiles() {
  const out = { implemented: [], stubs: [] };
  for (const f of fs.readdirSync(APPS_DIR).filter((x) => x.endsWith('.js')).sort()) {
    const src = fs.readFileSync(path.join(APPS_DIR, f), 'utf8');
    const codeLines = src.split('\n').filter((l) => {
      const t = l.trim();
      return t && !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*') && t !== '*/';
    });
    (codeLines.length ? out.implemented : out.stubs).push(f);
  }
  return out;
}

// Build a context, seed the GAS mocks, and run the given files (default: all).
// Returns { ctx, calls, sheets, getSheet, scriptProps, loaded, classify }.
function loadGas({ files = null, dryRun = true, props = {}, authUser = null } = {}) {
  const built = buildServices({ dryRun, props, authUser });
  const ctx = vm.createContext(Object.assign({}, built.services));
  const classify = classifyFiles();
  const toLoad = files || classify.implemented; // by default only run real code
  const loaded = [];
  for (const f of toLoad) {
    const p = path.join(APPS_DIR, f);
    const src = fs.readFileSync(p, 'utf8');
    vm.runInContext(src, ctx, { filename: p });
    loaded.push(f);
  }
  return {
    ctx,
    calls: built.calls,
    sheets: built.sheets,
    getSheet: built.getSheet,
    scriptProps: built.scriptProps,
    loaded,
    classify,
  };
}

// Default Script Properties that let Config.sheet_()/prop_() run without throwing.
const DEFAULT_PROPS = {
  TRACKER_SHEET_ID: 'MOCK_SHEET_ID',
  SUPABASE_URL: 'https://mock.supabase.co',
  SUPABASE_ANON_KEY: 'mock-anon',
  WEBAPP_URL: 'https://script.google.com/mock/exec',
};

module.exports = { loadGas, classifyFiles, DEFAULT_PROPS, APPS_DIR };

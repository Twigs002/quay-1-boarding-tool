// Offline node harness for the Apps Script backend (TEST items #1 node-side, #3, #4).
//
// Loads the REAL implemented apps-script/*.js into a vm context seeded with GAS
// service mocks (tests/load_gas.js) and exercises actual backend functions with
// no live Google environment. Doc-only stub modules (Router/Provisioning/
// Offboarding/... while unimplemented) expose no functions; the harness DETECTS
// their absence and marks those checks BLOCKED - it never fakes a pass.
//
// Sections:
//   A. Queue column contract: Queue.PQ_COL/OQ_COL + PQ_HEADERS/OQ_HEADERS match
//      the canonical contract (tests/contracts.json) field-for-field and order.
//   B. Backend writer <-> worker reader cross-check: Queue.js (backend, 0-based)
//      and worker sheets.py (1-based) both resolve to the SAME field order. This
//      is the single most important test - a drift silently corrupts the bus.
//   C. Live writer behavior: run enqueueProvision_ + writeOffboard_ and assert
//      each input field lands in its exact CONTRACTS column in the appended row.
//   D. Config enums + safety flags + Util helpers (real runtime).
//   E. Offboarding +30min trigger, idempotent re-fire, DRY_RUN suppression -
//      these live in the still-stubbed Provisioning/Offboarding; BLOCKED-detected.
//
// Run:  node tests/node_harness.js     (exit 0 = pass, 1 = failure, blocked != fail)

const fs = require('fs');
const path = require('path');
const contracts = require('./contracts');
const { loadGas, DEFAULT_PROPS, APPS_DIR } = require('./load_gas');

const FAIL = [];
const BLOCKED = [];

function check(cond, label) {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}`);
  if (!cond) FAIL.push(label);
}
function blocked(label, why) {
  console.log(`  [BLOCKED] ${label}  (${why})`);
  BLOCKED.push(`${label} - ${why}`);
}

// ---- worker column map (parsed from worker/sheets.py so we compare the two real
//      writers/readers, not a transcription) ---------------------------------
function workerColOrder(mapName) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'worker', 'sheets.py'), 'utf8');
  const block = src.split(mapName + ' = {')[1].split('}')[0];
  const pairs = [];
  block.replace(/"(\w+)"\s*:\s*(\d+)/g, (_, name, idx) => { pairs[Number(idx) - 1] = name; return ''; });
  return pairs;
}

function backendColOrder(colMap) {
  const order = [];
  for (const [name, idx] of Object.entries(colMap)) order[idx] = name;
  return order;
}

function main() {
  console.log('=== apps-script backend offline harness ===');

  // Pre-create the queue tabs so tab_() resolves, then load implemented modules.
  const gas = loadGas({ props: DEFAULT_PROPS, dryRun: true });
  const { ctx, calls, getSheet } = gas;
  getSheet('Provisioning Queue');
  getSheet('Offboarding Queue');
  getSheet('Onboarding');

  console.log(`implemented: ${gas.classify.implemented.join(', ')}`);
  console.log(`STILL STUBS: ${gas.classify.stubs.join(', ')}`);

  // ---------------------------------------------------------------- A
  console.log('A. Queue column contract (backend Queue.js vs canonical contract)');
  const pqOrder = backendColOrder(ctx.PQ_COL);
  const oqOrder = backendColOrder(ctx.OQ_COL);
  check(JSON.stringify(pqOrder) === JSON.stringify(contracts.PROVISIONING_QUEUE_COLUMNS),
    `PQ_COL order == contract A..N (${pqOrder.length} cols)`);
  check(JSON.stringify(oqOrder) === JSON.stringify(contracts.OFFBOARDING_QUEUE_COLUMNS),
    `OQ_COL order == contract A..K (${oqOrder.length} cols)`);
  check(JSON.stringify(ctx.PQ_HEADERS) === JSON.stringify(contracts.PROVISIONING_QUEUE_COLUMNS),
    'PQ_HEADERS == contract provisioning columns');
  check(JSON.stringify(ctx.OQ_HEADERS) === JSON.stringify(contracts.OFFBOARDING_QUEUE_COLUMNS),
    'OQ_HEADERS == contract offboarding columns');

  // ---------------------------------------------------------------- B
  console.log('B. Backend writer <-> worker reader cross-check (both vs one canon)');
  const wProv = workerColOrder('PROV_COLS');
  const wOffb = workerColOrder('OFFB_COLS');
  check(JSON.stringify(wProv) === JSON.stringify(pqOrder),
    'worker PROV_COLS order === backend PQ_COL order (field-for-field)');
  check(JSON.stringify(wOffb) === JSON.stringify(oqOrder),
    'worker OFFB_COLS order === backend OQ_COL order (field-for-field)');
  check(JSON.stringify(wProv) === JSON.stringify(contracts.PROVISIONING_QUEUE_COLUMNS),
    'worker PROV_COLS === canonical contract (closes the triangle)');

  // ---------------------------------------------------------------- C
  console.log('C. Live writer: enqueueProvision_ / writeOffboard_ land fields in the right columns');
  if (typeof ctx.enqueueProvision_ === 'function') {
    const qid = ctx.enqueueProvision_({
      folderId: 'FID1', full_name: 'Jane Doe', first_name: 'Jane', id_number: '9001010000000',
      quay_email: 'jane@quay1.co.za', cell: '0820000000', system: 'property24', action: 'create',
      payload: { branch: 'CT' }, status: 'pending',
    });
    const pqSheet = getSheet('Provisioning Queue');
    const row = pqSheet._rows[pqSheet._rows.length - 1]; // last appended
    const C = ctx.PQ_COL;
    check(/^PQ-FID1-property24-/.test(qid) && row[C.queue_id] === qid,
      `queue_id generated in CONTRACTS format (${qid})`);
    check(row[C.folderId] === 'FID1', 'folderId -> col B');
    check(row[C.full_name] === 'Jane Doe', 'full_name -> col C');
    check(row[C.first_name] === 'Jane', 'first_name -> col D');
    check(row[C.id_number] === '9001010000000', 'id_number -> col E (leading-zero safe as text)');
    check(row[C.quay_email] === 'jane@quay1.co.za', 'quay_email -> col F');
    check(row[C.cell] === '0820000000', 'cell -> col G');
    check(row[C.system] === 'property24', 'system -> col H');
    check(row[C.action] === 'create', 'action -> col I');
    check(row[C.payload_json] === JSON.stringify({ branch: 'CT' }), 'payload_json -> col J');
    check(row[C.status] === 'pending', 'status -> col K (worker system => pending)');
    check(String(row[C.attempts]) === '0', 'attempts -> col M starts 0');
    check(!!row[C.updated_at], 'updated_at -> col N stamped');
  } else {
    blocked('enqueueProvision_ live write', 'Queue.enqueueProvision_ not defined');
  }

  if (typeof ctx.writeOffboard_ === 'function') {
    const now = ctx.nowIso_();
    const fireAt = ctx.plusMinutesIso_(now, ctx.CFG.OFFBOARD_DELAY_MIN);
    const offbId = ctx.writeOffboard_({
      full_name: 'Jane Doe', quay_email: 'jane@quay1.co.za', requested_by: 'boss@quay1.co.za',
      requested_at: now, fire_at: fireAt,
    });
    const oqSheet = getSheet('Offboarding Queue');
    const row = oqSheet._rows[oqSheet._rows.length - 1];
    const O = ctx.OQ_COL;
    check(/^OFF-/.test(offbId) && row[O.offb_id] === offbId, `offb_id in OFF- format (${offbId})`);
    check(row[O.quay_email] === 'jane@quay1.co.za', 'quay_email -> col C');
    check(row[O.requested_by] === 'boss@quay1.co.za', 'requested_by -> col D');
    check(row[O.fire_at] === fireAt, 'fire_at -> col F');
    const delta = (new Date(row[O.fire_at]) - new Date(row[O.requested_at])) / 60000;
    check(Math.round(delta) === 30, `fire_at == requested_at + 30 min (delta ${delta.toFixed(2)})`);
    check(row[O.status] === 'scheduled', 'status -> col H = scheduled');
    const sys = JSON.parse(row[O.systems_json]);
    check(JSON.stringify(sys) === JSON.stringify(contracts.OFFBOARDING_SYSTEMS_DEFAULT),
      'systems_json default == 6-system default incl. hubspot');
  } else {
    blocked('writeOffboard_ live write', 'Queue.writeOffboard_ not defined');
  }

  // ---------------------------------------------------------------- D
  console.log('D. Config enums + safety flags + Util helpers (real runtime)');
  const eqSet = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  check(eqSet(ctx.CFG.SYSTEMS, contracts.SYSTEMS_MASTER), 'CFG.SYSTEMS == master vocab (6, incl hubspot)');
  check(eqSet(ctx.CFG.WORKER_SYSTEMS, contracts.WORKER_SYSTEMS), 'CFG.WORKER_SYSTEMS matches contract');
  check(eqSet(ctx.CFG.INLINE_SYSTEMS, contracts.INLINE_SYSTEMS), 'CFG.INLINE_SYSTEMS matches contract');
  check(eqSet(ctx.CFG.ACTIONS, contracts.PROVISIONING_ACTIONS), 'CFG.ACTIONS matches contract');
  check(eqSet(ctx.CFG.QUEUE_STATUS, contracts.PROVISIONING_STATUS), 'CFG.QUEUE_STATUS matches contract');
  check(eqSet(ctx.CFG.OFFB_STATUS, contracts.OFFBOARDING_STATUS), 'CFG.OFFB_STATUS matches contract');
  check(ctx.CFG.MAX_ATTEMPTS === contracts.MAX_ATTEMPTS_DEFAULT, 'CFG.MAX_ATTEMPTS == 3');
  check(ctx.CFG.OFFBOARD_DELAY_MIN === 30, 'CFG.OFFBOARD_DELAY_MIN == 30');
  check(ctx.DRY_RUN_() === true, 'DRY_RUN_() defaults ON (safe)');
  check(ctx.offboardArmed_() === false, 'offboardArmed_() defaults OFF');
  check(ctx.hubspotSeatEnabled_() === false, 'hubspotSeatEnabled_() defaults OFF (paid)');
  check(ctx.propdataLive_() === false, 'propdataLive_() defaults OFF');
  check(/^OFF-[a-z0-9]+-[a-z0-9]+$/.test(ctx.uid_('OFF')), 'uid_(OFF) matches OFF-<ts>-<rand>');
  check(ctx.firstName_('Jan van der Merwe') === 'Jan' && ctx.lastName_('Jan van der Merwe') === 'van der Merwe',
    'firstName_/lastName_ keep multi-word surnames');
  check(ctx.fmtRemuneration_('8000') === 'R8,000.00', 'fmtRemuneration_ normalises to R8,000.00');

  // ---------------------------------------------------------------- E
  console.log('E. Offboarding trigger (+30min) / idempotency / DRY_RUN suppression');
  if (typeof ctx.offboardRequest_ === 'function') {
    calls.triggers.length = 0;
    const ctxAdmin = { email: 'boss@quay1.co.za', role: { is_super: true, is_admin: true } };
    ctx.offboardRequest_({ full_name: 'Jane Doe', quay_email: 'jane@quay1.co.za' }, ctxAdmin);
    const t = calls.triggers.filter((x) => x.fn === 'fireOffboarding_');
    check(t.length === 1 && t[0].afterMs === 30 * 60 * 1000,
      'offboardRequest_ schedules exactly one fireOffboarding_ +30min trigger');
  } else {
    blocked('offboardRequest_ +30min trigger', 'Offboarding.offboardRequest_ not defined (stub)');
  }
  if (typeof ctx.fireOffboarding_ === 'function' && typeof ctx.writeOffboard_ === 'function') {
    // Seed a DUE scheduled row (fire_at in the past) so fireOffboarding_ processes it.
    const pastFire = new Date(Date.now() - 60000).toISOString();
    const offbId = ctx.writeOffboard_({
      full_name: 'Ida Idem', quay_email: 'ida@quay1.co.za', requested_by: 'boss@quay1.co.za',
      requested_at: new Date(Date.now() - 90000).toISOString(), fire_at: pastFire,
      systems: ['google', 'property24', 'hubspot'],
    });
    const pqSheet = getSheet('Provisioning Queue');
    calls.adminDirectory.length = 0;

    ctx.fireOffboarding_();                         // first fire
    const rowAfter1 = ctx.readOffboard_().find((r) => r.offb_id === offbId);
    const pqCountAfter1 = pqSheet._rows.length;
    check(rowAfter1 && rowAfter1.status === 'done', 'fireOffboarding_ takes a due row to status=done');
    const p24 = ctx.readQueue_('Provisioning Queue').filter(
      (r) => r.quay_email === 'ida@quay1.co.za' && r.system === 'property24' && r.action === 'deactivate');
    check(p24.length === 1, 'one property24 deactivate row enqueued for the worker');
    const liveSuspend = calls.adminDirectory.some((c) => c.op === 'Users.update' && c.user && c.user.suspended === true);
    check(!liveSuspend, 'OFFBOARD_ARMED off => no live Google suspend (destructive op suppressed)');

    ctx.fireOffboarding_();                         // second fire (idempotent re-fire)
    const rowAfter2 = ctx.readOffboard_().find((r) => r.offb_id === offbId);
    check(rowAfter2 && rowAfter2.status === 'done', 're-fire of a done row is a no-op (status unchanged)');
    check(pqSheet._rows.length === pqCountAfter1,
      're-fire enqueues NO duplicate deactivate rows (enqueueDeactivate_ dedup guard holds)');
  } else {
    blocked('fireOffboarding_ idempotent re-fire', 'Offboarding.fireOffboarding_ not defined (stub)');
  }
  if (typeof ctx.googleCreate_ === 'function') {
    calls.adminDirectory.length = 0; calls.urlFetch.length = 0;
    ctx.googleCreate_({ full_name: 'Jane Doe', first_name: 'Jane', quay_email: '' });
    check(calls.adminDirectory.length === 0 && calls.urlFetch.length === 0,
      'DRY_RUN suppresses AdminDirectory + UrlFetch in googleCreate_');
  } else {
    blocked('DRY_RUN suppression (googleCreate_/propdataCreate_)', 'Provisioning.* not defined (stub)');
  }
  // ---------------------------------------------------------------- F
  console.log('F. Offboarding reaper (stuck-row recovery, every 15 min)');
  if (typeof ctx.reapOffboarding_ === 'function' && typeof ctx.writeOffboard_ === 'function') {
    const pqSheet = getSheet('Provisioning Queue');
    // (a) a 'scheduled' row that is due but never fired (lost one-shot trigger).
    const stuckId = ctx.writeOffboard_({
      full_name: 'Stan Stuck', quay_email: 'stan@quay1.co.za', requested_by: 'boss@quay1.co.za',
      requested_at: new Date(Date.now() - 90000).toISOString(),
      fire_at: new Date(Date.now() - 60000).toISOString(), systems: ['google', 'property24'],
    });
    const pqBefore = pqSheet._rows.length;
    ctx.reapOffboarding_();
    const reaped = ctx.readOffboard_().find((r) => r.offb_id === stuckId);
    check(reaped && reaped.status === 'done', 'reaper drives a due-but-unfired scheduled row to done');
    check(pqSheet._rows.length > pqBefore, 'reaper enqueued the browser-system deactivate row');
    const pqAfter = pqSheet._rows.length;
    ctx.reapOffboarding_();                          // idempotent re-sweep
    const reaped2 = ctx.readOffboard_().find((r) => r.offb_id === stuckId);
    check(reaped2 && reaped2.status === 'done' && pqSheet._rows.length === pqAfter,
      'reaper re-sweep is idempotent (no status flip, no duplicate deactivate)');

    // (b) an 'error' row: reaper drafts a one-time alert, never auto-retries, never sends.
    const draftsBefore = calls.emailsDrafted.length;
    const errId = ctx.writeOffboard_({
      full_name: 'Erin Error', quay_email: 'erin@quay1.co.za', requested_by: 'boss@quay1.co.za',
      requested_at: new Date().toISOString(), fire_at: new Date().toISOString(), systems: ['google'],
    });
    ctx.setOffboardStatus_(errId, 'error', { error: 'partial teardown' });
    ctx.reapOffboarding_();
    const errRow = ctx.readOffboard_().find((r) => r.offb_id === errId);
    check(errRow && errRow.status === 'error', 'reaper does NOT auto-retry an error row (stays error)');
    check(calls.emailsDrafted.length > draftsBefore, 'reaper DRAFTS a manual-completion alert for the error row');
  } else {
    blocked('reapOffboarding_ recovery', 'Offboarding.reapOffboarding_ not defined');
  }

  // never-auto-send invariant (any implemented path)
  check(calls.emailsSent.length === 0, 'no email was auto-SENT during the run (never-auto-send)');

  // ---------------------------------------------------------------- summary
  console.log();
  if (BLOCKED.length) {
    console.log(`BLOCKED (backend not yet implemented) x${BLOCKED.length}:`);
    BLOCKED.forEach((b) => console.log(`  - ${b}`));
  }
  if (FAIL.length) {
    console.log(`\nRESULT: FAIL (${FAIL.length})`);
    FAIL.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }
  console.log(`\nRESULT: PASS for implemented modules (${BLOCKED.length} checks BLOCKED on backend stubs)`);
  process.exit(0);
}

main();

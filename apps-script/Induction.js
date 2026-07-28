/**
 * Induction.js - Quay 1 induction booking, the per-candidate progress report, and the Tuesday
 * digest. Quay 1 only (Aqua has no induction step).
 *
 * Owner: backend. induction_wed / induction_thu columns live on the Onboarding row (Tracker.js).
 *
 * bookInduction_ is TOKEN-LESS (candidate-facing, folderId-gated) per the router dispatch table
 * and the live Quay1 induction.html flow (RESEARCH 1.1). It does not require an admin role; the
 * unguessable folderId is the credential.
 *
 * Public surface:
 *   bookInduction_(body)         - {ok, wed, thu}   set induction dates from body.weekMonday.
 *   inductionLookup_(folderId)   - {ok, firstName, booked, induction}   doGet ?i= support.
 *   progressReport_(folderId)    - {ok, html}   per-candidate onboarding progress summary.
 *   tuesdayDigest_()             - void   TIME-TRIGGER target. Auto-send permitted (scoped).
 *
 * The temp password from provisioning is included ONLY in the induction email packet (email,
 * never WhatsApp) per SPEC section 4 - surfaced by whoever composes that packet, not here.
 */

/** Book the induction week. body = { folderId, weekMonday:'YYYY-MM-DD' }. Token-less. */
function bookInduction_(body) {
  var folderId = String((body && body.folderId) || '');
  if (!folderId) return { ok: false, error: 'missing reference' };
  var meta = readOnboardingByFolder_(folderId);
  if (!meta) return { ok: false, error: 'not_found' };

  var monday = _asDate_(body && body.weekMonday);
  if (!monday) return { ok: false, error: 'a valid weekMonday (YYYY-MM-DD) is required' };

  var wed = _isoDate_(_addDays_(monday, 2));
  var thu = _isoDate_(_addDays_(monday, 3));
  setInduction_(folderId, wed, thu);
  return { ok: true, wed: wed, thu: thu };
}

/** Candidate-page lookup for the induction booking status (doGet ?i=<folderId>). */
function inductionLookup_(folderId) {
  var meta = readOnboardingByFolder_(folderId);
  if (!meta) return { ok: false, error: 'not_found' };
  var booked = !!(meta.induction_wed || meta.induction_thu);
  return {
    ok: true, firstName: firstName_(meta.name), booked: booked,
    induction: { wed: meta.induction_wed || '', thu: meta.induction_thu || '' },
  };
}

/** Per-candidate progress summary (contract, FICA ticks, induction, provisioning states). */
function progressReport_(folderId) {
  var o = readOnboardingByFolder_(folderId);
  if (!o) return { ok: false, error: 'not_found' };
  var fica = ficaStatus_(folderId);
  var prov = readQueue_(CFG.TAB.PROVISION_QUEUE).filter(function (r) { return r.folderId === folderId; });
  var provBySystem = {};
  prov.forEach(function (r) { provBySystem[r.system] = r.status; });

  var row = function (label, val) {
    return '<tr><td style="padding:4px 14px 4px 0;color:#7A7358;font-size:13px">' + htmlEsc_(label) +
      '</td><td style="padding:4px 0;font-size:14px;font-weight:600">' + htmlEsc_(val) + '</td></tr>';
  };
  var yn = function (b) { return b ? 'Received' : 'Outstanding'; };
  var html =
    '<table role="presentation" cellpadding="0" cellspacing="0" style="font-family:Montserrat,Arial,sans-serif">' +
      row('Name', o.name) + row('Status', o.status) +
      row('FICA ID', yn(fica.id)) + row('FICA POA', yn(fica.poa)) + row('FICA bank', yn(fica.bank)) +
      row('FICA contract', yn(fica.contract)) + row('FICA NDA', yn(fica.nda)) +
      row('Induction', (o.induction_wed || '') + (o.induction_thu ? ' / ' + o.induction_thu : '')) +
      Object.keys(provBySystem).map(function (s) { return row('Provision ' + s, provBySystem[s]); }).join('') +
    '</table>';
  return { ok: true, html: html };
}

/**
 * Tuesday digest of Quay1 candidates and their induction status. Auto-send is permitted for this
 * scoped onboarding-pipeline digest (SPEC section 6). Installed via setupTriggers() (Setup.js).
 */
function tuesdayDigest_() {
  var weekStart = _mondayOfThisWeek_();
  var weekEnd = _addDays_(weekStart, 6);
  var buckets = { dueThisWeek: [], unbooked: [] };
  listOnboarding_(function (o) { return o.entity === 'quay1'; }).forEach(function (o) {
    var wed = _asDate_(o.induction_wed);
    if (wed && wed >= weekStart && wed <= weekEnd) buckets.dueThisWeek.push(o);
    else if (!o.induction_wed && !o.induction_thu) buckets.unbooked.push(o);
  });
  var company = CFG.COMPANY.quay1;
  var to = CFG.INTERNAL_NOTIFY.filter(function (x) { return x; }).join(',');
  var subject = company.name + ' - induction digest (' + buckets.dueThisWeek.length +
    ' booked, ' + buckets.unbooked.length + ' awaiting)';
  GmailApp.sendEmail(to, subject,
    'Induction status. Booked this week: ' + buckets.dueThisWeek.length +
    '. Awaiting booking: ' + buckets.unbooked.length + '.',
    { name: company.name, htmlBody: inductionDigestHtml_(company, buckets) });
}

// ---------------------------------------------------------------- date helpers

function _addDays_(d, n) { return new Date(d.getTime() + n * 24 * 60 * 60 * 1000); }

function _isoDate_(d) {
  var mm = ('0' + (d.getMonth() + 1)).slice(-2);
  var dd = ('0' + d.getDate()).slice(-2);
  return d.getFullYear() + '-' + mm + '-' + dd;
}

function _mondayOfThisWeek_() {
  var now = new Date();
  var day = now.getDay(); // 0 Sun .. 6 Sat
  var diff = (day === 0 ? -6 : 1 - day); // back to Monday
  var mon = _addDays_(now, diff);
  return new Date(mon.getFullYear(), mon.getMonth(), mon.getDate());
}

/**
 * Router.js - the only HTTP surface. doGet/doPost live here and nowhere else. Parses the
 * text/plain body (no-preflight pattern), builds the auth context, and dispatches by {kind}.
 *
 * Owner: backend. See docs/SPEC.md section 2 and docs/ARCHITECTURE.md section 3.
 *
 * POST body (Content-Type text/plain to dodge CORS preflight). The JWT field is `accessToken`:
 *   { kind: "...", accessToken: "<supabase jwt>", ...fields }
 *
 * Dispatch table. Candidate kinds are token-less (folderId-gated) and handled BEFORE auth;
 * admin kinds resolve the auth context first (each handler asserts its own role):
 *   fica_upload / candidate_upload -> Fica.ficaUpload_(body)          [token-less]
 *   book_induction                 -> Induction.bookInduction_(body)  [token-less]
 *   onboard_quay1                  -> Onboarding_Quay1.onboardQuay1_(body, ctx)   [onboarder: super/admin/broker]
 *   onboard_aqua                   -> Onboarding_Aqua.onboardAqua_(body, ctx)     [onboarder: super/admin/broker]
 *   provision                      -> Provisioning.provisionAll_(folderId, systems, ctx) [admin]
 *   offboard                       -> Offboarding.offboardRequest_(body, ctx)     [admin]
 *   status                         -> Queue.readForUi_(ctx)           [authed, role-scoped]
 *   retry                          -> Queue.retryRow_(queue_id, ctx)  [super]
 *
 * doGet routes: FICA form (?f=<folderId> -> HTML), induction lookup (?i=<folderId> -> JSON),
 * and a health ping (default). Both candidate links are generated server-side, so the query
 * contract (?f= vs ?i=) is owned here.
 *
 * Every handler returns a plain object; Router wraps it with jsonOut_. Errors are caught and
 * returned as { ok:false, error } with a 200 body (the frontend reads the ok flag).
 */

var TOKENLESS_KINDS = { fica_upload: true, candidate_upload: true, book_induction: true };

function doGet(e) {
  try {
    var p = (e && e.parameter) || {};
    if (p.f) return ficaForm_(String(p.f));                 // candidate FICA upload page (HTML)
    if (p.i) return jsonOut_(inductionLookup_(String(p.i))); // candidate induction status (JSON)
    return textOut_('ok'); // health ping
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  try {
    var body = parseBody_(e);
    var kind = String(body.kind || '');

    // Token-less candidate paths run BEFORE any auth (gated by the unguessable folderId).
    if (TOKENLESS_KINDS[kind]) {
      return jsonOut_(dispatchTokenless_(kind, body));
    }

    var ctx = authContext_(body); // throws 'unauthorized' when the JWT is missing/invalid
    return jsonOut_(dispatch_(kind, body, ctx));
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

/** Parse the text/plain JSON body. Throws on a malformed / empty body. */
function parseBody_(e) {
  if (!e || !e.postData || !e.postData.contents) throw new Error('empty request body');
  var body = safeJsonParse_(e.postData.contents, null);
  if (!body || typeof body !== 'object') throw new Error('malformed request body');
  return body;
}

/** Token-less candidate handlers (no auth context). */
function dispatchTokenless_(kind, body) {
  if (kind === 'fica_upload' || kind === 'candidate_upload') return ficaUpload_(body);
  if (kind === 'book_induction') return bookInduction_(body);
  return { ok: false, error: 'unknown candidate action: ' + kind };
}

/** Authenticated dispatch. Each handler asserts its own role via requireAdmin_/requireSuper_. */
function dispatch_(kind, body, ctx) {
  switch (kind) {
    case 'onboard_quay1': return onboardQuay1_(body, ctx);
    case 'onboard_aqua': return onboardAqua_(body, ctx);
    case 'provision': return _provisionDispatch_(body, ctx);
    case 'offboard': return offboardRequest_(body, ctx);
    case 'status': return readForUi_(ctx);
    case 'retry': return retryRow_(String(body.queue_id || ''), ctx);
    default: return { ok: false, error: 'unknown action: ' + kind };
  }
}

/** Manual (re)provision: an explicit systems list wins; else resolve from the Onboarding row. */
function _provisionDispatch_(body, ctx) {
  requireAdmin_(ctx);  // standalone re-provision is admin-only (inline onboard provisioning is gated by requireOnboarder_)
  var folderId = String(body.folderId || '');
  if (!folderId) return { ok: false, error: 'folderId is required' };
  var systems = _provisionList_(body, body);
  if (!systems) {
    var o = readOnboardingByFolder_(folderId);
    if (!o) return { ok: false, error: 'onboarding row not found' };
    systems = resolveSystems_(o.entity || 'quay1', o.programs, null, o.team);
  }
  return provisionAll_(folderId, systems, ctx);
}

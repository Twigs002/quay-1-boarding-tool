/* Quay 1 Boarding Tool - Offboard view (split out of app.js to keep that file
 * under the 500-line cap). Behaviour is identical to the original in-file
 * version; it reaches app.js's shared helpers + mutable state via window.HUB
 * (see the HUB block in app.js). Loaded AFTER app.js so window.HUB exists.
 *
 * Section 3 of the SPA: pick a person, confirm, POST kind:'offboard'. The
 * backend fires the teardown +30 min, no cancel (CONTRACTS section 8.5).
 */
(() => {
  'use strict';
  const H = window.HUB;
  if (!H) throw new Error('app.offboard.js loaded before app.js (window.HUB missing)');
  const { $, esc, el, api, toast, KINDS } = H;
  const DELAY = H.OFFBOARD_DELAY_MIN;

  function viewOffboard(root) {
    const user = H.getUser();
    const canWrite = user && user.canWrite;
    const wrap = el(`<div class="stack">
      <div class="section-head">
        <h2>Offboard a person</h2>
        <p>Suspend the Google account, remove group and Drive access, release the HubSpot seat, and tear down the browser-portal logins. This fires automatically ${DELAY} minutes after you submit, with no cancel window.</p>
      </div>
      <div class="card card-pad stack">
        ${canWrite ? '' : '<div class="notice warn">Only a super or admin can submit an offboarding request.</div>'}
        <form id="offbForm" novalidate>
          <div class="form-grid">
            <div class="field">
              <label for="of_name">Full name <span class="req" aria-hidden="true">*</span></label>
              <input id="of_name" name="full_name" list="peopleList" aria-required="true" autocomplete="off" placeholder="Start typing a name">
              <span class="hint">Pick from the provisioning list, or type the name.</span>
              <span class="field-err" id="ofe_full_name"></span>
            </div>
            <div class="field">
              <label for="of_email">Quay email <span class="req" aria-hidden="true">*</span></label>
              <input id="of_email" name="quay_email" type="email" aria-required="true" autocomplete="off" placeholder="name@quay1.co.za">
              <span class="field-err" id="ofe_quay_email"></span>
            </div>
          </div>
          <datalist id="peopleList"></datalist>
          <div class="form-actions">
            <button type="submit" class="btn btn-danger" id="ofSubmit" ${canWrite ? '' : 'disabled'}>Review offboarding</button>
          </div>
        </form>
        <div id="offbConfirm"></div>
      </div>
    </div>`);
    root.appendChild(wrap);
    populatePeople(wrap);

    const form = $('#offbForm', wrap);
    // Autofill the email when a known person is picked.
    $('#of_name', wrap).addEventListener('change', (e) => {
      const match = H.getStatusCache().find((r) => (r.full_name || r.name) === e.target.value);
      if (match && match.quay_email) $('#of_email', wrap).value = match.quay_email;
    });
    form.addEventListener('submit', (e) => { e.preventDefault(); confirmOffboard(wrap, form); });
  }

  async function populatePeople(wrap) {
    let cache = H.getStatusCache();
    try {
      if (!cache.length) { const r = await api(KINDS.status, {}); cache = r.rows || r.data || []; H.setStatusCache(cache); }
    } catch (_) { /* picker is optional; manual entry still works */ }
    const seen = new Set();
    const opts = cache.map((r) => {
      const name = r.full_name || r.name; if (!name || seen.has(name)) return ''; seen.add(name);
      return `<option value="${esc(name)}">${esc(r.quay_email || '')}</option>`;
    }).join('');
    const dl = $('#peopleList', wrap); if (dl) dl.innerHTML = opts;
  }

  function confirmOffboard(wrap, form) {
    const user = H.getUser();
    const name = $('#of_name', wrap).value.trim();
    const email = $('#of_email', wrap).value.trim();
    let bad = false;
    [['full_name', name], ['quay_email', email]].forEach(([k, v]) => {
      const errEl = $('#ofe_' + k, wrap); const missing = !v;
      if (errEl) errEl.textContent = missing ? 'Required.' : '';
      const input = wrap.querySelector(`[name="${k}"]`);
      if (input) input.setAttribute('aria-invalid', missing ? 'true' : 'false');
      if (missing) bad = true;
    });
    if (bad) return;

    const fireAt = new Date(Date.now() + DELAY * 60 * 1000);
    const hhmm = fireAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const host = $('#offbConfirm', wrap);
    host.innerHTML = '';
    const panel = el(`<div class="stack">
      <hr class="rule">
      <div class="offb-summary">
        <dl>
          <dt>Person</dt><dd>${esc(name)}</dd>
          <dt>Quay email</dt><dd>${esc(email)}</dd>
          <dt>Requested by</dt><dd>${esc(user ? user.name : '')}</dd>
        </dl>
      </div>
      <div class="fire-banner">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>
        <span>This will fire at <strong>${esc(hhmm)}</strong>, in ${DELAY} minutes. There is no cancel window once you confirm. All linked accounts will be deactivated.</span>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-danger" id="ofGo">Confirm offboarding</button>
        <button type="button" class="btn btn-ghost" id="ofCancel">Cancel</button>
      </div>
    </div>`);
    host.appendChild(panel);
    $('#ofGo', panel).focus();
    $('#ofCancel', panel).addEventListener('click', () => { host.innerHTML = ''; $('#of_name', wrap).focus(); });
    $('#ofGo', panel).addEventListener('click', () => submitOffboard(wrap, panel, { name, email }));
  }

  async function submitOffboard(wrap, panel, who) {
    const user = H.getUser();
    const btn = $('#ofGo', panel);
    btn.classList.add('loading'); btn.disabled = true;
    try {
      const r = await api(KINDS.offboard, {
        full_name: who.name, quay_email: who.email,
        requested_by: user ? user.email : '', requested_by_name: user ? user.name : '',
      });
      const at = r && r.fire_at ? new Date(r.fire_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : new Date(Date.now() + DELAY * 60 * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      panel.innerHTML = `<hr class="rule">
        <div class="fire-banner"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>
        <span>Offboarding scheduled for <strong>${esc(who.name)}</strong>. It will fire at <strong>${esc(at)}</strong>, in ${DELAY} minutes. No cancel.</span></div>`;
      toast('Offboarding scheduled', `${who.name} will be deactivated at ${at}.`, 'ok');
      $('#offbForm', wrap).reset();
    } catch (err) {
      toast('Could not schedule', err.message, 'err');
      btn.classList.remove('loading'); btn.disabled = false;
    }
  }

  H.viewOffboard = viewOffboard;
})();

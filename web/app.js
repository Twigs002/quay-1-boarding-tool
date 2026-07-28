/* Quay 1 Boarding Tool - single-page app.
 *
 * Three sections behind the Supabase JWT gate (auth.js): Onboard (contract
 * request + provisioning checkboxes, POST kind:'onboard_quay1'|'onboard_aqua'),
 * Provisioning status (live queue table, POST kind:'status', super-only retry
 * via kind:'retry') and Offboard (pick a person, confirm, POST kind:'offboard'
 * - backend fires the teardown +30 min, no cancel).
 *
 * All backend calls POST text/plain (no CORS preflight) to LIFECYCLE_ENDPOINT
 * with body { kind, accessToken, ...fields } - the Supabase JWT + payload at the
 * top level. The backend re-verifies the JWT + role on every write, so this
 * UI gate is convenience only. Kinds come from docs/ARCHITECTURE.md section 3
 * and are centralised in the KINDS const so they track one place.
 */
(() => {
  'use strict';

  const cfg = window.QUAY_CFG || {};
  const ENDPOINT = cfg.LIFECYCLE_ENDPOINT || '';

  // Router dispatch kinds (docs/ARCHITECTURE.md section 3, confirmed by
  // architect). Onboard splits by entity into two kinds. One place to retune.
  const KINDS = {
    onboardQuay1: 'onboard_quay1',
    onboardAqua: 'onboard_aqua',
    status: 'status',
    retry: 'retry',
    offboard: 'offboard',
  };

  // Provisioning systems (docs/CONTRACTS.md section 6). google/propdata/property24
  // are the core stack, checked by default. cma/dialfire are optional and
  // auto-check when the matching broker program is ticked on the Quay 1 form.
  const SYSTEMS = [
    { key: 'google',     label: 'Google Workspace', sub: 'account + groups', core: true },
    { key: 'propdata',   label: 'PropData',         sub: 'agent profile',    core: true },
    { key: 'property24', label: 'Property24',        sub: 'listing agent',    core: true },
    { key: 'cma',        label: 'CMA',               sub: 'valuation login' },
    { key: 'dialfire',   label: 'Dialfire',          sub: 'dialer seat' },
  ];

  // Broker programs on the Quay 1 form (docs/CONTRACTS.md section 6) - distinct
  // from provisioning. cma/dialfire programs auto-tick the matching system;
  // whatsapp/training/other never provision. `other` reveals a note field.
  const PROGRAMS = [
    { key: 'cma',      label: 'CMA',      system: 'cma' },
    { key: 'dialfire', label: 'Dialfire', system: 'dialfire' },
    { key: 'whatsapp', label: 'WhatsApp Business' },
    { key: 'training', label: 'Training' },
    { key: 'other',    label: 'Other', note: true },
  ];

  const OFFBOARD_DELAY_MIN = 30;

  // ── DOM helpers ───────────────────────────────────────────────────────────
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }

  let USER = null;              // logged-in staff (from AUTH.getSession)
  let statusCache = [];         // last provisioning-status rows (feeds offboard picker)

  // ── Toast ─────────────────────────────────────────────────────────────────
  function toast(title, body, kind) {
    const host = $('#toastHost');
    const node = el(`<div class="toast ${kind || ''}" role="status">
      <strong>${esc(title)}</strong>${body ? esc(body) : ''}</div>`);
    host.appendChild(node);
    setTimeout(() => { node.style.opacity = '0'; setTimeout(() => node.remove(), 250); }, 5200);
  }

  // ── API ───────────────────────────────────────────────────────────────────
  // POST text/plain so no CORS preflight fires. Body is { kind, accessToken,
  // ...fields } (docs/CONTRACTS.md section 7): the Supabase JWT rides as
  // `accessToken` and the payload fields sit at the top level alongside kind.
  async function api(kind, data) {
    if (!ENDPOINT) throw new Error('LIFECYCLE_ENDPOINT not set in config.js');
    const accessToken = await window.AUTH.getAccessToken();
    if (!accessToken) throw new Error('Session expired, sign in again.');
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ kind, accessToken }, data || {})),
    });
    let json;
    try { json = await res.json(); } catch (_) { throw new Error('Bad response from server.'); }
    if (!res.ok || json.ok === false) throw new Error(json && json.error ? json.error : 'Request failed.');
    return json;
  }

  // Shared surface for split view modules. The Offboard view lives in its own
  // file (app.offboard.js) to keep this file under the 500-line cap; it reaches
  // the shared helpers + mutable state through here. No behaviour change - the
  // getters/setters read and write the same closure variables as before.
  const HUB = (window.HUB = window.HUB || {});
  HUB.$ = $; HUB.esc = esc; HUB.el = el; HUB.api = api; HUB.toast = toast;
  HUB.KINDS = KINDS; HUB.OFFBOARD_DELAY_MIN = OFFBOARD_DELAY_MIN;
  HUB.getUser = () => USER;
  HUB.getStatusCache = () => statusCache;
  HUB.setStatusCache = (v) => { statusCache = v; };

  //  ROUTER
  const VIEWS = {
    onboard: viewOnboard, provisioning: viewProvisioning,
    offboard: (root) => window.HUB.viewOffboard(root),  // defined in app.offboard.js
  };

  function route(tab) {
    document.querySelectorAll('.tab-btn').forEach((b) => {
      const on = b.dataset.tab === tab;
      b.classList.toggle('active', on);
      if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    const main = $('#content');
    main.innerHTML = '';
    (VIEWS[tab] || viewOnboard)(main);
    main.focus({ preventScroll: true });
  }

  //  1. ONBOARD
  function viewOnboard(root) {
    let entity = 'quay1';

    const wrap = el(`<div class="stack">
      <div class="section-head">
        <h2>Onboard a new person</h2>
        <p>Generate the contract and enqueue account provisioning. Choose the entity, then complete the details. Fields marked with a red asterisk are required.</p>
      </div>
      <div class="card card-pad stack">
        <div class="seg" role="tablist" aria-label="Entity">
          <button type="button" role="tab" data-ent="quay1" class="active" aria-selected="true">Quay 1</button>
          <button type="button" role="tab" data-ent="aqua" aria-selected="false">Aqua Promotions</button>
        </div>
        <form id="onboardForm" novalidate></form>
      </div>
    </div>`);

    const form = $('#onboardForm', wrap);
    const seg = $('.seg', wrap);
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-ent]'); if (!b) return;
      entity = b.dataset.ent;
      seg.querySelectorAll('button').forEach((x) => {
        const on = x === b; x.classList.toggle('active', on); x.setAttribute('aria-selected', String(on));
      });
      renderForm();
    });

    function fieldText(name, label, opts = {}) {
      const req = opts.required ? ' <span class="req" aria-hidden="true">*</span>' : '';
      const type = opts.type || 'text';
      const cls = opts.full ? 'field full' : 'field';
      const hint = opts.hint ? `<span class="hint">${esc(opts.hint)}</span>` : '';
      return `<div class="${cls}">
        <label for="f_${name}">${esc(label)}${req}</label>
        <input id="f_${name}" name="${name}" type="${type}" ${opts.required ? 'aria-required="true"' : ''} autocomplete="off">
        ${hint}<span class="field-err" id="e_${name}" aria-live="polite"></span></div>`;
    }
    function fieldSelect(name, label, options, req) {
      const opts = options.map((o) => `<option value="${esc(o.v)}">${esc(o.t)}</option>`).join('');
      return `<div class="field">
        <label for="f_${name}">${esc(label)}${req ? ' <span class="req" aria-hidden="true">*</span>' : ''}</label>
        <select id="f_${name}" name="${name}" ${req ? 'aria-required="true"' : ''}>${opts}</select>
        <span class="field-err" id="e_${name}"></span></div>`;
    }

    function renderForm() {
      const common =
        fieldText('name', 'Full name', { required: true, full: true }) +
        fieldText('id_number', 'ID number', { required: true }) +
        fieldText('contact', 'Cell number', { required: true, type: 'tel' }) +
        fieldText('email', 'Personal email', { required: true, type: 'email', hint: 'Used to send the contract + induction pack.' }) +
        fieldText('start_date', 'Start date', { required: true, type: 'date' }) +
        fieldText('division', 'Division', {});

      const quay1 =
        // deal_type drives the 2026 v2.1G Sale vs Rental contract template.
        fieldSelect('deal_type', 'Contract type', [
          { v: 'sale', t: 'Sale' }, { v: 'rental', t: 'Rental' },
        ], true) +
        fieldText('team', 'Team', {}) +
        fieldSelect('designation', 'Designation', [
          { v: 'agent', t: 'Agent' }, { v: 'senior_agent', t: 'Senior agent' },
          { v: 'candidate', t: 'Candidate agent' }, { v: 'admin', t: 'Admin' },
        ], true) +
        fieldText('senior_name', 'Reporting senior (name)', {}) +
        fieldText('senior_email', 'Reporting senior (email)', { type: 'email' }) +
        fieldText('commission', 'Commission split', { hint: 'e.g. 50 / 60 / 70' });

      const aqua =
        fieldSelect('agreement_type', 'Agreement type', [
          { v: 'monthly', t: 'Monthly' }, { v: 'fixed', t: 'Fixed term' }, { v: 'permanent', t: 'Permanent' },
        ], true) +
        fieldText('designation', 'Role / designation', { required: true }) +
        // end_date is required for a fixed-term MOA; shown only when agreement_type=fixed.
        `<div class="field" id="endDateWrap" hidden>
          <label for="f_end_date">End date <span class="req" aria-hidden="true">*</span></label>
          <input id="f_end_date" name="end_date" type="date">
          <span class="field-err" id="e_end_date" aria-live="polite"></span></div>` +
        fieldText('work_hours', 'Work hours', { hint: 'e.g. Mon to Fri, 08:00 to 17:00' }) +
        fieldText('remuneration', 'Remuneration', { hint: 'Monthly package or rate.' });

      // Provisioning systems: core three checked by default, cma/dialfire off
      // (they auto-check from the Quay 1 programs group below).
      const systems = SYSTEMS.map((s) => `<label class="check">
        <input type="checkbox" name="sys_${s.key}" value="${s.key}" ${s.core ? 'checked' : ''}>
        <span><span class="ck-label">${esc(s.label)}</span><span class="ck-sub">${esc(s.sub)}</span></span>
      </label>`).join('');

      // Broker programs (Quay 1 only). `other` reveals a note field.
      const programs = PROGRAMS.map((p) => `<label class="check">
        <input type="checkbox" name="prog_${p.key}" value="${p.key}" data-links="${p.system || ''}">
        <span class="ck-label">${esc(p.label)}</span>
      </label>`).join('');
      const programsBlock = entity === 'aqua' ? '' : `
        <fieldset>
          <legend>Broker programs</legend>
          <div class="check-grid">${programs}</div>
          <div class="field full" id="otherNoteWrap" hidden style="margin-top:12px;">
            <label for="f_program_other_note">Other program - note</label>
            <input id="f_program_other_note" name="program_other_note" type="text" autocomplete="off">
          </div>
        </fieldset>
        <hr class="rule">`;

      const canWrite = USER && USER.canWrite;
      const gate = canWrite ? '' :
        `<div class="notice warn">You are signed in as a broker, so you can view this form but only a super or admin can submit an onboarding request.</div>`;

      form.innerHTML = `
        <div class="form-grid">${common}${entity === 'aqua' ? aqua : quay1}</div>
        <hr class="rule">
        ${programsBlock}
        <fieldset>
          <legend>Provision these systems</legend>
          <div class="check-grid">${systems}</div>
        </fieldset>
        <hr class="rule">
        ${gate}
        <div class="form-actions">
          <button type="submit" class="btn btn-primary" id="obSubmit" ${canWrite ? '' : 'disabled'}>Create contract &amp; provision</button>
          <button type="reset" class="btn btn-ghost">Clear</button>
        </div>`;

      // Toggle the is-on styling on every check card.
      form.querySelectorAll('.check input').forEach((i) => {
        const sync = () => i.closest('.check').classList.toggle('is-on', i.checked);
        sync(); i.addEventListener('change', sync);
      });
      // A cma/dialfire program mirrors its provisioning system; `other` reveals the note.
      form.querySelectorAll('input[name^="prog_"]').forEach((p) => {
        p.addEventListener('change', () => {
          const linked = p.dataset.links;
          if (linked) {
            const sys = form.querySelector(`input[name="sys_${linked}"]`);
            if (sys) { sys.checked = p.checked; sys.dispatchEvent(new Event('change')); }
          }
          if (p.value === 'other') {
            const w = $('#otherNoteWrap', form); if (w) w.hidden = !p.checked;
          }
        });
      });
      // Aqua fixed-term reveals the required end_date field.
      const agr = form.querySelector('select[name="agreement_type"]');
      if (agr) {
        const endWrap = $('#endDateWrap', form), endInput = $('#f_end_date', form);
        const syncEnd = () => {
          const fixed = agr.value === 'fixed';
          if (endWrap) endWrap.hidden = !fixed;
          if (endInput) {
            if (fixed) { endInput.setAttribute('aria-required', 'true'); }
            else { endInput.removeAttribute('aria-required'); endInput.removeAttribute('aria-invalid'); }
          }
        };
        syncEnd(); agr.addEventListener('change', syncEnd);
      }
    }

    form.addEventListener('submit', (e) => { e.preventDefault(); submitOnboard(form, entity); });
    renderForm();
    root.appendChild(wrap);
  }

  function collect(form) {
    const out = {};
    form.querySelectorAll('input, select').forEach((i) => {
      if (i.type === 'checkbox') return;
      out[i.name] = i.value.trim();
    });
    return out;
  }

  function validateOnboard(form) {
    let firstBad = null;
    form.querySelectorAll('[aria-required="true"]').forEach((i) => {
      const errEl = $('#e_' + i.name, form);
      const bad = !i.value.trim();
      i.setAttribute('aria-invalid', bad ? 'true' : 'false');
      if (errEl) errEl.textContent = bad ? 'Required.' : '';
      if (bad && !firstBad) firstBad = i;
    });
    if (firstBad) firstBad.focus();
    return !firstBad;
  }

  async function submitOnboard(form, entity) {
    if (!validateOnboard(form)) { toast('Check the form', 'Some required fields are missing.', 'err'); return; }
    const data = collect(form);
    data.entity = entity;
    // Backend reads the provisioning selection under `systems` (CONTRACTS section 6).
    data.systems = SYSTEMS.map((s) => s.key).filter((k) => form.querySelector(`input[name="sys_${k}"]`).checked);
    // Broker programs are Quay 1 only and distinct from provisioning systems.
    if (entity !== 'aqua') {
      data.programs = PROGRAMS.map((p) => p.key).filter((k) => {
        const box = form.querySelector(`input[name="prog_${k}"]`); return box && box.checked;
      });
    }
    data.requester_name = USER ? USER.name : '';
    data.requester_email = USER ? USER.email : '';

    const btn = $('#obSubmit', form);
    btn.classList.add('loading'); btn.disabled = true;
    try {
      const kind = entity === 'aqua' ? KINDS.onboardAqua : KINDS.onboardQuay1;
      const r = await api(kind, data);
      toast('Onboarding submitted', `Contract queued for ${data.name}. ${data.systems.length} system(s) to provision.`, 'ok');
      form.reset();
      // Restore check defaults: core systems on, optional systems + programs off.
      form.querySelectorAll('.check input').forEach((i) => {
        const sys = SYSTEMS.find((s) => i.name === `sys_${s.key}`);
        i.checked = !!(sys && sys.core);
        i.closest('.check').classList.toggle('is-on', i.checked);
      });
      const noteWrap = $('#otherNoteWrap', form); if (noteWrap) noteWrap.hidden = true;
      form.querySelectorAll('[aria-invalid]').forEach((i) => i.removeAttribute('aria-invalid'));
      if (r && r.folderId) statusCache = [];  // force a refresh next time status opens
    } catch (err) {
      toast('Could not submit', err.message, 'err');
    } finally {
      btn.classList.remove('loading'); btn.disabled = false;
    }
  }

  //  2. PROVISIONING STATUS
  function viewProvisioning(root) {
    const wrap = el(`<div class="stack">
      <div class="section-head">
        <h2>Provisioning status</h2>
        <p>Live view of the account-provisioning queue: one row per person and system. Google and PropData run inside Apps Script; Property24, CMA and Dialfire run on the worker.</p>
      </div>
      <div class="card card-pad">
        <div class="toolbar">
          <div class="muted" id="provMeta">Loading...</div>
          <div class="toolbar-right">
            <button type="button" class="btn btn-ghost btn-sm" id="provRefresh">Refresh</button>
          </div>
        </div>
        <div id="provBody"></div>
      </div>
    </div>`);
    root.appendChild(wrap);
    $('#provRefresh', wrap).addEventListener('click', () => loadStatus(wrap, true));
    loadStatus(wrap, false);
  }

  const STATUS_CLASS = {
    pending: 's-pending', in_progress: 's-inprogress', inprogress: 's-inprogress',
    done: 's-done', error: 's-error', skipped: 's-skipped',
  };
  const STATUS_LABEL = {
    pending: 'Pending', in_progress: 'In progress', inprogress: 'In progress',
    done: 'Done', error: 'Error', skipped: 'Skipped',
  };

  async function loadStatus(wrap, force) {
    const body = $('#provBody', wrap), meta = $('#provMeta', wrap);
    body.innerHTML = `<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>`;
    meta.textContent = 'Loading...';
    try {
      const r = (statusCache.length && !force) ? { rows: statusCache } : await api(KINDS.status, {});
      // CONTRACTS 8.3: provisioning rows live under `rows`; `offboarding` is
      // separate admin-only context we don't render here.
      const rows = (r.rows || r.data || []).slice();
      statusCache = rows;
      renderStatus(body, meta, rows);
    } catch (err) {
      meta.textContent = '';
      body.innerHTML = `<div class="state"><div class="state-title">Could not load the queue</div><div>${esc(err.message)}</div></div>`;
    }
  }

  function renderStatus(body, meta, rows) {
    if (!rows.length) {
      meta.textContent = '';
      body.innerHTML = `<div class="state"><div class="state-title">Nothing in the queue</div><div>Provisioning rows appear here once an onboarding request is submitted.</div></div>`;
      return;
    }
    const canRetry = USER && USER.isSuper;
    meta.textContent = `${rows.length} queue row(s)`;
    const head = `<thead><tr>
      <th>Person</th><th>Entity</th><th>System</th><th>Action</th><th>Status</th><th>Detail</th>
      ${canRetry ? '<th aria-label="Retry"></th>' : ''}</tr></thead>`;
    const trs = rows.map((row) => {
      const st = String(row.status || 'pending').toLowerCase().replace(/\s+/g, '_');
      const cls = STATUS_CLASS[st] || 's-pending';
      const lbl = STATUS_LABEL[st] || row.status || 'Pending';
      const ent = (row.entity || '').toLowerCase();
      const entTag = ent === 'aqua' ? '<span class="entity-tag aqua">Aqua</span>'
        : ent === 'quay1' ? '<span class="entity-tag quay1">Quay 1</span>' : '<span class="muted">-</span>';
      const detail = row.result_json && typeof row.result_json === 'object'
        ? (row.result_json.username || row.result_json.id || row.result_json.error || '')
        : (row.result_json || row.detail || '');
      const retryCell = canRetry
        ? `<td class="actions">${(st === 'error') ? `<button type="button" class="btn btn-ghost btn-sm" data-retry="${esc(row.queue_id || '')}">Retry</button>` : ''}</td>`
        : '';
      return `<tr>
        <td class="who">${esc(row.full_name || row.name || '')}</td>
        <td>${entTag}</td>
        <td class="sys">${esc(row.system || '')}</td>
        <td class="sys">${esc(row.action || 'create')}</td>
        <td><span class="pill ${cls}">${esc(lbl)}</span></td>
        <td class="muted">${esc(detail).slice(0, 80)}</td>
        ${retryCell}</tr>`;
    }).join('');
    body.innerHTML = `<div class="tbl-wrap"><table class="tbl">${head}<tbody>${trs}</tbody></table></div>`;

    if (canRetry) {
      body.querySelectorAll('[data-retry]').forEach((b) => {
        b.addEventListener('click', async () => {
          b.classList.add('loading'); b.disabled = true;
          try {
            await api(KINDS.retry, { queue_id: b.dataset.retry });
            toast('Retry queued', 'The worker will pick this row up again.', 'ok');
            statusCache = [];
            loadStatus(body.closest('.stack'), true);
          } catch (err) {
            toast('Retry failed', err.message, 'err');
            b.classList.remove('loading'); b.disabled = false;
          }
        });
      });
    }
  }

  //  AUTH BOOT (login gate + session)
  function initLoginGate() {
    const gate = $('#loginGate'), userInput = $('#loginUser'), dots = $('#pinDots'),
          errEl = $('#loginError'), pad = $('#loginKeypad');
    let pin = '';
    const paint = () => dots.querySelectorAll('.pin-dot').forEach((d, i) => d.classList.toggle('filled', i < pin.length));
    const showErr = (m) => { errEl.textContent = m; errEl.hidden = false; gate.classList.add('pin-error'); setTimeout(() => gate.classList.remove('pin-error'), 500); };

    async function attempt() {
      const u = userInput.value.trim();
      if (!u) { showErr('Enter your username.'); return; }
      errEl.hidden = true;
      const r = await window.AUTH.signIn(u, pin);
      pin = ''; paint();
      if (!r.ok) { showErr(r.error || 'Sign-in failed.'); return; }
      USER = r.user; onSignedIn();
    }
    pad.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.hasAttribute('data-clear')) { pin = ''; paint(); return; }
      if (b.hasAttribute('data-back')) { pin = pin.slice(0, -1); paint(); return; }
      if (b.dataset.d && pin.length < 6) { pin += b.dataset.d; paint(); if (pin.length === 6) attempt(); }
    });
    document.addEventListener('keydown', (e) => {
      if (document.body.classList.contains('pre-auth') === false) return;
      if (e.key >= '0' && e.key <= '9' && pin.length < 6) { pin += e.key; paint(); if (pin.length === 6) attempt(); }
      else if (e.key === 'Backspace' && document.activeElement !== userInput) { pin = pin.slice(0, -1); paint(); }
      else if (e.key === 'Enter' && pin.length === 6) attempt();
    });
  }

  function onSignedIn() {
    document.body.classList.remove('pre-auth');
    const gate = $('#loginGate'); if (gate) gate.remove();  // uncover the app shell
    const so = $('#signOutBtn'); so.hidden = false;
    $('#signOutWho').textContent = USER && USER.name ? USER.name + ' - ' : '';
    so.addEventListener('click', async () => { await window.AUTH.signOut(); location.reload(); }, { once: true });
    document.querySelectorAll('.tab-btn').forEach((b) => b.addEventListener('click', () => route(b.dataset.tab)));
    route('onboard');
  }

  async function boot() {
    document.body.classList.add('pre-auth');
    initLoginGate();
    try {
      const u = await window.AUTH.getSession();
      if (u) { USER = u; onSignedIn(); }
    } catch (_) { /* stay on the gate */ }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();

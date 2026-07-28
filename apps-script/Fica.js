/**
 * Fica.js - FICA document intake. Renders the self-service upload form (doGet ?f=<folderId>)
 * and handles uploads, ticking the per-document R..V columns on the Onboarding row as files
 * land. Token-less: the unguessable folderId (which must already exist as an Onboarding row) is
 * the credential, so this path runs BEFORE any auth (matches the live Aqua flow, RESEARCH 2.6).
 *
 * Owner: backend. The R..V tick cells + tickFica_ live in Tracker.js (single owner); this
 * module reads the doc set and calls into it. Column letters per SPEC 3.1.
 *
 * Public surface:
 *   ficaLink_(folderId)          - String   the candidate FICA link (WEBAPP_URL ?f=folderId).
 *   ficaForm_(folderId)          - HtmlOutput   the candidate upload page (branded by entity).
 *   ficaUpload_(body)            - {ok, ticked:[...]}   store files + tick R..V. Token-less.
 *   ficaStatus_(folderId)        - Object   per-doc received/missing map (for progress report).
 *
 * Never auto-emails beyond the scoped onboarding pipeline (the FICA thank-you is that pipeline).
 */

/** Upload label -> Tracker FICA doc key (S..V; R/NDA is manual). Extra labels (e.g. TAX) are
 *  stored as files but tick no column, matching the live Quay1 mapping (RESEARCH 1.5). */
var FICA_LABEL_KEY = { ID: 'id', POA: 'poa', BANK: 'bank', POB: 'bank', CONTRACT: 'contract' };

/** The candidate FICA link. Empty string when WEBAPP_URL is not yet set (pre-deploy). */
function ficaLink_(folderId) {
  var base = optProp_(PROP.WEBAPP_URL);
  return base ? (base + '?f=' + encodeURIComponent(folderId)) : '';
}

/** Store an uploaded FICA submission and tick the matching R..V columns. Token-less; gated by
 *  the folderId existing as an Onboarding row. body = { folderId, details, files:[{label, ext,
 *  mimeType, dataBase64}] }. */
function ficaUpload_(body) {
  var folderId = String((body && body.folderId) || '');
  if (!folderId) return { ok: false, error: 'missing reference' };
  var meta = readOnboardingByFolder_(folderId);
  if (!meta) return { ok: false, error: 'link not recognised' };

  var folder;
  try { folder = DriveApp.getFolderById(folderId); }
  catch (err) { return { ok: false, error: 'link not recognised' }; }

  var name = meta.name || 'Candidate';
  var ficaFolder = _ficaSubfolder_(folder);

  var files = ((body && body.files) || []).filter(function (x) { return x && x.dataBase64; });
  if (!files.length) return { ok: false, error: 'no documents attached' };

  var ticked = [];
  files.forEach(function (fl) {
    var label = String(fl.label || 'DOC').toUpperCase();
    try {
      var blob = Utilities.newBlob(
        Utilities.base64Decode(fl.dataBase64),
        fl.mimeType || 'application/octet-stream',
        label + ' - ' + name + '.' + (fl.ext || 'dat'));
      ficaFolder.createFile(blob);
      var key = FICA_LABEL_KEY[label];
      if (key) { tickFica_(folderId, key); ticked.push(key); }
    } catch (err) {
      logAudit_('fica_file_failed', { folderId: folderId, label: label, error: String(err) });
    }
  });

  // Persist the typed details alongside the files.
  var d = (body && body.details) || {};
  var lines = Object.keys(d).map(function (k) { return k + ': ' + d[k]; });
  ficaFolder.createFile('FICA details - ' + name + '.txt',
    'FICA submission for ' + name + '\nReceived: ' + nowIso_() + '\n\n' + lines.join('\n'), 'text/plain');

  setOnboardingStatus_(folderId, 'FICA received');

  if (isEmail_(meta.email)) {
    var company = CFG.COMPANY[meta.entity] || CFG.COMPANY.quay1;
    try {
      GmailApp.sendEmail(meta.email, company.name + ' - FICA documents received - ' + name,
        'Hi ' + firstName_(name) + ',\n\nThank you for submitting your FICA documents to ' +
        company.name + '. We have received them and everything is now on file.\n\n' +
        'Warm regards,\nThe ' + company.name + ' Team', {
          bcc: CFG.ALWAYS_CC.filter(function (x) { return x; }).join(','),
          name: company.name, htmlBody: ficaThankYouHtml_(company, firstName_(name)),
        });
    } catch (err) { logAudit_('fica_thankyou_failed', { folderId: folderId, error: String(err) }); }
  }

  return { ok: true, ticked: ticked };
}

/** Per-doc received/missing map for the progress report (mirrors the live `progress` flags:
 *  bank=bankConf, poa, id=idRcv, contract=agreement, plus the manual nda). */
function ficaStatus_(folderId) {
  var o = readOnboardingByFolder_(folderId) || {};
  return {
    nda: !!o.fica_nda, bank: !!o.fica_bank, poa: !!o.fica_poa,
    id: !!o.fica_id, contract: !!o.fica_contract,
  };
}

function _ficaSubfolder_(folder) {
  var it = folder.getFoldersByName('FICA documents');
  return it.hasNext() ? it.next() : folder.createFolder('FICA documents');
}

// ---------------------------------------------------------------- candidate form page

/** Serve the branded FICA upload page. folderId + this /exec are baked in server-side. */
function ficaForm_(folderId) {
  var meta = readOnboardingByFolder_(folderId);
  var name = meta ? htmlEsc_(meta.name) : '';
  var known = !!meta;
  var company = CFG.COMPANY[(meta && meta.entity)] || CFG.COMPANY.quay1;
  var companyName = htmlEsc_(company.name);
  var endpoint = optProp_(PROP.WEBAPP_URL);
  var B = CFG.BRAND;

  var badLink = known ? '' :
    '<div class="note err show">This link is not recognised. Please use the personal link from your ' +
    companyName + ' agreement email, or reply to that email for help.</div>';

  var html =
'<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">' +
'<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
'<title>' + companyName + ' FICA documents</title><style>' +
':root{--navy:' + B.navy + ';--navy-d:' + B.navyDark + ';--ink:' + B.ink + ';--slate:' + B.slate + ';--muted:#7A8296;' +
'--paper:' + B.paper + ';--card:#fff;--card2:#F4F7FC;--line:#D5E0F2;--r:12px;--r-sm:8px;' +
'--sans:Montserrat,system-ui,-apple-system,Arial,sans-serif;--gold:' + B.gold + ';--gold-ink:' + B.goldInk + ';' +
'--green:' + B.green + ';--green-t:' + B.greenT + ';--green-b:' + B.greenB + ';--red:' + B.red + ';--red-t:#FDECEA;--amber:' + B.amber + ';--amber-t:' + B.amberT + ';}' +
'*{box-sizing:border-box}body{margin:0;font-family:var(--sans);background:var(--paper);color:var(--ink);line-height:1.55}' +
'.wrap{max-width:640px;margin:0 auto;padding:26px 18px 60px}' +
'.hero{background:var(--navy);color:#fff;border-radius:var(--r);padding:26px 24px;margin:14px 0 20px}' +
'.hero h1{margin:0 0 6px;font-size:21px;font-weight:800;text-transform:uppercase;letter-spacing:.4px}' +
'.hero p{margin:0;font-size:14.5px;color:#D9E4F5}' +
'.card{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:20px 22px;margin-bottom:16px}' +
'.sec{font-size:12px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:var(--navy);margin:0 0 12px}' +
'label{display:block;font-size:13px;font-weight:600;color:var(--slate);margin:0 0 5px}.req{color:var(--red)}' +
'input[type=text],textarea{width:100%;font-family:inherit;font-size:15px;color:var(--ink);background:var(--card2);' +
'border:1px solid var(--line);border-radius:var(--r-sm);padding:11px 13px;outline:none}' +
'input:focus,textarea:focus{border-color:var(--navy);box-shadow:0 0 0 3px rgba(61,91,166,.22);background:#fff}' +
'textarea{resize:vertical;min-height:70px}.row{margin-bottom:14px}.filewrap{margin-top:10px}' +
'input[type=file]{width:100%;font-size:13px;color:var(--slate);background:#EAF0FB;' +
'border:1px dashed var(--navy);border-radius:var(--r-sm);padding:12px;cursor:pointer}' +
'input[type=file]::file-selector-button{font-family:inherit;font-weight:600;font-size:12.5px;color:#fff;' +
'background:var(--navy);border:0;border-radius:6px;padding:7px 13px;margin-right:12px;cursor:pointer}' +
'.hint{font-size:12px;color:var(--muted);margin-top:5px}' +
'.btn{width:100%;font-family:inherit;font-size:15px;font-weight:700;color:var(--gold-ink);background:var(--gold);' +
'border:0;border-radius:var(--r-sm);padding:14px 18px;cursor:pointer}.btn:disabled{opacity:.6;cursor:not-allowed}' +
'.note{margin-top:14px;font-size:14px;padding:12px 14px;border-radius:var(--r-sm);display:none}' +
'.note.show{display:block}.note.ok{background:var(--green-t);color:var(--green);border:1px solid var(--green-b)}' +
'.note.err{background:var(--red-t);color:var(--red);border:1px solid #F5C6C0}' +
'.note.info{background:var(--amber-t);color:var(--amber);border:1px solid #F5E3B3}' +
'.foot{text-align:center;font-size:12px;color:var(--muted);margin-top:24px}' +
'</style></head><body><div class="wrap">' +
'<div class="hero"><h1>' + companyName + '</h1>' +
'<p>' + (name ? ('Hi ' + name + '. ') : '') + 'Please submit your FICA documents below. It only takes a minute.</p></div>' +
badLink +
'<form id="ficaForm" novalidate>' +
'<div class="card"><p class="sec">1 - Identity</p>' +
'<div class="row"><label for="id_number">ID or passport number <span class="req">*</span></label>' +
'<input type="text" id="id_number" inputmode="numeric" autocomplete="off" required></div>' +
'<div class="filewrap"><label for="f_id">Certified copy of your ID or passport <span class="req">*</span></label>' +
'<input type="file" id="f_id" accept="image/*,application/pdf" required></div></div>' +
'<div class="card"><p class="sec">2 - Proof of address</p>' +
'<div class="row"><label for="home_address">Residential address <span class="req">*</span></label>' +
'<textarea id="home_address" placeholder="Street, suburb, city, postal code" required></textarea></div>' +
'<div class="filewrap"><label for="f_addr">Proof of address <span class="req">*</span></label>' +
'<input type="file" id="f_addr" accept="image/*,application/pdf" required>' +
'<p class="hint">A utility bill, bank statement or lease dated within the last 3 months.</p></div></div>' +
'<div class="card"><p class="sec">3 - Bank confirmation</p>' +
'<div class="filewrap"><label for="f_bank">Bank confirmation letter or statement <span class="req">*</span></label>' +
'<input type="file" id="f_bank" accept="image/*,application/pdf" required></div></div>' +
'<div class="card"><p class="sec">4 - Tax</p>' +
'<div class="row"><label for="tax_number">Income tax number <span class="req">*</span></label>' +
'<input type="text" id="tax_number" inputmode="numeric" autocomplete="off" required></div>' +
'<div class="filewrap"><label for="f_tax">SARS / tax number proof (optional)</label>' +
'<input type="file" id="f_tax" accept="image/*,application/pdf"></div></div>' +
'<button type="submit" class="btn" id="submitBtn">Submit my FICA documents</button>' +
'<div id="note" class="note"></div></form>' +
'<p class="foot">' + companyName + ' - your documents are stored securely and used only for FICA compliance.</p>' +
'</div><script>' +
'var ENDPOINT=' + JSON.stringify(endpoint) + ';var FOLDER_ID=' + JSON.stringify(folderId) + ';' +
'var KNOWN=' + (known ? 'true' : 'false') + ';' +
'var form=document.getElementById("ficaForm"),note=document.getElementById("note"),btn=document.getElementById("submitBtn");' +
'if(!KNOWN&&btn){btn.disabled=true;}' +
'function showNote(c,m){note.className="note show "+c;note.textContent=m;}' +
'function val(id){var e=document.getElementById(id);return e?e.value.trim():"";}' +
'function b64(file){return new Promise(function(res,rej){var r=new FileReader();' +
'r.onload=function(){res(String(r.result).split(",")[1]);};r.onerror=rej;r.readAsDataURL(file);});}' +
'var MAP=[["f_id","ID"],["f_addr","POA"],["f_bank","BANK"],["f_tax","TAX"]];' +
'form.addEventListener("submit",function(e){e.preventDefault();if(!KNOWN)return;' +
'if(!form.checkValidity()){form.reportValidity();return;}' +
'btn.disabled=true;showNote("info","Uploading your documents, please hold on...");' +
'var details={"ID/passport number":val("id_number"),"Residential address":val("home_address"),"Income tax number":val("tax_number")};' +
'var jobs=MAP.map(function(m){var i=document.getElementById(m[0]);var f=i&&i.files&&i.files[0];' +
'if(!f)return Promise.resolve(null);return b64(f).then(function(x){' +
'var ext=(f.name.split(".").pop()||"dat").toLowerCase();' +
'return{label:m[1],ext:ext,mimeType:f.type||"application/octet-stream",dataBase64:x};});});' +
'Promise.all(jobs).then(function(files){files=files.filter(Boolean);' +
'return fetch(ENDPOINT,{method:"POST",headers:{"Content-Type":"text/plain;charset=utf-8"},' +
'body:JSON.stringify({kind:"fica_upload",folderId:FOLDER_ID,details:details,files:files})});})' +
'.then(function(r){return r.json();}).then(function(d){' +
'if(d&&d.ok){form.style.display="none";showNote("ok","Thank you! Your FICA documents have been received.");}' +
'else{showNote("err","Something went wrong: "+((d&&d.error)||"unknown")+".");btn.disabled=false;}})' +
'.catch(function(err){showNote("err","Upload failed: "+err+".");btn.disabled=false;});' +
'});' +
'<\/script></body></html>';

  return HtmlService.createHtmlOutput(html)
    .setTitle(company.name + ' FICA documents')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

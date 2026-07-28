/**
 * Email.js - shared branded HTML email builders. Ported and generalised from the live Aqua
 * email code (aqua-contracts Code.js:1216-1411), parameterised by the per-entity company info
 * (CFG.COMPANY[entity]) so Quay 1 and Aqua share one navy+gold shell (RESEARCH 2.7 confirmed
 * both live pipelines use the same palette). All inline styles, no external assets (CSP-safe).
 *
 * This file is an addition to the architect's stub set (flagged to tester + architect): the
 * email HTML would otherwise push the onboarding modules over the 500-line limit.
 *
 * Public surface (each returns an HTML string):
 *   emailShell_(company, kicker, innerHtml)     - the navy/gold wrapper.
 *   agreementEmailHtml_(company, first, ficaUrl)- contract welcome + FICA button.
 *   ficaThankYouHtml_(company, first)           - FICA received acknowledgement.
 *   provisionNoticeHtml_(company, name, fields, systems, folderUrl) - human account-setup notice.
 *   inductionDigestHtml_(company, buckets)      - Tuesday induction digest (auto-send scoped ok).
 *   offboardNoticeHtml_(company, oq)            - offboarding scheduled/fired notice (DRAFT only).
 *
 * No em/en dashes in any string this file emits.
 */

/** The navy/gold wrapper used by every email. */
function emailShell_(company, kicker, innerHtml) {
  var B = CFG.BRAND;
  return '' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:' + B.paper + ';margin:0;padding:0"><tr><td align="center" style="padding:26px 12px">' +
      '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:#ffffff;border-radius:16px;overflow:hidden;font-family:Montserrat,Arial,Helvetica,sans-serif">' +
        '<tr><td style="background:' + B.navy + ';padding:30px 40px 26px;text-align:center">' +
          '<div style="font-size:27px;font-weight:800;color:#ffffff;text-transform:uppercase;letter-spacing:.5px;line-height:1.12">' + htmlEsc_(company.name) + '</div>' +
          '<div style="font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#C7D6F0;margin:8px 0 0">' + htmlEsc_(kicker) + '</div>' +
        '</td></tr>' +
        '<tr><td style="padding:32px 40px 8px">' + innerHtml + '</td></tr>' +
        '<tr><td style="background:' + B.navyDark + ';padding:22px 40px 24px;text-align:center">' +
          '<div style="font-size:13px;color:#ffffff;font-weight:700;text-transform:uppercase;letter-spacing:.4px">' + htmlEsc_(company.full) + '</div>' +
        '</td></tr>' +
      '</table>' +
    '</td></tr></table>';
}

/** Contract welcome email with the FICA submission button. */
function agreementEmailHtml_(company, first, ficaUrl) {
  var B = CFG.BRAND;
  var ficaBtn = ficaUrl
    ? '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0 2px"><tr><td style="border-radius:9px;background:' + B.gold + '">' +
        '<a href="' + htmlEsc_(ficaUrl) + '" style="display:inline-block;padding:12px 22px;font-size:14.5px;font-weight:700;color:' + B.goldInk + ';text-decoration:none;border-radius:9px">Submit my FICA documents</a>' +
      '</td></tr></table>'
    : '';
  var inner =
    '<p style="margin:0 0 12px;font-size:17px;font-weight:700;color:' + B.goldInk + '">Hi ' + htmlEsc_(first) + ',</p>' +
    '<p style="margin:0 0 18px;font-size:15px;line-height:1.62;color:' + B.slate + '">Welcome to ' + htmlEsc_(company.name) +
      '. Your ' + htmlEsc_(company.kicker) + ' is attached to this email.</p>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;background:#FFF6D6;border:1px solid #F0DFA0;border-radius:10px"><tr>' +
      '<td width="46" valign="middle" style="padding:12px 0 12px 14px"><div style="width:26px;height:26px;border-radius:7px;background:' + B.gold + ';color:' + B.goldInk + ';text-align:center;line-height:26px;font-size:14px">&#128206;</div></td>' +
      '<td valign="middle" style="padding:12px 15px 12px 6px;font-size:13.5px;color:' + B.goldInk + ';font-weight:600">' + htmlEsc_(company.kicker) + ' (PDF attached)</td>' +
    '</tr></table>' +
    '<p style="margin:0 0 16px;font-size:15px;line-height:1.62;color:' + B.slate + '">Please read it through, sign the cover page, initial every page, and sign where applicable, then return a signed copy to us and keep one for your records.</p>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px;background:' + B.amberT + ';border:1px solid #F5E3B3;border-radius:10px"><tr>' +
      '<td style="padding:14px 16px">' +
        '<div style="font-size:12px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:' + B.amber + ';margin:0 0 8px">FICA - required</div>' +
        '<div style="font-size:14px;line-height:1.6;color:' + B.slate + '">To comply with FICA, please submit the following using your personal, secure link below:' +
          '<ol style="margin:8px 0 12px;padding:0 0 0 20px">' +
            '<li style="margin:0 0 4px">A certified copy of your ID or valid passport</li>' +
            '<li style="margin:0 0 4px">Proof of your residential address, not older than 3 months (e.g. a utility bill or bank statement)</li>' +
            '<li style="margin:0 0 4px">A bank confirmation letter or recent bank statement showing your account details</li>' +
            '<li>Your income tax number (and SARS proof of it, if you have one)</li>' +
          '</ol>' +
        '</div>' + ficaBtn +
      '</td>' +
    '</tr></table>' +
    '<p style="margin:0 0 16px;font-size:15px;line-height:1.62;color:' + B.slate + '">If anything is unclear, simply reply to this email and we will gladly help.</p>' +
    '<p style="margin:22px 0 0;font-size:15px;color:' + B.goldInk + '">Warm regards,</p>' +
    '<p style="margin:2px 0 4px;font-size:15px;font-weight:700;color:' + B.navyDark + '">The ' + htmlEsc_(company.name) + ' Team</p>';
  return emailShell_(company, company.kicker, inner);
}

/** FICA received acknowledgement email. */
function ficaThankYouHtml_(company, first) {
  var B = CFG.BRAND;
  var inner =
    '<p style="margin:0 0 12px;font-size:17px;font-weight:700;color:' + B.goldInk + '">Hi ' + htmlEsc_(first) + ',</p>' +
    '<p style="margin:0 0 18px;font-size:15px;line-height:1.62;color:' + B.slate + '">Thank you for submitting your FICA documents to ' +
      htmlEsc_(company.name) + '. We have received them and everything is now on file.</p>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;background:#FFF6D6;border:1px solid #F0DFA0;border-radius:10px"><tr>' +
      '<td width="46" valign="middle" style="padding:12px 0 12px 14px"><div style="width:26px;height:26px;border-radius:7px;background:' + B.gold + ';color:' + B.goldInk + ';text-align:center;line-height:26px;font-size:15px">&#10003;</div></td>' +
      '<td valign="middle" style="padding:12px 15px 12px 6px;font-size:13.5px;color:' + B.goldInk + ';font-weight:600">FICA documents received</td>' +
    '</tr></table>' +
    '<p style="margin:0 0 16px;font-size:15px;line-height:1.62;color:' + B.slate + '">There is nothing further you need to do. If we have any questions we will be in touch.</p>' +
    '<p style="margin:22px 0 0;font-size:15px;color:' + B.goldInk + '">Warm regards,</p>' +
    '<p style="margin:2px 0 4px;font-size:15px;font-weight:700;color:' + B.navyDark + '">The ' + htmlEsc_(company.name) + ' Team</p>';
  return emailShell_(company, 'FICA documents received', inner);
}

/** Human "please set up these accounts" notice (browser systems a person must action). */
function provisionNoticeHtml_(company, name, fields, systems, folderUrl) {
  var B = CFG.BRAND;
  var rows = systems.map(function (s) {
    return '<tr><td style="padding:6px 0;font-size:14.5px;color:' + B.goldInk + '">' +
      '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + B.gold + ';margin-right:10px"></span>' +
      htmlEsc_(s) + '</td></tr>';
  }).join('');
  var detail = function (label, value) {
    return '<tr><td style="padding:3px 14px 3px 0;font-size:13px;color:' + B.muted + ';white-space:nowrap">' + htmlEsc_(label) + '</td>' +
      '<td style="padding:3px 0;font-size:14px;color:' + B.goldInk + ';font-weight:600">' + htmlEsc_(value || '-') + '</td></tr>';
  };
  var inner =
    '<p style="margin:0 0 16px;font-size:15px;line-height:1.62;color:' + B.slate + '">A new ' + htmlEsc_(company.name) +
      ' record needs these browser-portal accounts set up (the API systems are already handled). ' +
      'Please action them and reply once done.</p>' +
    '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 18px">' +
      detail('Name', name) + detail('ID number', fields.id_number || '') +
      detail('Start date', fmtDate_(fields.start_date)) + detail('Email', fields.email || '(none)') +
    '</table>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px;background:' + B.amberT + ';border:1px solid #F5E3B3;border-radius:10px"><tr><td style="padding:14px 16px">' +
      '<div style="font-size:12px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:' + B.amber + ';margin:0 0 8px">Systems to provision</div>' +
      '<table role="presentation" cellpadding="0" cellspacing="0">' + rows + '</table>' +
    '</td></tr></table>' +
    (folderUrl ? '<p style="margin:0 0 6px;font-size:13.5px;color:' + B.slate + '">Folder: <a href="' + htmlEsc_(folderUrl) + '" style="color:' + B.navyDark + '">open in Drive</a></p>' : '') +
    '<p style="margin:22px 0 0;font-size:15px;color:' + B.goldInk + '">Thanks,</p>' +
    '<p style="margin:2px 0 4px;font-size:15px;font-weight:700;color:' + B.navyDark + '">The ' + htmlEsc_(company.name) + ' Team</p>';
  return emailShell_(company, 'Account setup needed', inner);
}

/** Tuesday induction digest (auto-send permitted for this scoped pipeline). */
function inductionDigestHtml_(company, buckets) {
  var B = CFG.BRAND;
  var list = function (title, rows, empty) {
    var items = rows.length
      ? rows.map(function (r) {
          return '<li style="margin:0 0 4px;font-size:13.5px;color:' + B.goldInk + '">' + htmlEsc_(r.name) +
            (r.induction_wed ? ' <span style="color:' + B.muted + '">- Wed ' + htmlEsc_(fmtDate_(r.induction_wed)) + '</span>' : '') + '</li>';
        }).join('')
      : '<li style="margin:0;font-size:13.5px;color:' + B.muted + '">' + htmlEsc_(empty) + '</li>';
    return '<div style="margin:0 0 16px"><div style="font-size:12px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:' + B.amber + ';margin:0 0 6px">' +
      htmlEsc_(title) + ' (' + rows.length + ')</div><ul style="margin:0;padding:0 0 0 18px">' + items + '</ul></div>';
  };
  var inner =
    '<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:' + B.slate + '">Induction status for the week. ' +
      buckets.dueThisWeek.length + ' candidate' + (buckets.dueThisWeek.length === 1 ? '' : 's') + ' booked for induction.</p>' +
    list('Booked this week', buckets.dueThisWeek, 'No inductions booked this week.') +
    list('Awaiting booking', buckets.unbooked, 'Everyone due is booked.');
  return emailShell_(company, 'Induction digest', inner);
}

/** Offboarding scheduled/fired notice (DRAFT only, never auto-sent). */
function offboardNoticeHtml_(company, oq) {
  var B = CFG.BRAND;
  var detail = function (label, value) {
    return '<tr><td style="padding:3px 14px 3px 0;font-size:13px;color:' + B.muted + ';white-space:nowrap">' + htmlEsc_(label) + '</td>' +
      '<td style="padding:3px 0;font-size:14px;color:' + B.goldInk + ';font-weight:600">' + htmlEsc_(value || '-') + '</td></tr>';
  };
  var inner =
    '<p style="margin:0 0 16px;font-size:16px;font-weight:700;color:' + B.goldInk + '">' + htmlEsc_(oq.full_name || 'A staff member') + ' is scheduled for offboarding.</p>' +
    '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px">' +
      detail('Google account', oq.quay_email) + detail('Requested by', oq.requested_by) +
      detail('Fires at', oq.fire_at) + detail('Systems', (oq.systems || []).join(', ')) +
    '</table>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:2px 0 4px;background:' + B.amberT + ';border:1px solid #F5E3B3;border-radius:10px"><tr><td style="padding:12px 15px;font-size:14px;color:' + B.amber + ';font-weight:600">This is a scheduled offboarding. There is no cancel window once the timer starts.</td></tr></table>';
  return emailShell_(company, 'Offboarding scheduled', inner);
}

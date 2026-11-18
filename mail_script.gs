// BayadQR - Gmail script (EMAIL ONLY: sends each student their QR code).
// Log in to the SENDER Gmail, make a NEW Apps Script project, paste this, deploy as Web app.
// Paste its Web app URL + SECRET in Settings > QR Email. It has nothing to do with the Google Sheet script.
const SECRET = 'change-this-secret';   // any text; type the same text in Settings > QR Email > Secret

function doGet() { return out({ ok: true, message: 'BayadQR mail script is deployed and running' }); }

// Run this ONCE from the editor (select testSetup > Run > Allow) so the script may send email.
function testSetup() { Logger.log('Emails left today: ' + MailApp.getRemainingDailyQuota()); }

function doPost(e) {
  let data;
  try { data = JSON.parse(e.postData.contents); } catch (err) { return out({ ok: false, error: 'bad request' }); }
  if (data.secret !== SECRET) return out({ ok: false, error: 'bad secret' });
  if (data.action === 'send_qr') return sendQr(data);
  return out({ ok: false, error: 'unknown action' });
}

function sendQr(d) {
  try {
    const png = UrlFetchApp.fetch('https://api.qrserver.com/v1/create-qr-code/?size=400x400&margin=10&data=' + encodeURIComponent(d.code)).getBlob().setName(d.name + ' QR.png');
    MailApp.sendEmail({ to: d.to, subject: d.subject, body: d.text || 'Your QR code is in this email.', htmlBody: d.html, name: d.senderName || 'BayadQR', replyTo: d.replyTo || Session.getEffectiveUser().getEmail(), inlineImages: { qr: png } });
    return out({ ok: true });
  } catch (err) { return out({ ok: false, error: String(err) }); }
}

function out(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

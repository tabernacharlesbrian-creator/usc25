// BayadQR - Google Sheet script (SHEET ONLY: it does not use Gmail and needs no Secret).
// Deploy it as a Web app, paste the Web app URL + the Google Sheet link in Settings > Google Sheet.
// QR emails to students use a different script (includes/google_mail_script.gs), so the two never mix.
const TZ = 'Asia/Manila';
// Your Google Sheet ID. Used when Settings has no Sheet ID (or still says PASTE_YOUR_...).
const DEFAULT_SHEET_ID = '1bu6wYKJoGm_xEh25VqTml5T1ZF_s-OtMegWfYJTnnRI';

// Open the Web app URL in a browser: you should see {"ok":true,...}. If you see a Google sign-in page, redeploy with Who has access = Anyone.
function doGet() { return out({ ok: true, message: 'BayadQR script is deployed and running' }); }

// Run this ONCE from the Apps Script editor (select testSetup > Run) to give the script permission to edit your Sheet.
function testSetup() {
  // This run only has to ASK Google for permission. The real Sheet is the link you paste in Settings > Google Sheet.
  try {
    const ss = SpreadsheetApp.openById(DEFAULT_SHEET_ID);
    Logger.log('OK. Tabs: ' + ss.getSheets().map(function (s) { return s.getName(); }).join(', '));
  } catch (err) {
    Logger.log('Permission is granted. (DEFAULT_SHEET_ID is not your Sheet, which is fine: the link in Settings is used instead.) ' + String(err));
  }
}

// Accepts a plain ID or a whole Google Sheet link.
function pickSheetId(v) {
  let id = String(v || '').trim();
  const m = id.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (m) id = m[1];
  return (id && id.indexOf('PASTE_YOUR') !== 0) ? id : DEFAULT_SHEET_ID;
}

// Student ID prefix is now CICI-. Old Sheet rows that still say USC-00001 are treated as the same student and are rewritten as CICI-00001.
function normId(v) { return String(v || '').trim().replace(/^USC-/i, 'CICI-'); }

function doPost(e) {
  let data;
  try { data = JSON.parse(e.postData.contents); } catch (err) { return out({ ok: false, error: 'bad request' }); }

  if (data.action === 'ping') {
    try {
      const ss = SpreadsheetApp.openById(pickSheetId(data.sheetId));
      return out({ ok: true, sheet: ss.getName(), tabs: ss.getSheets().map(function (t) { return t.getName(); }) });
    } catch (err) { return out({ ok: false, error: 'Cannot open the Sheet: ' + String(err) }); }
  }
  if (data.action === 'log_payment') {
    try { return logPayment(data); }
    catch (err) { return out({ ok: false, error: 'Sheet error: ' + String(err) + ' (check the Google Sheet link in Settings)' }); }
  }

  if (data.action === 'sync_roster') {
    try { return syncRoster(data); }
    catch (err) { return out({ ok: false, error: 'Sheet error: ' + String(err) + ' (check the Google Sheet link in Settings)' }); }
  }

  return out({ ok: false, error: 'unknown action' });
}

// One tab per payment AND section (e.g. "Week 1 - BSIT 3C Mauchly"). One row per student, updated every time they are scanned.
// Balance goes down as they pay; when it reaches 0 the Status says "Fully paid".
const HEADER = ['No.', 'Date/Time', 'Student ID', 'Student Name', 'Section', 'Payment', 'Amount Due', 'Paid', 'Balance', 'Status'];

function logPayment(d) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const ss  = SpreadsheetApp.openById(pickSheetId(d.sheetId));
    const sh = getFeeTab(ss, d.tab || d.event);

    const due = Number(d.due) || 0, paid = Number(d.paid) || 0, bal = Math.max(0, due - paid);
    const status = paid <= 0 ? 'Unpaid' : (bal <= 0.004 ? '✅ Fully paid' : 'Balance left');
    const code = String(d.code || '').trim();
    const name = String(d.name || '').trim();
    const when = d.time || Utilities.formatDate(new Date(), TZ, 'MMM d, yyyy h:mm a');

    // find this student's row by looking at the real data rows only (blank formatted rows in the Excel template are skipped)
    let lastData = 1;
    const colC = sh.getRange(1, 3, Math.max(sh.getMaxRows(), 1), 2).getValues();   // Student ID + Name
    for (let i = colC.length - 1; i >= 1; i--) {
      if (String(colC[i][0]).trim() !== '' || String(colC[i][1]).trim() !== '') { lastData = i + 1; break; }
    }
    let r = 0;
    for (let i = 1; i < lastData; i++) {
      const id = String(colC[i][0]).trim(), nm = String(colC[i][1]).trim();
      if ((code && normId(id) === normId(code)) || (!code && nm === name)) { r = i + 1; break; }
    }
    if (!r) r = lastData + 1;

    if (r > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), r - sh.getMaxRows() + 50);   // never run out of rows

    // every column of the Excel format is filled, nothing is left blank
    const row = [r - 1, when, code, name, String(d.section || '').trim() || '-', String(d.event), due, paid, bal, status];
    sh.getRange(r, 3).setNumberFormat('@');                       // Student ID stays text (CICI-00001)
    sh.getRange(r, 2).setNumberFormat('@');                       // Date/Time stays exactly as shown
    sh.getRange(r, 1, 1, row.length).setValues([row]);
    sh.getRange(r, 7, 1, 3).setNumberFormat('"₱"#,##0.00');
    sh.getRange(r, 1).setHorizontalAlignment('center');
    sh.getRange(r, 1, 1, row.length).setBackground(paid <= 0 ? '#FDE6E7' : (bal <= 0.004 ? '#DDF5E7' : '#FFF1CF'));

    // keep the numbers 1, 2, 3 ... going down with no gaps
    const lastRow = Math.max(lastData, r);
    if (lastRow > 1) {
      const nums = [];
      for (let n = 1; n < lastRow; n++) nums.push([n]);
      sh.getRange(2, 1, lastRow - 1, 1).setValues(nums).setHorizontalAlignment('center');
    }
    SpreadsheetApp.flush();
    try { updateSummary(ss); } catch (err) { /* the row is saved; the Summary will refresh on the next scan */ }
    return out({ ok: true, updated: true, row: r });
  } finally {
    lock.releaseLock();
  }
}


// Finds (or creates) the tab of one payment + section and makes sure it has the right header row.
function getFeeTab(ss, tabName) {
  const tab = String(tabName).replace(/[\[\]\*\?\:\/\\]/g, '-').substring(0, 90);
  let sh = ss.getSheetByName(tab);
  // a tab made by the older version has different columns: keep it as a backup and start a fresh one
  if (sh && sh.getLastRow() > 0 && String(sh.getRange(1, 3).getValue()).trim() !== 'Student ID') {
    sh.setName(tab.substring(0, 70) + ' (old ' + Utilities.formatDate(new Date(), TZ, 'MMdd-HHmm') + ')');
    sh = null;
  }
  if (!sh) sh = ss.insertSheet(tab);
  const hdr = sh.getRange(1, 1, 1, HEADER.length).getValues()[0].map(function (x) { return String(x).trim(); });
  if (hdr.join('|') !== HEADER.join('|')) sh.getRange(1, 1, 1, HEADER.length).setValues([HEADER]);
  sh.getRange(1, 1, 1, HEADER.length).setFontWeight('bold').setBackground('#F6E1EC');
  sh.setFrozenRows(1);
  return sh;
}

// New payment / new student: make the tab of each section and list every student in it.
// A student who already has money in the Sheet is left alone; unpaid rows are refreshed (amount, name, section).
function syncRoster(d) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const ss = SpreadsheetApp.openById(pickSheetId(d.sheetId));
    let added = 0;
    (d.tabs || []).forEach(function (t) {
      const sh = getFeeTab(ss, t.tab);
      const last = sh.getLastRow();
      let data = last > 1 ? sh.getRange(2, 1, last - 1, HEADER.length).getValues() : [];
      data = data.filter(function (r) { return String(r[2]).trim() !== '' || String(r[3]).trim() !== ''; });
      const idx = {};
      data.forEach(function (r, i) { idx[normId(r[2])] = i; });
      (t.rows || []).forEach(function (x) {
        const code = normId(x.code);
        if (!code) return;
        const due = Number(x.due) || 0, paid = Number(x.paid) || 0, bal = Math.max(0, due - paid);
        const status = paid <= 0 ? 'Unpaid' : (bal <= 0.004 ? '✅ Fully paid' : 'Balance left');
        const row = [0, String(x.time || ''), code, String(x.name || '').trim(), String(x.section || '').trim() || '-', String(x.event || ''), due, paid, bal, status];
        if (Object.prototype.hasOwnProperty.call(idx, code)) {
          const cur = data[idx[code]];
          if ((Number(cur[7]) || 0) <= 0) data[idx[code]] = row;     // still unpaid in the Sheet: refresh it
        } else { data.push(row); added++; }
      });
      data.sort(function (a, b) { return String(a[3]).localeCompare(String(b[3])); });
      data.forEach(function (r, i) { r[0] = i + 1; });
      const n = data.length;
      if (last > 1) sh.getRange(2, 1, last - 1, HEADER.length).clearContent().setBackground(null);
      if (n) {
        if (n + 1 > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), n + 1 - sh.getMaxRows() + 20);
        sh.getRange(2, 2, n, 2).setNumberFormat('@');
        sh.getRange(2, 1, n, HEADER.length).setValues(data);
        sh.getRange(2, 7, n, 3).setNumberFormat('"₱"#,##0.00');
        sh.getRange(2, 1, n, 1).setHorizontalAlignment('center');
        sh.getRange(2, 1, n, HEADER.length).setBackgrounds(data.map(function (r) {
          const p = Number(r[7]) || 0, b = Number(r[8]) || 0;
          return Array(HEADER.length).fill(p <= 0 ? '#FDE6E7' : (b <= 0.004 ? '#DDF5E7' : '#FFF1CF'));
        }));
      }
    });
    SpreadsheetApp.flush();
    try { updateSummary(ss); } catch (err) { /* rows are saved; Summary refreshes on the next scan */ }
    return out({ ok: true, added: added });
  } finally {
    lock.releaseLock();
  }
}

// ---------- Summary dashboard ----------
// Tab "Summary" is rebuilt after every scan. It only holds formulas that read the fee tabs,
// so it always matches the rows (Students listed, Total amount due, Total collected, Total balance,
// Fully paid students, Students with balance). Row 2 = all payments together, rows 6+ = one row per payment tab.
const SUMMARY_HEAD = ['Students listed', 'Total amount due', 'Total collected', 'Total balance', 'Fully paid students', 'Students with balance'];

function feeTabs(ss) {
  return ss.getSheets().filter(function (s) {
    return s.getLastRow() > 0 && String(s.getRange(1, 3).getValue()).trim() === 'Student ID' && ['Student Name', 'Full Name'].indexOf(String(s.getRange(1, 4).getValue()).trim()) >= 0;
  });
}

function updateSummary(ss) {
  let sm = ss.getSheetByName('Summary');
  if (!sm) { sm = ss.insertSheet('Summary', 0); }
  const tabs = feeTabs(ss);
  const q = function (n) { return "'" + n.replace(/'/g, "''") + "'"; };
  const money = '"₱"#,##0.00';
  sm.clear();

  sm.getRange(1, 1, 1, 6).setValues([SUMMARY_HEAD]);
  sm.getRange(5, 1, 1, 7).setValues([['Payment'].concat(SUMMARY_HEAD)]);
  sm.getRange(1, 1, 1, 6).setFontWeight('bold').setBackground('#F6E1EC').setHorizontalAlignment('center');
  sm.getRange(5, 1, 1, 7).setFontWeight('bold').setBackground('#F6E1EC').setHorizontalAlignment('center');
  sm.getRange(4, 1).setValue('BY PAYMENT').setFontWeight('bold');
  sm.getRange(3, 1).setValue('Updates by itself every time a QR is scanned. Do not type here.').setFontStyle('italic').setFontColor('#777777');

  if (tabs.length) {
    const r = tabs.map(function (t, i) {
      const n = q(t.getName()), row = 6 + i;
      return [
        t.getName(),
        '=COUNTA(' + n + '!C2:C)',
        '=SUM(' + n + '!G2:G)',
        '=SUM(' + n + '!H2:H)',
        '=SUM(' + n + '!I2:I)',
        '=COUNTIF(' + n + '!J2:J,"*Fully paid*")',
        '=COUNTIF(' + n + '!I2:I,">0")'
      ];
    });
    sm.getRange(6, 1, r.length, 7).setFormulas(r);
    const last = 5 + r.length;
    // row 2 = all payments: students listed counts each student once (same Student ID in several tabs = 1)
    const ids = tabs.map(function (t) { return q(t.getName()) + '!C2:C'; }).join(';');
    sm.getRange(2, 1, 1, 6).setFormulas([[
      '=COUNTA(UNIQUE({' + ids + '}))-COUNTBLANK(UNIQUE({' + ids + '}))',
      '=SUM(C6:C' + last + ')', '=SUM(D6:D' + last + ')', '=SUM(E6:E' + last + ')',
      '=SUM(F6:F' + last + ')', '=SUM(G6:G' + last + ')'
    ]]);
    sm.getRange(6, 3, r.length, 3).setNumberFormat(money);
  } else {
    sm.getRange(2, 1, 1, 6).setValues([[0, 0, 0, 0, 0, 0]]);
  }
  sm.getRange(2, 2, 1, 3).setNumberFormat(money);
  sm.getRange(2, 1, 1, 6).setFontWeight('bold').setHorizontalAlignment('center');
  sm.getRange(6, 2, Math.max(tabs.length, 1), 6).setHorizontalAlignment('center');
  sm.setColumnWidths(1, 1, 150); sm.setColumnWidths(2, 6, 160);
  sm.setFrozenRows(1);
  ss.setActiveSheet(sm); ss.moveActiveSheet(1);   // keep Summary as the first tab
}

function out(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

// BayadQR shared code: Firebase, login, menu, Google Sheet + email helpers.
// accepts FIREBASE_CONFIG (this project) or firebaseConfig (name used by the Firebase Console)
const _cfg = typeof FIREBASE_CONFIG !== 'undefined' ? FIREBASE_CONFIG : (typeof firebaseConfig !== 'undefined' ? firebaseConfig : null);
if (!_cfg || /PASTE/.test(_cfg.apiKey || 'PASTE')) { document.addEventListener('DOMContentLoaded', () => document.body.innerHTML = '<p style="padding:24px;font:16px sans-serif">Open <b>firebase-config.js</b> and paste your Firebase config (Project settings > Your apps > Config).</p>'); throw new Error('Firebase config missing'); }
firebase.initializeApp(_cfg);
const auth = firebase.auth(), db = firebase.firestore();
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = v => '₱' + Number(v || 0).toLocaleString('en-PH', {minimumFractionDigits: 2, maximumFractionDigits: 2});
const fmt = t => t ? new Date(t).toLocaleString('en-PH', {timeZone: 'Asia/Manila', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit'}) : '';
const natsort = (a, b) => String(a).localeCompare(String(b), undefined, {numeric: true, sensitivity: 'base'});
const payStatus = (due, paid) => paid <= 0 ? (due <= 0 ? 'paid' : 'unpaid') : (paid + 0.004 >= due ? 'paid' : 'partial');
const getAll = async c => (await db.collection(c).get()).docs.map(d => ({id: d.id, ...d.data()}));
const NAV = [['students.html','Students'],['sections.html','Sections'],['collections.html','Collections'],['scan.html','Scan'],['payments.html','Payments'],['settings.html','Settings']];

function msg(text, bad) { const m = $('#msg'); if (!m) return; m.className = bad ? 'err' : ''; m.style.cssText = bad ? '' : 'background:#DDF5E7;color:#0c7a3c;padding:10px 14px;border-radius:10px;margin-bottom:14px'; m.textContent = text; m.style.display = text ? '' : 'none'; }

/** Page shell + login. fn(root) runs once the owner is signed in. */
function boot(title, active, sub, fn) {
  document.title = title + ' - BayadQR';
  document.body.innerHTML = '<nav class="rail"><div class="brand"><i>B</i><span>BayadQR<small>Scan. Pay. Logged.</small></span></div>'
    + NAV.map(n => `<a href="${n[0]}"${n[0] === active ? ' class="on"' : ''}>${n[1]}</a>`).join('')
    + '<a href="#" id="out">Log out</a></nav><main><div class="head"><div><h1>' + esc(title) + '</h1><p>' + esc(sub) + '</p></div></div><div id="msg" style="display:none"></div><div id="app"></div></main>';
  $('#out').onclick = e => { e.preventDefault(); auth.signOut().then(() => location.reload()); };
  let started = false;
  auth.onAuthStateChanged(u => {
    if (!u) return login();
    if (started) return; started = true; $('#app').innerHTML = '';
    Promise.resolve(fn($('#app'))).catch(e => msg('Error: ' + e.message, true));
  });
}
function login() {
  $('#app').innerHTML = '<form class="card" id="lf" style="max-width:420px"><h2>Log in</h2><label>Email</label><input id="lu" type="email" required autocomplete="username"><label>Password</label><input id="lp" type="password" required autocomplete="current-password"><p><button>Log in</button></p></form>';
  $('#lf').onsubmit = async e => { e.preventDefault(); try { await auth.signInWithEmailAndPassword($('#lu').value.trim(), $('#lp').value); } catch (x) { msg('Wrong email or password.', true); } };
}

/* ---------- settings ---------- */
let _set = null;
async function settings() { if (!_set) { const d = await db.collection('settings').doc('main').get(); _set = d.exists ? d.data() : {}; } return _set; }
async function saveSettings(o) { _set = {...(await settings()), ...o}; await db.collection('settings').doc('main').set(_set, {merge: true}); }
const sheetId = v => { const m = String(v || '').match(/\/d\/([\w-]+)/); return m ? m[1] : String(v || '').trim(); };

/** POST json to an Apps Script web app (works straight from the browser, so no server / curl problems). */
async function post(url, payload) {
  try {
    const r = await fetch(url, {method: 'POST', headers: {'Content-Type': 'text/plain;charset=utf-8'}, body: JSON.stringify(payload)});
    const t = await r.text();
    try { return JSON.parse(t); } catch (e) { return {ok: false, error: 'The script did not return JSON. The URL must end with /exec and the deployment must be Who has access = Anyone (then New version).'}; }
  } catch (e) { return {ok: false, error: 'Cannot reach Google (' + e.message + ')'}; }
}

/* ---------- student / payment helpers ---------- */
async function nextCode() {
  const ref = db.collection('settings').doc('counter');
  const n = await db.runTransaction(async tx => { const d = await tx.get(ref); const v = (d.exists ? d.data().n : 0) + 1; tx.set(ref, {n: v}); return v; });
  return 'CICI-' + String(n).padStart(5, '0');
}
const qrImg = (v, size = 200) => 'https://api.qrserver.com/v1/create-qr-code/?size=' + size + 'x' + size + '&margin=6&data=' + encodeURIComponent(v);
const tabName = (ev, sec) => (!sec || sec === '-') ? ev : ev + ' - ' + sec;

/** Every student gets a payment row for every collection that has an amount for the student's SECTION. */
async function syncDues() {
  const [stu, evs, pays] = await Promise.all([getAll('students'), getAll('events'), getAll('payments')]);
  const have = {}; pays.forEach(p => have[p.id] = p);
  let ops = [];
  for (const s of stu) for (const e of evs) {
    const amt = (e.secAmounts || {})[s.section]; if (amt === undefined) continue;
    const id = e.id + '_' + s.id, p = have[id];
    if (!p) ops.push([id, {event_id: e.id, student_id: s.id, amount: +amt, paid: 0, paid_at: null, custom: false, via_scan: false, status: amt <= 0 ? 'paid' : 'unpaid', synced: true}, false]);
    else if (!p.custom && +p.amount !== +amt) ops.push([id, {amount: +amt, status: payStatus(+amt, +p.paid || 0), synced: p.via_scan ? false : true}, true]);
  }
  for (let i = 0; i < ops.length; i += 400) {
    const b = db.batch(); ops.slice(i, i + 400).forEach(([id, d, merge]) => b.set(db.collection('payments').doc(id), d, {merge})); await b.commit();
  }
  return ops.length;
}

const rowOf = (p, s, e) => { const due = +p.amount, paid = p.via_scan ? +p.paid || 0 : 0, bal = Math.max(0, due - paid), sec = s.section || '-';
  return {code: s.qr_code, name: s.full_name, section: sec, event: e.name, tab: tabName(e.name, sec), due, paid, balance: bal,
    status: paid <= 0 ? 'Unpaid' : (bal <= 0.004 ? 'Fully paid' : 'Balance left'), time: p.via_scan && p.paid_at ? fmt(p.paid_at) : ''}; };

/** Send one scanned payment to the Google Sheet. Returns [ok, error]. */
async function pushPayment(p, s, e) {
  const st = await settings(); if (!st.sheet_url) return [false, 'Google Sheet Web app URL is empty. Open Settings > Google Sheet.'];
  const j = await post(st.sheet_url, {action: 'log_payment', sheetId: sheetId(st.sheet_id), ...rowOf(p, s, e)});
  await db.collection('payments').doc(p.id || (e.id + '_' + s.id)).set({synced: !!j.ok}, {merge: true});
  return [!!j.ok, j.ok ? '' : (j.error || 'unknown error')];
}
/** Make sure the Sheet has one tab per collection+section with every student (never overwrites money already there). */
async function pushRoster(eventId) {
  const st = await settings(); if (!st.sheet_url) return [true, ''];
  const [stu, evs, pays] = await Promise.all([getAll('students'), getAll('events'), getAll('payments')]);
  const S = {}, E = {}; stu.forEach(x => S[x.id] = x); evs.forEach(x => E[x.id] = x);
  const tabs = {};
  pays.filter(p => (!eventId || p.event_id === eventId) && S[p.student_id] && E[p.event_id]).forEach(p => { const r = rowOf(p, S[p.student_id], E[p.event_id]); (tabs[r.tab] = tabs[r.tab] || []).push(r); });
  const list = Object.keys(tabs).map(t => ({tab: t, rows: tabs[t]}));
  for (let i = 0; i < list.length; i += 5) {
    const j = await post(st.sheet_url, {action: 'sync_roster', sheetId: sheetId(st.sheet_id), tabs: list.slice(i, i + 5)});
    if (!j.ok) return [false, j.error === 'unknown action' ? 'Re-deploy sheet_script.gs in Apps Script (New version).' : (j.error || 'No answer from Google.')];
  }
  return [true, list.length + ' Sheet tab(s) updated.'];
}
/** Email the student's permanent QR (through the Gmail Apps Script). Returns [ok, error]. */
async function mailQr(s) {
  const st = await settings();
  if (!st.mail_url || !st.mail_secret) return [false, 'Fill in Settings > QR Email first.'];
  if (!s.email || !/^\S+@\S+\.\S+$/.test(s.email)) return [false, 'No valid email for ' + s.full_name];
  const [evs, pays] = await Promise.all([getAll('events'), getAll('payments')]);
  const E = {}; evs.forEach(x => E[x.id] = x);
  const dues = pays.filter(p => p.student_id === s.id && E[p.event_id]).map(p => ({n: E[p.event_id].name, b: Math.max(0, p.amount - (p.paid || 0))}));
  const tot = dues.reduce((a, d) => a + d.b, 0), sender = st.sender_name || 'BayadQR';
  const rows = dues.map(d => `<tr><td style="padding:4px 0">${esc(d.n)}</td><td style="text-align:right">${d.b > 0 ? money(d.b) : 'Fully paid'}</td></tr>`).join('');
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;color:#222;max-width:460px"><p>Hi ${esc(s.full_name)},</p><p>Here is your personal QR code for school payments. Show it when you pay. It never changes.</p><p><img src="cid:qr" width="220" height="220" alt="QR"></p>${rows ? `<table style="width:100%;border-collapse:collapse">${rows}<tr><td style="border-top:1px solid #ddd"><b>Amount to pay</b></td><td style="border-top:1px solid #ddd;text-align:right"><b>${tot > 0 ? money(tot) : 'Fully paid'}</b></td></tr></table>` : ''}<p>Thank you,<br>${esc(sender)}</p></div>`;
  const j = await post(st.mail_url, {secret: st.mail_secret, action: 'send_qr', to: s.email, name: s.full_name, code: s.qr_code, subject: 'Your QR code', html, text: 'Your QR code: ' + s.qr_code, senderName: sender});
  if (j.ok) await db.collection('students').doc(s.id).set({qr_sent_at: Date.now()}, {merge: true});
  return [!!j.ok, j.ok ? '' : (j.error || 'failed')];
}

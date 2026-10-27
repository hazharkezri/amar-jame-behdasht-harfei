'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const L = require('./lib');
const X = require('./xlsx');
const { db, audit, verifyAudit, subtreeIds, inList, tx } = require('./db');
const { CAT, REP, TAB, IND, RULES, checkRules, computeReport, normVal } = require('./report');
const { importFile2 } = require('./import2');

const PORT = +process.env.PORT || 3000;
const SECURE = process.env.COOKIE_SECURE !== '0';
const DOMAINS = (process.env.ALLOWED_EMAIL_DOMAINS || 'ac.ir,gov.ir').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const IDLE = 30 * 60e3, ABS = 12 * 3600e3;
const NEXT = { country: 'university', university: 'county', county: 'center', center: 'base', base: 'house' };
const TYPE_FA = { country: 'ستاد کشوری', university: 'دانشگاه علوم پزشکی', county: 'شهرستان / مرکز بهداشت', center: 'مرکز خدمات جامع سلامت', base: 'پایگاه سلامت', house: 'خانه‌ی بهداشت' };
const STATUS_FA = { draft: 'پیش‌نویس', submitted: 'ارسال‌شده — منتظر تأیید', approved: 'تأییدشده (قفل)', returned: 'برگشت‌خورده برای اصلاح' };
const KPIS = ['PCT-B', 'PCT-C', 'PCT-D', 'PCT-E', 'PCT-F', 'PCT-H'];
const TABLES = Object.fromEntries(TAB.tables.map(t => [t.key, t]));

// ---------- helpers
const send = (res, code, obj, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }); res.end(JSON.stringify(obj)); };
const fail = (res, code, msg, extra) => send(res, code, { error: msg, ...(extra || {}) });
const file = (res, name, buf, type) => { res.writeHead(200, { 'Content-Type': type, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`, 'Cache-Control': 'no-store' }); res.end(buf); };
const XLSX_T = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const SEC = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Resource-Policy': 'same-origin'
};
const hits = new Map();
function limited(key, max, win = 60e3) {
  const t = Date.now(), a = (hits.get(key) || []).filter(x => t - x < win); a.push(t); hits.set(key, a); return a.length > max;
}
setInterval(() => { const n = Date.now(); for (const [k, a] of hits) if (!a.some(t => n - t < 3600e3)) hits.delete(k); }, 600e3).unref();
function body(req, limit) {
  return new Promise((ok, no) => { let n = 0; const ch = [];
    req.on('data', d => { n += d.length; if (n > limit) { no(new Error('big')); req.destroy(); } else ch.push(d); });
    req.on('end', () => { try { ok(ch.length ? JSON.parse(Buffer.concat(ch).toString('utf8')) : {}); } catch (e) { no(e); } }); });
}
const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map(s => s.trim().split('=')).filter(a => a[0]).map(a => [a[0], a.slice(1).join('=')]));
const ipOf = (req) => (process.env.TRUST_PROXY === '1' && req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : req.socket.remoteAddress) || '';
const now = () => Date.now();
const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const strongPw = (pw) => pw.length >= 12 && /[a-z]/i.test(pw) && /\d/.test(pw);

const unitOf = (id) => db.prepare('SELECT * FROM units WHERE id=?').get(id);
const isRoot = (u) => !!u && u.parent_id === null;
const scopeOf = (u) => subtreeIds(u.unit_id);
const inScope = (u, unitId) => scopeOf(u).includes(+unitId);
const isRootMgr = (u) => u.role === 'manager' && isRoot(unitOf(u.unit_id));
const publicUser = (u) => ({ id: u.id, full_name: u.full_name, role: u.role, unit_id: u.unit_id, unit: unitOf(u.unit_id), nid_last4: u.nid_last4, status: u.status });
function canManage(actor, unitId, role) {
  if (actor.role !== 'manager' || !inScope(actor, unitId)) return false;
  if (role === 'manager' && +unitId === actor.unit_id && !isRoot(unitOf(actor.unit_id))) return false;
  return true;
}
// آیا مسئول actor می‌تواند ارسال واحد unitId را تأیید یا برگشت دهد؟
function canDecide(actor, unitId) {
  if (actor.role !== 'manager' || !inScope(actor, unitId)) return false;
  return +unitId !== actor.unit_id || isRoot(unitOf(actor.unit_id));
}
const getSub = (per, unit) => db.prepare('SELECT * FROM submissions WHERE period_id=? AND unit_id=?').get(per, unit) || { period_id: per, unit_id: unit, status: 'draft' };
const editable = (per, unit) => ['draft', 'returned'].includes(getSub(per, unit).status);
function session(req) {
  const sid = cookies(req).sid; if (!sid) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE token_hash=?').get(L.sha(sid)); if (!s) return null;
  if (now() - s.last > IDLE || now() - s.created > ABS) { db.prepare('DELETE FROM sessions WHERE token_hash=?').run(s.token_hash); return null; }
  const u = db.prepare("SELECT * FROM users WHERE id=? AND status='active'").get(s.user_id); if (!u) return null;
  db.prepare('UPDATE sessions SET last=? WHERE token_hash=?').run(now(), s.token_hash);
  return { s, u };
}
// ---------- داده
function entriesOf(per, unit) {
  const o = {}; for (const r of db.prepare('SELECT ind_id,value FROM entries WHERE period_id=? AND unit_id=?').all(per, unit)) o[r.ind_id] = r.value; return o;
}
function numVals(per, unit) { const o = {}; for (const [k, v] of Object.entries(entriesOf(per, unit))) if (IND[k] && IND[k].kind === 'num') o[k] = Number(v) || 0; return o; }
function sums(per, unitId, onlyApproved) {
  let ids = subtreeIds(unitId);
  if (onlyApproved) { const ok = new Set(db.prepare("SELECT unit_id FROM submissions WHERE period_id=? AND status='approved'").all(per).map(r => r.unit_id)); ids = ids.filter(i => ok.has(i)); }
  if (!ids.length) return {};
  const out = {};
  for (const r of db.prepare(`SELECT ind_id, SUM(CAST(value AS REAL)) s FROM entries WHERE period_id=? AND unit_id IN (${inList(ids)}) GROUP BY ind_id`).all(per, ...ids)) if (IND[r.ind_id] && IND[r.ind_id].kind === 'num') out[r.ind_id] = r.s;
  return out;
}
function applyEntry(user, per, ind, raw, unit = user.unit_id) {
  const p = db.prepare('SELECT * FROM periods WHERE id=?').get(+per);
  if (!p || p.status !== 'open') return 'این دوره بسته است.';
  if (!IND[ind]) return 'شاخص نامعتبر.';
  if (!editable(p.id, unit)) return 'اطلاعات این واحد ارسال/تأیید شده و قفل است؛ برای ویرایش، مسئول باید آن را «برگشت» دهد.';
  let v = raw === null || raw === undefined ? '' : (IND[ind].kind === 'num' ? normVal(raw) : String(raw).trim().slice(0, 500));
  if (v !== '' && IND[ind].kind === 'num' && !/^\d{1,12}(\.\d{1,4})?$/.test(v)) return 'فقط عدد (صفر یا بزرگ‌تر) مجاز است.';
  const old = db.prepare('SELECT value FROM entries WHERE period_id=? AND unit_id=? AND ind_id=?').get(p.id, unit, ind);
  if ((old ? old.value : '') === v) return null;
  if (v === '') db.prepare('DELETE FROM entries WHERE period_id=? AND unit_id=? AND ind_id=?').run(p.id, unit, ind);
  else db.prepare('INSERT INTO entries(period_id,unit_id,ind_id,value,updated_by,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(period_id,unit_id,ind_id) DO UPDATE SET value=excluded.value,updated_by=excluded.updated_by,updated_at=excluded.updated_at').run(p.id, unit, ind, v, user.id, now());
  db.prepare('INSERT INTO entry_history(period_id,unit_id,ind_id,old,new,by_user,ts) VALUES(?,?,?,?,?,?,?)').run(p.id, unit, ind, old ? old.value : null, v, user.id, now());
  return null;
}
// ---------- مسیرها
const routes = [];
const R = (m, p, h, o = {}) => routes.push({ m, re: new RegExp('^' + p.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), h, auth: o.auth !== false, big: !!o.big });
 
R('GET', '/healthz', (c) => send(c.res, 200, { ok: true, ts: Date.now() }), { auth: false });
R('GET', '/api/health', (c) => send(c.res, 200, { ok: true, ts: Date.now() }), { auth: false });
R('GET', '/api/catalog', (c) => send(c.res, 200, {
  layout: CAT.layout, indicators: CAT.indicators.map(i => ({ id: i.id, title: i.title, kind: i.kind, blk: i.blk })),
  report: REP.map(r => ({ code: r.code, title: r.title, section: r.section, pct: r.pct })), rules: RULES,
  tables: TAB.tables.map(t => ({ key: t.key, title: t.title, cols: t.cols })), typeFa: TYPE_FA, statusFa: STATUS_FA, kpis: KPIS
}), { auth: false });
R('GET', '/api/me', (c) => send(c.res, 200, { user: publicUser(c.u), csrf: c.s.csrf }));

// --- ثبت‌نام و ورود
R('POST', '/api/register', (c) => {
  const b = c.b, ip = c.ip;
  if (limited('reg' + ip, 8, 3600e3)) return fail(c.res, 429, 'تعداد تلاش‌ها زیاد است؛ بعداً دوباره تلاش کنید.');
  const nid = L.validNid(b.nid), name = str(b.full_name, 100), email = str(b.email, 120).toLowerCase(), phone = str(b.phone, 20), pw = String(b.password || '');
  const GEN = 'ثبت‌نام انجام نشد: کد ملی در فهرست مجاز نیست یا اطلاعات نادرست است.';
  if (!nid || !name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail(c.res, 400, GEN);
  if (!strongPw(pw)) return fail(c.res, 400, 'رمز عبور حداقل ۱۲ کاراکتر و شامل حرف و عدد باشد.');
  const dom = email.split('@')[1];
  if (!DOMAINS.some(d => dom === d || dom.endsWith('.' + d))) return fail(c.res, 400, 'ایمیل باید ایمیل سازمانی (دانشگاه علوم پزشکی/دولتی) باشد.');
  const al = db.prepare('SELECT * FROM allow WHERE nid_hash=? AND used=0').get(L.hmac(nid));
  if (!al || db.prepare('SELECT 1 FROM users WHERE nid_hash=?').get(L.hmac(nid))) return fail(c.res, 400, GEN);
  const secret = L.newTotpSecret();
  const r = db.prepare('INSERT INTO users(nid_hash,nid_enc,nid_last4,full_name,phone,email,unit_id,role,pw_hash,totp_enc,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(L.hmac(nid), L.enc(nid), nid.slice(-4), name, phone, email, al.unit_id, al.role, L.hashPw(pw), L.enc(secret), now());
  db.prepare('UPDATE allow SET used=1 WHERE id=?').run(al.id);
  audit(+r.lastInsertRowid, 'register', { unit: al.unit_id }, ip);
  send(c.res, 200, { ok: true, totp_secret: secret, otpauth: `otpauth://totp/AmarSalamat:${nid.slice(-4)}?secret=${secret}&issuer=AmarSalamat` });
}, { auth: false });
function authenticate(b, ip) {
  const nid = L.validNid(b.nid), bad = { err: 'کد ملی، رمز یا کد دو‌مرحله‌ای نادرست است.' };
  if (!nid) return bad;
  const u = db.prepare('SELECT * FROM users WHERE nid_hash=?').get(L.hmac(nid)); if (!u) { L.hashPw('x'); return bad; }
  if (u.locked_until > now()) return { err: 'حساب به‌دلیل تلاش‌های ناموفق موقتاً قفل است. ۱۵ دقیقه بعد تلاش کنید.' };
  const okPw = L.checkPw(String(b.password || ''), u.pw_hash);
  const step = okPw ? L.totpVerify(L.dec(u.totp_enc), b.code, u.totp_last) : null;
  if (!okPw || !step) {
    const f = u.fails + 1; db.prepare('UPDATE users SET fails=?, locked_until=? WHERE id=?').run(f >= 5 ? 0 : f, f >= 5 ? now() + 15 * 60e3 : 0, u.id);
    audit(u.id, 'login_fail', {}, ip); return bad;
  }
  db.prepare('UPDATE users SET fails=0, totp_last=?, last_login=? WHERE id=?').run(step, now(), u.id);
  return { u };
}
R('POST', '/api/register/verify', (c) => {
  if (limited('ver' + c.ip, 15)) return fail(c.res, 429, 'تلاش بیش از حد.');
  const a = authenticate(c.b, c.ip); if (a.err) return fail(c.res, 401, a.err);
  db.prepare('UPDATE users SET totp_ok=1 WHERE id=?').run(a.u.id); audit(a.u.id, 'totp_verified', {}, c.ip);
  send(c.res, 200, { ok: true, status: a.u.status });
}, { auth: false });
R('POST', '/api/login', (c) => {
  if (limited('log' + c.ip, 20)) return fail(c.res, 429, 'تلاش بیش از حد؛ کمی بعد دوباره امتحان کنید.');
  const a = authenticate(c.b, c.ip); if (a.err) return fail(c.res, 401, a.err);
  const u = a.u;
  if (u.status === 'pending') return fail(c.res, 403, u.totp_ok ? 'حساب شما در انتظار تأیید مسئول بالادستی است.' : 'ابتدا تأیید برنامه‌ی احراز هویت را کامل کنید.');
  if (u.status !== 'active') return fail(c.res, 403, 'دسترسی این حساب فعال نیست.');
  const sid = crypto.randomBytes(32).toString('hex'), csrf = crypto.randomBytes(24).toString('hex');
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
  db.prepare('INSERT INTO sessions(token_hash,user_id,csrf,created,last,ip) VALUES(?,?,?,?,?,?)').run(L.sha(sid), u.id, csrf, now(), now(), c.ip);
  audit(u.id, 'login', {}, c.ip);
  send(c.res, 200, { ok: true }, { 'Set-Cookie': `sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${SECURE ? '; Secure' : ''}` });
}, { auth: false });
R('POST', '/api/otp/send', (c) => {
  if (limited('otp' + c.ip, 10, 300e3)) return fail(c.res, 429, 'تعداد تلاش‌ها زیاد است؛ کمی بعد دوباره تلاش کنید.');
  const nid = L.validNid(c.b.nid);
  if (!nid) return fail(c.res, 400, 'کد ملی نامعتبر است.');
  const u = db.prepare('SELECT * FROM users WHERE nid_hash=?').get(L.hmac(nid));
  if (!u || u.status !== 'active') return fail(c.res, 400, 'حساب فعالی با این کد ملی یافت نشد.');
  const code = String(Math.floor(100000 + Math.random() * 900000));
  db.prepare('UPDATE users SET otp_code=?, otp_expires=? WHERE id=?').run(code, now() + 5 * 60e3, u.id);
  audit(u.id, 'otp_send', {}, c.ip);
  // در حالت توسعه، کد در پاسخ برگردانده می‌شود؛ در تولید، کد از طریق پیامک ارسال می‌گردد.
  const dev = process.env.ALLOW_DEV_SECRET === '1' || process.env.NODE_ENV !== 'production';
  console.log('OTP for', nid.slice(-4), ':', code);
  send(c.res, 200, { ok: true, dev_code: dev ? code : undefined, message: dev ? 'کد یک‌بارمصرف (حالت توسعه)' : 'کد یک‌بارمصرف به شماره‌ی شما ارسال شد.' });
}, { auth: false });
R('POST', '/api/otp/verify', (c) => {
  if (limited('otpver' + c.ip, 15, 300e3)) return fail(c.res, 429, 'تعداد تلاش‌ها زیاد است.');
  const nid = L.validNid(c.b.nid), code = String(c.b.code || '').trim();
  if (!nid || !/^\d{6}$/.test(code)) return fail(c.res, 400, 'کد ملی یا کد یک‌بارمصرف نامعتبر است.');
  const u = db.prepare('SELECT * FROM users WHERE nid_hash=?').get(L.hmac(nid));
  if (!u || u.status !== 'active') return fail(c.res, 401, 'حساب فعالی یافت نشد.');
  if (!u.otp_code || u.otp_expires < now() || u.otp_code !== code) return fail(c.res, 401, 'کد یک‌بارمصرف نادرست یا منقضی شده است.');
  db.prepare('UPDATE users SET otp_code=NULL, otp_expires=NULL, fails=0, last_login=? WHERE id=?').run(now(), u.id);
  const sid = crypto.randomBytes(32).toString('hex'), csrf = crypto.randomBytes(24).toString('hex');
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
  db.prepare('INSERT INTO sessions(token_hash,user_id,csrf,created,last,ip) VALUES(?,?,?,?,?,?)').run(L.sha(sid), u.id, csrf, now(), now(), c.ip);
  audit(u.id, 'login_otp', {}, c.ip);
  send(c.res, 200, { ok: true }, { 'Set-Cookie': `sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${process.env.COOKIE_SECURE !== '0' ? '; Secure' : ''}` });
}, { auth: false });
R('POST', '/api/logout', (c) => { db.prepare('DELETE FROM sessions WHERE token_hash=?').run(c.s.token_hash); audit(c.u.id, 'logout', {}, c.ip); send(c.res, 200, { ok: true }, { 'Set-Cookie': 'sid=; Max-Age=0; Path=/' }); });
R('POST', '/api/password', (c) => {
  if (!L.checkPw(String(c.b.old_password || ''), c.u.pw_hash)) return fail(c.res, 403, 'رمز فعلی نادرست است.');
  const pw = String(c.b.new_password || ''); if (!strongPw(pw)) return fail(c.res, 400, 'رمز جدید حداقل ۱۲ کاراکتر و شامل حرف و عدد باشد.');
  db.prepare('UPDATE users SET pw_hash=? WHERE id=?').run(L.hashPw(pw), c.u.id); audit(c.u.id, 'password_change', {}, c.ip); send(c.res, 200, { ok: true });
});

// --- واحدها
R('GET', '/api/units', (c) => { const ids = scopeOf(c.u); send(c.res, 200, db.prepare(`SELECT id,parent_id,type,name FROM units WHERE id IN (${inList(ids)}) ORDER BY id`).all(...ids)); });
R('POST', '/api/units', (c) => {
  const parent = unitOf(+c.b.parent_id), name = str(c.b.name, 100);
  if (!parent || !name || !canManage(c.u, parent.id, 'expert')) return fail(c.res, 403, 'اجازه یا اطلاعات نامعتبر.');
  const t = NEXT[parent.type]; if (!t) return fail(c.res, 400, 'زیر مرکز خدمات جامع واحد دیگری تعریف نمی‌شود.');
  try { const r = db.prepare('INSERT INTO units(parent_id,type,name) VALUES(?,?,?)').run(parent.id, t, name); audit(c.u.id, 'unit_add', { name, parent: parent.id }, c.ip); send(c.res, 200, { id: +r.lastInsertRowid }); }
  catch (e) { fail(c.res, 400, 'نام تکراری است.'); }
});
R('POST', '/api/units/:id/rename', (c) => {
  const u = unitOf(+c.p.id), name = str(c.b.name, 100);
  if (!u || !name || !canManage(c.u, u.id, 'expert') || (+u.id === c.u.unit_id && !isRoot(u))) return fail(c.res, 403, 'اجازه ندارید.');
  try { db.prepare('UPDATE units SET name=? WHERE id=?').run(name, u.id); audit(c.u.id, 'unit_rename', { id: u.id, name }, c.ip); send(c.res, 200, { ok: true }); } catch (e) { fail(c.res, 400, 'نام تکراری است.'); }
});
R('DELETE', '/api/units/:id', (c) => {
  const u = unitOf(+c.p.id);
  if (!u || !canManage(c.u, u.id, 'expert') || (+u.id === c.u.unit_id && !isRoot(u))) return fail(c.res, 403, 'اجازه ندارید.');
  // cascade: delete all descendants
  const ids = subtreeIds(u.id);
  const ph = inList(ids);
  db.prepare(`DELETE FROM entries WHERE unit_id IN (${ph})`).run(...ids);
  db.prepare(`DELETE FROM entry_history WHERE unit_id IN (${ph})`).run(...ids);
  db.prepare(`DELETE FROM submissions WHERE unit_id IN (${ph})`).run(...ids);
  db.prepare(`DELETE FROM records WHERE unit_id IN (${ph})`).run(...ids);
  db.prepare(`DELETE FROM units WHERE id IN (${ph})`).run(...ids);
  audit(c.u.id, 'unit_del', { id: u.id, count: ids.length }, c.ip); send(c.res, 200, { ok: true });
});

// --- فهرست مجاز، کاربران، بارگذاری گروهی
R('GET', '/api/allow', (c) => {
  if (c.u.role !== 'manager') return fail(c.res, 403, 'اجازه ندارید.');
  const ids = scopeOf(c.u); send(c.res, 200, db.prepare(`SELECT id,nid_last4,unit_id,role,note,used FROM allow WHERE unit_id IN (${inList(ids)}) ORDER BY id DESC`).all(...ids));
});
function addAllow(actor, nidRaw, unit, role, note) {
  const nid = L.validNid(nidRaw); if (!nid) return 'کد ملی معتبر نیست';
  if (!canManage(actor, unit, role)) return 'اجازه‌ی ثبت برای این واحد/نقش را ندارید';
  try { db.prepare('INSERT INTO allow(nid_hash,nid_enc,nid_last4,unit_id,role,note,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)').run(L.hmac(nid), L.enc(nid), nid.slice(-4), unit, role, str(note, 100), actor.id, now()); return null; }
  catch (e) { return 'این کد ملی قبلاً در فهرست مجاز ثبت شده است'; }
}
R('POST', '/api/allow', (c) => {
  const err = addAllow(c.u, c.b.nid, +c.b.unit_id, c.b.role === 'manager' ? 'manager' : 'expert', c.b.note);
  if (err) return fail(c.res, 400, err); audit(c.u.id, 'allow_add', { unit: +c.b.unit_id }, c.ip); send(c.res, 200, { ok: true });
});
function parseTable(b) {
  if (b.csv) {
    const rows = String(b.csv).split(/\r?\n/).map(l => l.split(/[\t,;،]/).map(s => s.trim().replace(/^"|"$/g, ''))).filter(r => r.some(x => x));
    return rows;
  }
  const sh = X.read(Buffer.from(String(b.data || ''), 'base64'));
  const s = sh.find(x => /مجاز|کدملی|کد ملی/.test(x.name)) || sh[0]; if (!s) return [];
  return s.rows.filter(Boolean).map(r => Array.from(r, v => v == null ? '' : String(v)));
}
R('POST', '/api/allow/bulk', (c) => {
  if (c.u.role !== 'manager') return fail(c.res, 403, 'اجازه ندارید.');
  let rows; try { rows = parseTable(c.b); } catch (e) { return fail(c.res, 400, e.message || 'فایل قابل خواندن نیست.'); }
  if (rows.length && !L.validNid(rows[0][0]) && /کد|ملی|نام|واحد/.test(rows[0].join(' '))) rows.shift();       // سطر عنوان
  if (rows.length > 5000) return fail(c.res, 400, 'حداکثر ۵۰۰۰ ردیف در هر بار.');
  const ids = scopeOf(c.u), units = db.prepare(`SELECT id,name,type FROM units WHERE id IN (${inList(ids)})`).all(...ids);
  const byName = new Map(); for (const u of units) { const k = L.norm(u.name); byName.set(k, (byName.get(k) || []).concat(u)); }
  const ok = [], errors = [];
  rows.forEach((r, i) => {
    const [nid, name, unitName, roleTxt] = r, row = i + 1;
    const key = L.norm(unitName || '').replace(/^(شهرستان|مرکز بهداشت|مرکز|دانشگاه)\s+/, '');
    let cand = byName.get(L.norm(unitName || '')) || byName.get(key) || [];
    if (!cand.length) cand = [...byName].filter(([k]) => k.replace(/^(شهرستان|مرکز بهداشت|مرکز|دانشگاه)\s+/, '') === key).flatMap(([, v]) => v);
    if (cand.length !== 1) return errors.push({ row, msg: cand.length ? 'نام واحد مبهم است' : 'واحد پیدا نشد: ' + (unitName || '(خالی)') });
    const role = /مسئول|مدیر|رئیس|رییس|manager/i.test(roleTxt || '') ? 'manager' : 'expert';
    const n = L.validNid(nid); if (!n) return errors.push({ row, msg: 'کد ملی نامعتبر' });
    if (!canManage(c.u, cand[0].id, role)) return errors.push({ row, msg: 'اجازه‌ی ثبت برای این واحد/نقش را ندارید' });
    ok.push({ n, unit: cand[0].id, role, note: name || '' });
  });
  const seen = new Set(); const uniq = ok.filter(o => !seen.has(o.n) && seen.add(o.n));
  if (ok.length !== uniq.length) errors.push({ row: 0, msg: `${ok.length - uniq.length} کد ملی تکراری در فایل نادیده گرفته شد` });
  if (c.b.dry) return send(c.res, 200, { dry: true, valid: uniq.length, errors });
  let added = 0;
  tx(() => { for (const o of uniq) { const e = addAllow(c.u, o.n, o.unit, o.role, o.note); if (e) errors.push({ row: 0, msg: e }); else added++; } });
  audit(c.u.id, 'allow_bulk', { added, errors: errors.length }, c.ip); send(c.res, 200, { added, errors });
}, { big: true });
R('GET', '/api/allow/template.xlsx', (c) => {
  const ids = scopeOf(c.u), units = db.prepare(`SELECT name,type FROM units WHERE id IN (${inList(ids)}) ORDER BY id`).all(...ids);
  file(c.res, 'قالب-کدملی-کارشناسان.xlsx', X.build([
    { name: 'فهرست مجاز', header: 1, widths: [16, 28, 26, 14], rows: [['کد ملی', 'نام و نام خانوادگی', 'واحد (دقیقاً مطابق شیت «واحدها»)', 'نقش (کارشناس / مسئول)'], ['', '', units[1] ? units[1].name : '', 'کارشناس']] },
    { name: 'واحدها', header: 1, widths: [34, 24], rows: [['نام واحد', 'نوع'], ...units.map(u => [u.name, TYPE_FA[u.type]])] }]), XLSX_T);
});
R('DELETE', '/api/allow/:id', (c) => {
  const a = db.prepare('SELECT * FROM allow WHERE id=? AND used=0').get(+c.p.id);
  if (!a || !canManage(c.u, a.unit_id, a.role)) return fail(c.res, 403, 'اجازه ندارید.');
  db.prepare('DELETE FROM allow WHERE id=?').run(a.id); audit(c.u.id, 'allow_del', { id: a.id }, c.ip); send(c.res, 200, { ok: true });
});
R('GET', '/api/users', (c) => {
  if (c.u.role !== 'manager') return fail(c.res, 403, 'اجازه ندارید.');
  const ids = scopeOf(c.u);
  const rows = db.prepare(`SELECT * FROM users WHERE unit_id IN (${inList(ids)}) ORDER BY status,id DESC`).all(...ids).filter(u => u.id !== c.u.id && canManage(c.u, u.unit_id, u.role));
  send(c.res, 200, rows.map(u => ({ ...publicUser(u), email: u.email, phone: u.phone, totp_ok: !!u.totp_ok, last_login: u.last_login, nid: u.status === 'pending' ? L.dec(u.nid_enc) : undefined, unit_name: unitOf(u.unit_id).name })));
});
R('POST', '/api/users/:id/status', (c) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(+c.p.id), st = c.b.status;
  if (!u || !canManage(c.u, u.unit_id, u.role) || u.id === c.u.id) return fail(c.res, 403, 'اجازه ندارید.');
  if (!['active', 'rejected', 'suspended'].includes(st)) return fail(c.res, 400, 'وضعیت نامعتبر.');
  if (st === 'active' && !u.totp_ok) return fail(c.res, 400, 'کاربر هنوز برنامه‌ی احراز هویت را تأیید نکرده است.');
  db.prepare('UPDATE users SET status=?, approved_by=? WHERE id=?').run(st, c.u.id, u.id);
  if (st !== 'active') db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
  audit(c.u.id, 'user_' + st, { user: u.id }, c.ip); send(c.res, 200, { ok: true });
});
R('POST', '/api/users/:id/reset', (c) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(+c.p.id);
  if (!u || !canManage(c.u, u.unit_id, u.role) || u.id === c.u.id) return fail(c.res, 403, 'اجازه ندارید.');
  tx(() => {
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
    db.prepare('INSERT INTO allow(nid_hash,nid_enc,nid_last4,unit_id,role,note,created_by,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(nid_hash) DO UPDATE SET used=0,unit_id=excluded.unit_id,role=excluded.role')
      .run(u.nid_hash, u.nid_enc, u.nid_last4, u.unit_id, u.role, u.full_name + ' (بازنشانی)', c.u.id, now());
    db.prepare('DELETE FROM users WHERE id=?').run(u.id);
  });
  audit(c.u.id, 'user_reset', { user: u.id }, c.ip); send(c.res, 200, { ok: true });
});

// --- دوره‌ها
R('GET', '/api/periods', (c) => send(c.res, 200, db.prepare('SELECT * FROM periods ORDER BY id DESC').all()));
R('POST', '/api/periods', (c) => {
  if (!isRootMgr(c.u)) return fail(c.res, 403, 'فقط مسئول ستاد (ریشه) دوره تعریف می‌کند.');
  const label = str(c.b.label, 60); if (!label) return fail(c.res, 400, 'عنوان دوره را وارد کنید.');
  try { db.prepare('INSERT INTO periods(label) VALUES(?)').run(label); audit(c.u.id, 'period_add', { label }, c.ip); send(c.res, 200, { ok: true }); } catch (e) { fail(c.res, 400, 'دوره تکراری است.'); }
});
R('POST', '/api/periods/:id/status', (c) => {
  if (!isRootMgr(c.u)) return fail(c.res, 403, 'اجازه ندارید.');
  const st = c.b.status === 'closed' ? 'closed' : 'open'; db.prepare('UPDATE periods SET status=? WHERE id=?').run(st, +c.p.id);
  audit(c.u.id, 'period_' + st, { id: +c.p.id }, c.ip); send(c.res, 200, { ok: true });
});
R('PUT', '/api/periods/:id', (c) => {
  if (!isRootMgr(c.u)) return fail(c.res, 403, 'اجازه ندارید.');
  const label = str(c.b.label, 60); if (!label) return fail(c.res, 400, 'عنوان دوره را وارد کنید.');
  try { db.prepare('UPDATE periods SET label=? WHERE id=?').run(label, +c.p.id); audit(c.u.id, 'period_edit', { id: +c.p.id, label }, c.ip); send(c.res, 200, { ok: true }); }
  catch (e) { fail(c.res, 400, 'عنوان تکراری است.'); }
});
R('DELETE', '/api/periods/:id', (c) => {
  if (!isRootMgr(c.u)) return fail(c.res, 403, 'اجازه ندارید.');
  const id = +c.p.id;
  db.prepare('DELETE FROM entries WHERE period_id=?').run(id);
  db.prepare('DELETE FROM entry_history WHERE period_id=?').run(id);
  db.prepare('DELETE FROM submissions WHERE period_id=?').run(id);
  db.prepare('DELETE FROM periods WHERE id=?').run(id);
  audit(c.u.id, 'period_del', { id }, c.ip); send(c.res, 200, { ok: true });
});

// --- ورود آمار
R('GET', '/api/entries', (c) => {
  const unit = +c.q.unit || c.u.unit_id, per = +c.q.period;
  if (!inScope(c.u, unit) || (c.u.role === 'expert' && unit !== c.u.unit_id)) return fail(c.res, 403, 'اجازه ندارید.');
  send(c.res, 200, { values: entriesOf(per, unit), submission: getSub(per, unit) });
});
R('PUT', '/api/entries', (c) => {
  const unit = +c.b.unit || c.u.unit_id; if (!inScope(c.u, unit) || (c.u.role === 'expert' && unit !== c.u.unit_id)) return fail(c.res, 403, 'اجازه ندارید.');
  const e = applyEntry(c.u, c.b.period, String(c.b.ind || ''), c.b.value, unit); if (e) return fail(c.res, 400, e); send(c.res, 200, { ok: true });
});
R('POST', '/api/entries/batch', (c) => {          // برای ارسال صف آفلاین
  const items = Array.isArray(c.b.items) ? c.b.items.slice(0, 500) : [], res = [];
  for (const it of items) { const unit = +it.unit || c.u.unit_id; if (!inScope(c.u, unit) || (c.u.role === 'expert' && unit !== c.u.unit_id)) { res.push('اجازه ندارید.'); continue; } res.push(applyEntry(c.u, it.period, String(it.ind || ''), it.value, unit)); }
  send(c.res, 200, { results: res.map(e => e || null) });
});
R('GET', '/api/history', (c) => {
  const unit = +c.q.unit || c.u.unit_id; if (!inScope(c.u, unit) || (c.u.role === 'expert' && unit !== c.u.unit_id)) return fail(c.res, 403, 'اجازه ندارید.');
  send(c.res, 200, db.prepare('SELECT h.old,h.new,h.ts,u.full_name FROM entry_history h LEFT JOIN users u ON u.id=h.by_user WHERE h.period_id=? AND h.unit_id=? AND h.ind_id=? ORDER BY h.id DESC LIMIT 50').all(+c.q.period, unit, String(c.q.ind || '')));
});
R('GET', '/api/profile', (c) => {
  const t = unitOf(c.u.unit_id).type; send(c.res, 200, { hidden: db.prepare('SELECT sub_key FROM form_off WHERE unit_type=?').all(t).map(r => r.sub_key) });
});
R('GET', '/api/profile/all', (c) => { if (!isRootMgr(c.u)) return fail(c.res, 403, 'اجازه ندارید.'); send(c.res, 200, db.prepare('SELECT unit_type,sub_key FROM form_off').all()); });
R('POST', '/api/profile', (c) => {
  if (!isRootMgr(c.u)) return fail(c.res, 403, 'فقط مسئول ستاد.');
  const t = c.b.unit_type; if (!['country', 'university', 'county', 'center', 'base', 'house'].includes(t)) return fail(c.res, 400, 'نوع واحد نامعتبر.');
  const valid = new Set(CAT.layout.filter(x => x.t === 'sub').map(x => x.key));
  tx(() => {
    for (const k of c.b.hide || []) if (valid.has(k)) db.prepare('INSERT OR IGNORE INTO form_off(unit_type,sub_key) VALUES(?,?)').run(t, k);
    for (const k of c.b.show || []) db.prepare('DELETE FROM form_off WHERE unit_type=? AND sub_key=?').run(t, k);
  });
  audit(c.u.id, 'profile_update', { t, hide: (c.b.hide || []).length, show: (c.b.show || []).length }, c.ip); send(c.res, 200, { ok: true });
});
// --- ارسال، تأیید و قفل
R('POST', '/api/submit', (c) => {
  const per = db.prepare('SELECT * FROM periods WHERE id=?').get(+c.b.period), unit = +c.b.unit || c.u.unit_id;
  if (!per || per.status !== 'open') return fail(c.res, 400, 'این دوره بسته است.');
  if (!inScope(c.u, unit) || (c.u.role === 'expert' && unit !== c.u.unit_id)) return fail(c.res, 403, 'اجازه ندارید.');
  if (!editable(per.id, unit)) return fail(c.res, 400, 'اطلاعات قبلاً ارسال شده است.');
  const vals = numVals(per.id, unit);
  if (!Object.values(vals).some(v => v > 0)) return fail(c.res, 400, 'هنوز هیچ آماری ثبت نشده است.');
  const w = checkRules(vals);
  if (w.length && !c.b.ack) return fail(c.res, 409, 'قبل از ارسال، هشدارهای منطقی را بررسی کنید.', { warnings: w });
  db.prepare("INSERT INTO submissions(period_id,unit_id,status,submitted_by,submitted_at,note) VALUES(?,?,'submitted',?,?,NULL) ON CONFLICT(period_id,unit_id) DO UPDATE SET status='submitted',submitted_by=excluded.submitted_by,submitted_at=excluded.submitted_at,note=NULL")
    .run(per.id, unit, c.u.id, now());
  audit(c.u.id, 'submit', { period: per.id, unit, warnings: w.length }, c.ip); send(c.res, 200, { ok: true });
});
R('POST', '/api/submit/withdraw', (c) => {
  const unit = +c.b.unit || c.u.unit_id; if (!inScope(c.u, unit) || (c.u.role === 'expert' && unit !== c.u.unit_id)) return fail(c.res, 403, 'اجازه ندارید.');
  const s = getSub(+c.b.period, unit); if (s.status !== 'submitted') return fail(c.res, 400, 'فقط ارسال‌های منتظر تأیید قابل پس‌گرفتن هستند.');
  db.prepare("UPDATE submissions SET status='draft' WHERE period_id=? AND unit_id=?").run(s.period_id, s.unit_id); audit(c.u.id, 'withdraw', { period: s.period_id, unit }, c.ip); send(c.res, 200, { ok: true });
});
R('GET', '/api/approvals', (c) => {
  if (c.u.role !== 'manager') return fail(c.res, 403, 'اجازه ندارید.');
  const per = +c.q.period, ids = scopeOf(c.u).filter(i => canDecide(c.u, i));
  if (!ids.length) return send(c.res, 200, []);
  const out = db.prepare(`SELECT u.id unit_id,u.name,u.type,COALESCE(s.status,'draft') status,s.submitted_at,s.decided_at,s.note,(SELECT COUNT(*) FROM entries e WHERE e.period_id=? AND e.unit_id=u.id) filled
    FROM units u LEFT JOIN submissions s ON s.unit_id=u.id AND s.period_id=? WHERE u.id IN (${inList(ids)}) ORDER BY u.id`).all(per, per, ...ids);
  for (const r of out) r.warnings = r.status === 'submitted' ? checkRules(numVals(per, r.unit_id)).length : 0;
  send(c.res, 200, out);
});
R('POST', '/api/approvals/decide', (c) => {
  const per = db.prepare('SELECT * FROM periods WHERE id=?').get(+c.b.period), unit = +c.b.unit, act = c.b.action, note = str(c.b.note, 300);
  if (!per || per.status !== 'open') return fail(c.res, 400, 'این دوره بسته است.');
  if (!canDecide(c.u, unit)) return fail(c.res, 403, 'اجازه ندارید.');
  const s = getSub(per.id, unit);
  if (act === 'approve') { if (s.status !== 'submitted') return fail(c.res, 400, 'این واحد در انتظار تأیید نیست.'); }
  else if (act === 'return') { if (!['submitted', 'approved'].includes(s.status)) return fail(c.res, 400, 'قابل برگشت نیست.'); if (!note) return fail(c.res, 400, 'علت برگشت را بنویسید.'); }
  else return fail(c.res, 400, 'عملیات نامعتبر.');
  db.prepare('UPDATE submissions SET status=?,decided_by=?,decided_at=?,note=? WHERE period_id=? AND unit_id=?').run(act === 'approve' ? 'approved' : 'returned', c.u.id, now(), note || null, per.id, unit);
  audit(c.u.id, 'decision_' + act, { period: per.id, unit, note }, c.ip); send(c.res, 200, { ok: true });
});
R('GET', '/api/inbox', (c) => {
  const o = { returned: 0, pendingApprovals: 0, pendingUsers: 0, note: null };
  const per = (db.prepare("SELECT id FROM periods WHERE status='open' ORDER BY id DESC LIMIT 1").get() || {}).id;
  if (per) { const s = getSub(per, c.u.unit_id); o.status = s.status; if (s.status === 'returned') { o.returned = 1; o.note = s.note; } o.period = per; }
  if (c.u.role === 'manager') {
    if (per) { const ids = scopeOf(c.u).filter(i => canDecide(c.u, i)); if (ids.length) o.pendingApprovals = db.prepare(`SELECT COUNT(*) n FROM submissions WHERE period_id=? AND status='submitted' AND unit_id IN (${inList(ids)})`).get(per, ...ids).n; }
    const ids = scopeOf(c.u); o.pendingUsers = db.prepare(`SELECT COUNT(*) n FROM users WHERE status='pending' AND totp_ok=1 AND unit_id IN (${inList(ids)})`).get(...ids).n;
  }
  send(c.res, 200, o);
});
// --- گزارش، داشبورد و خروجی
function matrix(c) {
  const unit = +c.q.unit || c.u.unit_id, per = +c.q.period, only = c.q.approved === '1';
  if (!inScope(c.u, unit) || (c.u.role === 'expert' && unit !== c.u.unit_id)) return null;
  const kids = db.prepare('SELECT id,name,type FROM units WHERE parent_id=? ORDER BY id').all(unit);
  const cols = [{ id: unit, name: unitOf(unit).name + ' (جمع)', total: true }, ...kids.map(k => ({ id: k.id, name: k.name, status: getSub(per, k.id).status }))];
  return { unit, per, cols, data: cols.map(col => { const s = sums(per, col.id, only); return { s, r: computeReport(s) }; }) };
}
R('GET', '/api/rollup', (c) => { const m = matrix(c); if (!m) return fail(c.res, 403, 'اجازه ندارید.'); send(c.res, 200, { cols: m.cols, sums: m.data.map(d => d.s), report: m.data.map(d => d.r) }); });
R('GET', '/api/progress', (c) => {
  if (c.u.role === 'expert') return fail(c.res, 403, 'اجازه ندارید.');
  const per = +c.q.period, ids = scopeOf(c.u);
  send(c.res, 200, db.prepare(`SELECT unit_id, COUNT(*) n, MAX(updated_at) last FROM entries WHERE period_id=? AND unit_id IN (${inList(ids)}) GROUP BY unit_id`).all(per, ...ids));
});
R('GET', '/api/dashboard', (c) => {
  if (c.u.role === 'expert') return fail(c.res, 403, 'اجازه ندارید.');
  const unit = +c.q.unit || c.u.unit_id, per = +c.q.period; if (!inScope(c.u, unit)) return fail(c.res, 403, 'اجازه ندارید.');
  const only = c.q.approved === '1', kids = db.prepare('SELECT id,name FROM units WHERE parent_id=? ORDER BY id').all(unit);
  const pick = (r) => Object.fromEntries(KPIS.map(k => [k, r[k]]));
  const total = pick(computeReport(sums(per, unit, only)));
  const prev = db.prepare('SELECT id,label FROM periods WHERE id<? ORDER BY id DESC LIMIT 1').get(per);
  const status = { draft: 0, submitted: 0, approved: 0, returned: 0 };
  const rows = kids.map(k => { const s = getSub(per, k.id).status; status[s]++; return { id: k.id, name: k.name, status: s, filled: db.prepare('SELECT COUNT(*) n FROM entries WHERE period_id=? AND unit_id=?').get(per, k.id).n, kpi: pick(computeReport(sums(per, k.id, only))) }; });
  send(c.res, 200, { unit: unitOf(unit), total, prev: prev ? { label: prev.label, kpi: pick(computeReport(sums(prev.id, unit, only))) } : null, status, rows, kpis: KPIS.map(k => ({ code: k, title: (REP.find(r => r.code === k) || {}).title })) });
});
const indSheet = (m, own) => {
  const head = ['کد شاخص', 'عنوان شاخص', ...m.cols.map(x => x.name.replace(/ \(جمع\)$/, ''))], rows = [[], [], [], head];
  rows[0] = ['آمار جامع گروه سلامت کار — ' + (db.prepare('SELECT label FROM periods WHERE id=?').get(m.per) || {}).label]; rows[0].__style = 2;
  for (const it of CAT.layout) {
    if (it.t === 'sec') { const r = [null, it.title]; r.__style = 4; rows.push(r); }
    else if (it.t === 'ind' && IND[it.id].kind === 'num') rows.push([it.id, IND[it.id].title, ...own.map(s => s[it.id] ?? null)]);
  }
  return { name: 'ورود آمار', header: 4, headStyle: true, widths: [14, 70, ...m.cols.map(() => 16)], rows, freeze: { row: 4, col: 2 }, wrapB: true };
};
R('GET', '/api/export.xlsx', (c) => {
  const m = matrix(c); if (!m) return fail(c.res, 403, 'اجازه ندارید.');
  const own = m.cols.map(col => numVals(m.per, col.id));
  const s1 = indSheet(m, own);
  const rep = [['گزارش محاسباتی و درصدی'], [], [], ['کد', 'شاخص', ...m.cols.map(x => x.name)]];
  rep[0].__style = 2;
  for (const r of REP) rep.push([r.code, r.title, ...m.data.map(d => d.r[r.code])]);
  const sm = [['جمع زیرمجموعه‌ها (شامل همه‌ی سطوح پایین‌تر)'], [], [], ['کد شاخص', 'عنوان شاخص', ...m.cols.map(x => x.name)]]; sm[0].__style = 2;
  for (const it of CAT.indicators) if (it.kind === 'num') sm.push([it.id, it.title, ...m.data.map(d => d.s[it.id] ?? null)]);
  audit(c.u.id, 'export', { unit: m.unit }, c.ip);
  file(c.res, `آمار-${unitOf(m.unit).name}.xlsx`, X.build([s1, { name: 'جمع زیرمجموعه‌ها', header: 4, widths: [14, 70, ...m.cols.map(() => 16)], rows: sm, freeze: { row: 4, col: 2 } }, { name: 'گزارش محاسباتی', header: 4, widths: [12, 70, ...m.cols.map(() => 16)], rows: rep, freeze: { row: 4, col: 2 } }]), XLSX_T);
});
R('POST', '/api/import/entries', (c) => {
  const per = db.prepare('SELECT * FROM periods WHERE id=?').get(+c.b.period); if (!per || per.status !== 'open') return fail(c.res, 400, 'دوره بسته یا نامعتبر است.');
  let sheets; try { sheets = X.read(Buffer.from(String(c.b.data || ''), 'base64')); } catch (e) { return fail(c.res, 400, e.message || 'فایل قابل خواندن نیست.'); }
  const s = sheets.find(x => x.name === 'ورود آمار') || sheets[0]; if (!s) return fail(c.res, 400, 'شیت «ورود آمار» پیدا نشد.');
  const hr = s.rows.findIndex(r => r && String(r[0]).trim() === 'کد شاخص'); if (hr < 0) return fail(c.res, 400, 'سطر عنوان (کد شاخص) پیدا نشد؛ از «خروجی اکسل» همین سامانه یا فایل یکپارچه استفاده کنید.');
  const ids = scopeOf(c.u), units = db.prepare(`SELECT id,name FROM units WHERE id IN (${inList(ids)})`).all(...ids), byN = new Map(units.map(u => [L.norm(u.name).replace(/ \(جمع\)$/, ''), u]));
  const colUnit = []; (s.rows[hr] || []).forEach((h, i) => { if (i < 2 || h == null) return; const u = byN.get(L.norm(String(h)).replace(/ \(جمع\)$/, '')); if (u) colUnit[i] = u; });
  const report = { units: {}, applied: 0, skipped: 0, errors: [] };
  const todo = [];
  for (let r = hr + 1; r < s.rows.length; r++) {
    const row = s.rows[r]; if (!row || !IND[row[0]]) continue;
    colUnit.forEach((u, i) => { if (!u || row[i] === undefined || row[i] === '') return; todo.push({ u, ind: row[0], v: row[i] }); });
  }
  const byUnit = new Map(); for (const t of todo) { if (!byUnit.has(t.u.id)) byUnit.set(t.u.id, []); byUnit.get(t.u.id).push(t); }
  for (const [uid, items] of byUnit) {
    const u = units.find(x => x.id === uid);
    if (c.u.role === 'expert' && uid !== c.u.unit_id) { report.errors.push(`${u.name}: شما فقط برای واحد خودتان می‌توانید درون‌ریزی کنید`); continue; }
    if (!editable(per.id, uid)) { report.errors.push(`${u.name}: قفل است (ارسال/تأیید شده)`); continue; }
    report.units[u.name] = items.length;
    if (c.b.dry) continue;
    tx(() => { for (const t of items) { const e = applyEntry(c.u, per.id, t.ind, t.v, uid); if (e) { report.skipped++; if (report.errors.length < 20) report.errors.push(`${t.ind}: ${e}`); } else report.applied++; } });
  }
  if (!c.b.dry) audit(c.u.id, 'import_entries', { applied: report.applied, skipped: report.skipped }, c.ip);
  send(c.res, 200, { dry: !!c.b.dry, ...report });
}, { big: true });

// --- جدول‌های فایل ۲ (رکوردها)
function cleanRec(t, data) {
  const out = {};
  for (const col of t.cols) {
    let v = data ? data[col.k] : undefined; if (v === undefined || v === null || v === '') continue;
    v = String(v).trim().slice(0, 1000);
    if (col.type === 'num') { v = normVal(v); if (!/^-?\d{1,15}(\.\d{1,4})?$/.test(v)) throw new Error(`«${col.label}» باید عدد باشد.`); }
    else if (col.type === 'mark') v = '*';
    else if (col.type === 'list' && !col.options.some(o => o[0] === v)) throw new Error(`«${col.label}»: مقدار از فهرست گزینه‌ها نیست.`);
    out[col.k] = v;
  }
  return out;
}
R('GET', '/api/records', (c) => {
  const t = TABLES[c.q.table]; if (!t) return fail(c.res, 400, 'جدول نامعتبر.');
  const unit = +c.q.unit || c.u.unit_id; if (!inScope(c.u, unit) || (c.u.role === 'expert' && unit !== c.u.unit_id)) return fail(c.res, 403, 'اجازه ندارید.');
  const ids = subtreeIds(unit), q = str(c.q.q, 60), off = Math.max(0, +c.q.offset || 0);
  const where = `table_key=? AND unit_id IN (${inList(ids)})` + (q ? ' AND data LIKE ?' : ''), args = [t.key, ...ids, ...(q ? ['%' + q.replace(/[%_]/g, '') + '%'] : [])];
  const total = db.prepare(`SELECT COUNT(*) n FROM records WHERE ${where}`).get(...args).n;
  const rows = db.prepare(`SELECT r.id,r.unit_id,r.data,r.updated_at,u.name unit_name FROM records r JOIN units u ON u.id=r.unit_id WHERE ${where.replace(/table_key/, 'r.table_key').replace(/unit_id IN/, 'r.unit_id IN')} ORDER BY r.id DESC LIMIT 100 OFFSET ${off}`).all(...args);
  send(c.res, 200, { total, rows: rows.map(r => ({ ...r, data: JSON.parse(r.data) })) });
});
const recUnit = (c, t) => { const u = +c.b.unit_id || c.u.unit_id; if (!inScope(c.u, u) || (c.u.role === 'expert' && u !== c.u.unit_id)) return null; return u; };
R('POST', '/api/records', (c) => {
  const t = TABLES[c.b.table]; if (!t) return fail(c.res, 400, 'جدول نامعتبر.'); const unit = recUnit(c, t); if (!unit) return fail(c.res, 403, 'اجازه ندارید.');
  let d; try { d = cleanRec(t, c.b.data); } catch (e) { return fail(c.res, 400, e.message); }
  if (!Object.keys(d).length) return fail(c.res, 400, 'حداقل یک خانه را پر کنید.');
  const r = db.prepare('INSERT INTO records(table_key,unit_id,data,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(t.key, unit, JSON.stringify(d), c.u.id, c.u.id, now(), now());
  audit(c.u.id, 'record_add', { t: t.key, id: +r.lastInsertRowid }, c.ip); send(c.res, 200, { id: +r.lastInsertRowid });
});
const ownRec = (c) => { const r = db.prepare('SELECT * FROM records WHERE id=?').get(+c.p.id); if (!r || !inScope(c.u, r.unit_id) || (c.u.role === 'expert' && r.unit_id !== c.u.unit_id)) return null; return r; };
R('PUT', '/api/records/:id', (c) => {
  const r = ownRec(c); if (!r) return fail(c.res, 403, 'اجازه ندارید.'); const t = TABLES[r.table_key];
  let d; try { d = cleanRec(t, c.b.data); } catch (e) { return fail(c.res, 400, e.message); }
  db.prepare('UPDATE records SET data=?,updated_by=?,updated_at=? WHERE id=?').run(JSON.stringify(d), c.u.id, now(), r.id); audit(c.u.id, 'record_edit', { t: t.key, id: r.id }, c.ip); send(c.res, 200, { ok: true });
});
R('DELETE', '/api/records/:id', (c) => {
  const r = ownRec(c); if (!r) return fail(c.res, 403, 'اجازه ندارید.');
  db.prepare('DELETE FROM records WHERE id=?').run(r.id); audit(c.u.id, 'record_del', { t: r.table_key, id: r.id, data: r.data.slice(0, 300) }, c.ip); send(c.res, 200, { ok: true });
});
R('GET', '/api/records.xlsx', (c) => {
  const t = TABLES[c.q.table]; if (!t) return fail(c.res, 400, 'جدول نامعتبر.');
  const unit = +c.q.unit || c.u.unit_id; if (!inScope(c.u, unit) || (c.u.role === 'expert' && unit !== c.u.unit_id)) return fail(c.res, 403, 'اجازه ندارید.');
  const ids = subtreeIds(unit), rows = db.prepare(`SELECT r.data,u.name FROM records r JOIN units u ON u.id=r.unit_id WHERE r.table_key=? AND r.unit_id IN (${inList(ids)}) ORDER BY r.id`).all(t.key, ...ids);
  const grp = ['', ...t.cols.map(x => x.group)], head = ['واحد', ...t.cols.map(x => x.label)];
  audit(c.u.id, 'export_records', { t: t.key }, c.ip);
  file(c.res, `${t.title}.xlsx`, X.build([{ name: t.title.slice(0, 30), header: 2, widths: [22, ...t.cols.map(() => 18)], rows: [grp, head, ...rows.map(r => { const d = JSON.parse(r.data); return [r.name, ...t.cols.map(x => (x.type === 'num' && d[x.k] !== undefined) ? Number(d[x.k]) : d[x.k])]; })], freeze: { row: 2, col: 1 } }]), XLSX_T);
});
R('POST', '/api/import/file2', (c) => {
  if (!isRootMgr(c.u)) return fail(c.res, 403, 'فقط مسئول ستاد می‌تواند فایل ۲ را درون‌ریزی کند.');
  let r; try { r = importFile2(Buffer.from(String(c.b.data || ''), 'base64'), { root: c.u.unit_id, actor: c.u.id, dry: !!c.b.dry }); } catch (e) { return fail(c.res, 400, e.message || 'فایل قابل خواندن نیست.'); }
  if (!c.b.dry) audit(c.u.id, 'import_file2', { imported: r.total }, c.ip);
  send(c.res, 200, r);
}, { big: true });
R('GET', '/api/audit', (c) => {
  if (!isRootMgr(c.u)) return fail(c.res, 403, 'اجازه ندارید.');
  send(c.res, 200, { verify: verifyAudit(), rows: db.prepare('SELECT a.id,a.ts,a.user_id,u.full_name,a.action,a.detail,a.ip FROM audit a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 300').all() });
});

// ---------- سرور
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const PUB = path.join(__dirname, 'public');
const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SEC)) res.setHeader(k, v);
  const url = new URL(req.url, 'http://x'), ip = ipOf(req);
  try {
    if (url.pathname.startsWith('/api/')) {
      const rt = routes.map(r => ({ r, m: url.pathname.match(r.re) })).find(x => x.m && x.r.m === req.method);
      if (!rt) return fail(res, 404, 'یافت نشد');
      const ctx = { req, res, ip, q: Object.fromEntries(url.searchParams), p: rt.m.groups || {}, b: {} };
      if (req.method !== 'GET') {
        if ((req.headers['content-type'] || '').indexOf('application/json') < 0 && +req.headers['content-length'] > 0) return fail(res, 415, 'نوع درخواست نامعتبر');
        ctx.b = await body(req, rt.r.big ? 15e6 : 1e6);
      }
      if (rt.r.auth) {
        const ss = session(req); if (!ss) return fail(res, 401, 'نیاز به ورود');
        if (req.method !== 'GET' && req.headers['x-csrf'] !== ss.s.csrf) return fail(res, 403, 'درخواست نامعتبر (CSRF)');
        Object.assign(ctx, { u: ss.u, s: ss.s });
      }
      return await rt.r.h(ctx);
    }
    const f = url.pathname === '/' ? '/index.html' : url.pathname, fp = path.join(PUB, path.normalize(f).replace(/^(\.\.[/\\])+/, ''));
    if (!fp.startsWith(PUB + path.sep) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { res.writeHead(404); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); fs.createReadStream(fp).pipe(res);
  } catch (e) { console.error(e.message); if (!res.headersSent) fail(res, 400, 'درخواست نامعتبر'); }
});
if (require.main === module) server.listen(PORT, process.env.HOST || '127.0.0.1', () => console.log('listening on', PORT));
module.exports = { server };

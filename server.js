'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const L = require('./lib');
const X = require('./xlsx');
const { db, audit, verifyAudit, subtreeIds, inList, tx } = require('./db');
require('./bootstrap');
const RPT = require('./report');
const { checkRules, computeReport, normVal } = RPT;
let { CAT, REP, TAB, IND, RULES } = RPT.getCatalog();
const { importFile2 } = require('./import2');

const PORT = +process.env.PORT || 3000;
const SECURE = process.env.COOKIE_SECURE !== '0';
const DOMAINS = (process.env.ALLOWED_EMAIL_DOMAINS || 'ac.ir,gov.ir').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const IDLE = 30 * 60e3, ABS = 12 * 3600e3;
const STATELESS = process.env.STATELESS_AUTH === '1';
const NEXT = { country: 'university', university: 'county', county: 'center', center: 'base', base: 'house' };
const TYPE_FA = { country: 'ستاد کشوری', university: 'دانشگاه علوم پزشکی', county: 'شهرستان / مرکز بهداشت', center: 'مرکز خدمات جامع سلامت', base: 'پایگاه سلامت', house: 'خانه‌ی بهداشت' };
const ROLE_FA = { expert_ohs: 'کارشناس بهداشت حرفه‌ای', behvarz: 'بهورز', expert_ehs: 'کارشناس بهداشت محیط', responsible_ohs: 'کارشناس مسئول بهداشت حرفه‌ای', manager_ohs: 'مدیر گروه بهداشت حرفه‌ای' };
const ROLES = ['expert_ohs', 'behvarz', 'expert_ehs', 'responsible_ohs', 'manager_ohs'];
const MANAGER_ROLES = new Set(['responsible_ohs', 'manager_ohs']);
const isManagerRole = (r) => MANAGER_ROLES.has(r);
const STATUS_FA = { draft: 'پیش‌نویس', submitted: 'ارسال‌شده — منتظر تأیید شهرستان', county_approved: 'تأیید شهرستان — منتظر تأیید دانشگاه', approved: 'تأیید نهایی (قفل)', returned: 'برگشت‌خورده برای اصلاح' };
const KPIS = ['PCT-B', 'PCT-C', 'PCT-D', 'PCT-E', 'PCT-F', 'PCT-H'];
let TABLES = Object.fromEntries(TAB.tables.map(t => [t.key, t]));
const CAT_KINDS = ['layout', 'indicators', 'report', 'tables', 'rules'];
function refreshCatalog() { ({ CAT, REP, TAB, IND, RULES } = RPT.getCatalog()); TABLES = Object.fromEntries(TAB.tables.map(t => [t.key, t])); }
const catalogState = () => ({ layout: CAT.layout, indicators: CAT.indicators, report: REP, tables: TAB.tables, rules: RULES });
function persistCatalog() {
  const d = catalogState();
  for (const k of CAT_KINDS) db.prepare('INSERT INTO catalog_edit(kind,data,updated_at) VALUES(?,?,?) ON CONFLICT(kind) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at')
    .run(k, JSON.stringify(d[k]), now());
}
try {
  const patch = {};
  for (const r of db.prepare('SELECT kind,data FROM catalog_edit').all()) if (CAT_KINDS.includes(r.kind)) {
    const v = JSON.parse(r.data); if (Array.isArray(v)) patch[r.kind] = v;
  }
  if (Object.keys(patch).length) { RPT.setCatalog(patch); refreshCatalog(); }
} catch (e) { console.error('catalog_edit ignored:', e.message); }

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
const isRootMgr = (u) => isManagerRole(u.role) && isRoot(unitOf(u.unit_id));
const publicUser = (u) => ({ id: u.id, full_name: u.full_name, role: u.role, unit_id: u.unit_id, unit: unitOf(u.unit_id), nid_last4: u.nid_last4, status: u.status });
function canManage(actor, unitId, role) {
  if (!isManagerRole(actor.role) || !inScope(actor, unitId)) return false;
  if (isManagerRole(role) && +unitId === actor.unit_id && !isRoot(unitOf(actor.unit_id))) return false;
  return true;
}
// آیا مسئول actor می‌تواند ارسال واحد unitId را تأیید یا برگشت دهد؟
function canDecide(actor, unitId) {
  if (!isManagerRole(actor.role) || !inScope(actor, unitId)) return false;
  return +unitId !== actor.unit_id || isRoot(unitOf(actor.unit_id));
}
const getSub = (per, unit) => db.prepare('SELECT * FROM submissions WHERE period_id=? AND unit_id=?').get(per, unit) || { period_id: per, unit_id: unit, status: 'draft', confirmations: '{}' };
function parseConfirmations(s) { try { return JSON.parse(s.confirmations || '{}') || {}; } catch { return {}; } }
function unitCountyId(unitId) { let u = unitOf(unitId); while (u && u.type !== 'county' && u.parent_id != null) u = unitOf(u.parent_id); return u && u.type === 'county' ? u.id : null; }
function needsCountyApproval(unitId) { const u = unitOf(unitId); return !!u && u.type !== 'county' && u.type !== 'university' && u.type !== 'country' && !!unitCountyId(unitId); }
function firstApprovalStatus(unitId) { return 'submitted'; }
function nextApprovalStatus(unitId, current) {
  if (current === 'submitted') return needsCountyApproval(unitId) ? 'county_approved' : 'approved';
  if (current === 'county_approved') return 'approved';
  return null;
}
function canDecideStage(actor, unitId, status) {
  if (!canDecide(actor, unitId)) return false;
  if (status === 'submitted') {
    if (!needsCountyApproval(unitId)) return true;
    const countyId = unitCountyId(unitId);
    return !!countyId && inScope(actor, countyId);
  }
  if (status === 'county_approved') {
    const u = unitOf(actor.unit_id);
    return !!u && (u.type === 'university' || u.type === 'country' || isRoot(u));
  }
  return false;
}
const editable = (per, unit) => ['draft', 'returned'].includes(getSub(per, unit).status);
function makeStatelessSession(u) {
  const payload = Buffer.from(JSON.stringify({ uid: u.id, csrf: crypto.randomBytes(24).toString('hex'), created: now() })).toString('base64url');
  return payload + '.' + L.hmac(payload);
}
function readStateless(sid) {
  const parts = String(sid).split('.'); if (parts.length !== 2) return null;
  const [payload, sig] = parts; if (!payload || !sig || L.hmac(payload) !== sig) return null;
  let o; try { o = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch (e) { return null; }
  if (!o || !o.uid || !o.csrf || !o.created) return null;
  const t = now() - o.created; if (t < 0 || t > IDLE || t > ABS) return null;
  return o;
}
function otpCodeAt(nid, step) { return String(parseInt(L.hmac(nid + ':' + step).slice(0, 12), 16) % 1000000).padStart(6, '0'); }
function otpValid(u, code, nid) {
  if (!STATELESS) return !!u.otp_code && u.otp_expires >= now() && u.otp_code === code;
  const step = Math.floor(now() / 300e3);
  return [step, step - 1].some(s => otpCodeAt(nid, s) === code);
}
function session(req) {
  const sid = cookies(req).sid; if (!sid) return null;
  if (STATELESS) {
    const o = readStateless(sid); if (!o) return null;
    const u = db.prepare("SELECT * FROM users WHERE id=? AND status='active'").get(o.uid); if (!u) return null;
    return { s: { csrf: o.csrf, created: o.created, token_hash: L.sha(sid) }, u };
  }
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
// نمایش فرمول به شکلی که دوباره توسط parseFormula خوانده شود؛ پرانتزهای اضافیِ SUM در توکنهای متنی حذف میشوند
function formulaText(toks) {
  let close = 0;
  return (toks || []).map(t => {
    if (t[0] === 's') return 'SUM(' + (t[1] || []).join(',') + ')';
    if (t[0] === 'r') return 'R(' + t[1] + ')';
    let lit = String(t[1] || '');
    const opens = (lit.match(/SUM\(/g) || []).length;
    if (opens) { lit = lit.replace(/SUM\(/g, ''); close += opens; }
    while (close > 0 && lit.startsWith(')')) { lit = lit.slice(1); close--; }
    return lit;
  }).join('');
}
function parseFormula(input) {
  const s = String(input || ''), out = []; let buf = '', i = 0;
  const flush = () => { if (!buf) return; if (!/^[\d\s+\-*/().,%]*$/.test(buf)) throw new Error('فرمول فقط شامل عدد، عملگرها، SUM(...) و R(...) باشد.'); out.push(['l', buf]); buf = ''; };
  while (i < s.length) {
    if (s.startsWith('SUM(', i)) { flush(); const j = s.indexOf(')', i + 4); if (j < 0) throw new Error('پرانتز SUM بسته نشده است.'); const ids = s.slice(i + 4, j).split(',').map(x => x.trim()).filter(Boolean); if (!ids.length) throw new Error('SUM خالی است.'); out.push(['s', ids]); i = j + 1; continue; }
    if (s.startsWith('R(', i)) { flush(); const j = s.indexOf(')', i + 2); if (j < 0) throw new Error('پرانتز R بسته نشده است.'); const code = s.slice(i + 2, j).trim(); if (!code) throw new Error('کد شاخص محاسباتی خالی است.'); out.push(['r', code]); i = j + 1; continue; }
    if ((s[i] === 'R' || s[i] === 'r') && s[i + 1] === ':') { flush(); let j = i + 2; while (j < s.length && /[\w-]/.test(s[j])) j++; out.push(['r', s.slice(i + 2, j)]); i = j; continue; }
    buf += s[i++];
  }
  flush(); if (!out.length) throw new Error('فرمول خالی است.'); return out;
}
function normCatItem(kind, raw, key, st) {
  const r = raw || {}, s = (v, n = 200) => str(v, n);
  if (kind === 'layout') {
    if (r.t === 'sec') { const title = s(r.title), blk = s(r.blk, 20); if (!title || !blk) throw new Error('عنوان و کد بخش الزامی است.'); return { t: 'sec', title, blk }; }
    if (r.t === 'sub') { const title = s(r.title), blk = s(r.blk, 20), k = s(r.key, 300); if (!title || !blk || !k) throw new Error('عنوان، کد بخش و کلید subsection الزامی است.'); return { t: 'sub', title, blk, key: k }; }
    if (r.t === 'ind') { const id = s(r.id, 50); if (!IND[id]) throw new Error('شاخصی با این کد وجود ندارد.'); return { t: 'ind', id }; }
    throw new Error('نوع ردیف نامعتبر است.');
  }
  if (kind === 'indicators') {
    const id = s(key || r.id, 50); if (!/^[A-Za-z0-9_-]{1,50}$/.test(id)) throw new Error('کد شاخص نامعتبر است.');
    if (!key && IND[id]) throw new Error('کد شاخص تکراری است.');
    const title = s(r.title); if (!title) throw new Error('عنوان شاخص الزامی است.');
    return { id, title, kind: ['num', 'text'].includes(r.kind) ? r.kind : 'num', blk: s(r.blk, 20) || id.split('-')[0], src: s(r.src, 20) };
  }
  if (kind === 'report') {
    const code = s(key || r.code, 50); if (!/^[A-Za-z0-9_-]{1,50}$/.test(code)) throw new Error('کد گزارش نامعتبر است.');
    if (!key && REP.some(x => x.code === code)) throw new Error('کد گزارش تکراری است.');
    const title = s(r.title); if (!title) throw new Error('عنوان گزارش الزامی است.');
    return { code, title, section: s(r.section), pct: !!r.pct, toks: parseFormula(r.formula) };
  }
  if (kind === 'tables') {
    const k = s(key || r.key, 50); if (!/^[A-Za-z0-9_-]{1,50}$/.test(k)) throw new Error('کلید جدول نامعتبر است.');
    if (!key && TAB.tables.some(x => x.key === k)) throw new Error('کلید جدول تکراری است.');
    let cols = r.cols, imp = r.import;
    if (typeof cols === 'string') cols = JSON.parse(cols); if (typeof imp === 'string') imp = JSON.parse(imp);
    if (!Array.isArray(cols) || !cols.length) throw new Error('ستونهای جدول الزامی است.');
    cols = cols.map(x => {
      const type = ['num', 'text', 'mark', 'list'].includes(x.type) ? x.type : 'text';
      const c = { k: s(x.k, 40), label: s(x.label, 100), type, group: s(x.group, 100) };
      if (type === 'list') c.options = (Array.isArray(x.options) ? x.options : []).map(o => [s(o[0], 40), s(o[1], 100)]);
      return c;
    });
    if (cols.some(x => !x.k || !x.label)) throw new Error('کلید و عنوان هر ستون الزامی است.');
    return { key: k, title: s(r.title, 200) || k, sheet: s(r.sheet, 200), cols, import: imp && typeof imp === 'object' ? imp : {} };
  }
  if (kind === 'rules') {
    const a = s(r.a, 50), b = Array.isArray(r.b) ? r.b.map(x => s(x, 50)) : String(r.b || '').split(/[،,\s]+/).filter(Boolean);
    if (!IND[a] || !b.length || b.some(x => !IND[x])) throw new Error('شاخصهای قاعده معتبر نیستند.');
    return { a, b };
  }
  throw new Error('نوع کاتالوگ نامعتبر است.');
}
const catIndex = (arr, kind, key) => (kind === 'layout' || kind === 'rules' ? +key : arr.findIndex(x => (kind === 'indicators' ? x.id : kind === 'report' ? x.code : x.key) === key));
function applyCatalog(patch) { RPT.setCatalog(patch); refreshCatalog(); persistCatalog(); }
 
R('GET', '/healthz', (c) => send(c.res, 200, { ok: true, ts: Date.now() }), { auth: false });
R('GET', '/api/health', (c) => send(c.res, 200, { ok: true, ts: Date.now() }), { auth: false });
R('GET', '/api/catalog', (c) => send(c.res, 200, {
  layout: CAT.layout, indicators: CAT.indicators.map(i => ({ id: i.id, title: i.title, kind: i.kind, blk: i.blk })),
  report: REP.map(r => ({ code: r.code, title: r.title, section: r.section, pct: r.pct })), rules: RULES,
  tables: TAB.tables.map(t => ({ key: t.key, title: t.title, cols: t.cols })), typeFa: TYPE_FA, roleFa: ROLE_FA, statusFa: STATUS_FA, kpis: KPIS
}), { auth: false });
R('GET', '/api/catalog/manage', (c) => {
  if (!isRootMgr(c.u)) return fail(c.res, 403, 'اجازه ندارید.');
  const d = catalogState();
  send(c.res, 200, { ...d, report: d.report.map(r => ({ ...r, formula: formulaText(r.toks) })) });
});
R('POST', '/api/catalog/reset', (c) => {
  if (!isRootMgr(c.u)) return fail(c.res, 403, 'اجازه ندارید.');
  db.prepare('DELETE FROM catalog_edit').run(); RPT.resetCatalog(); refreshCatalog(); persistCatalog();
  audit(c.u.id, 'catalog_reset', {}, c.ip); send(c.res, 200, { ok: true });
});
R('POST', '/api/catalog/:kind', (c) => {
  if (!isRootMgr(c.u)) return fail(c.res, 403, 'اجازه ندارید.');
  const kind = c.p.kind; if (!CAT_KINDS.includes(kind)) return fail(c.res, 400, 'نوع کاتالوگ نامعتبر است.');
  let item; try { item = normCatItem(kind, c.b.item || c.b, null, catalogState()); } catch (e) { return fail(c.res, 400, e.message); }
  const patch = { [kind]: [...catalogState()[kind], item] };
  applyCatalog(patch); audit(c.u.id, 'catalog_add', { kind }, c.ip); send(c.res, 200, { ok: true });
});
R('PUT', '/api/catalog/:kind/:key', (c) => {
  if (!isRootMgr(c.u)) return fail(c.res, 403, 'اجازه ندارید.');
  const kind = c.p.kind, key = c.p.key; if (!CAT_KINDS.includes(kind)) return fail(c.res, 400, 'نوع کاتالوگ نامعتبر است.');
  const arr = [...catalogState()[kind]], idx = catIndex(arr, kind, key); if (!(idx >= 0)) return fail(c.res, 404, 'ردیف پیدا نشد.');
  let item; try { item = normCatItem(kind, c.b.item || c.b, kind === 'layout' || kind === 'rules' ? null : key, catalogState()); } catch (e) { return fail(c.res, 400, e.message); }
  arr[idx] = item; applyCatalog({ [kind]: arr }); audit(c.u.id, 'catalog_edit', { kind, key }, c.ip); send(c.res, 200, { ok: true });
});
R('DELETE', '/api/catalog/:kind/:key', (c) => {
  if (!isRootMgr(c.u)) return fail(c.res, 403, 'اجازه ندارید.');
  const kind = c.p.kind, key = c.p.key; if (!CAT_KINDS.includes(kind)) return fail(c.res, 400, 'نوع کاتالوگ نامعتبر است.');
  const st = catalogState(), arr = [...st[kind]], idx = catIndex(arr, kind, key); if (!(idx >= 0)) return fail(c.res, 404, 'ردیف پیدا نشد.');
  const patch = { [kind]: arr.filter((_, i) => i !== idx) };
  if (kind === 'layout') {
    const cut = new Set([idx]); const it = arr[idx];
    if (it.t === 'sec') for (let i = idx + 1; i < arr.length && arr[i].t !== 'sec'; i++) cut.add(i);
    if (it.t === 'sub') for (let i = idx + 1; i < arr.length && arr[i].t === 'ind'; i++) cut.add(i);
    patch.layout = arr.filter((_, i) => !cut.has(i));
  }
  if (kind === 'indicators') patch.layout = st.layout.filter(x => x.t !== 'ind' || x.id !== key);
  applyCatalog(patch); audit(c.u.id, 'catalog_del', { kind, key }, c.ip); send(c.res, 200, { ok: true });
});
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
  const sid = STATELESS ? makeStatelessSession(u) : crypto.randomBytes(32).toString('hex');
  const csrf = STATELESS ? readStateless(sid).csrf : crypto.randomBytes(24).toString('hex');
  if (!STATELESS) {
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
    db.prepare('INSERT INTO sessions(token_hash,user_id,csrf,created,last,ip) VALUES(?,?,?,?,?,?)').run(L.sha(sid), u.id, csrf, now(), now(), c.ip);
  }
  audit(u.id, 'login', {}, c.ip);
  send(c.res, 200, { ok: true }, { 'Set-Cookie': `sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${SECURE ? '; Secure' : ''}` });
}, { auth: false });
R('POST', '/api/otp/send', (c) => {
  if (limited('otp' + c.ip, 10, 300e3)) return fail(c.res, 429, 'تعداد تلاش‌ها زیاد است؛ کمی بعد دوباره تلاش کنید.');
  const nid = L.validNid(c.b.nid);
  if (!nid) return fail(c.res, 400, 'کد ملی نامعتبر است.');
  const u = db.prepare('SELECT * FROM users WHERE nid_hash=?').get(L.hmac(nid));
  if (!u || u.status !== 'active') return fail(c.res, 400, 'حساب فعالی با این کد ملی یافت نشد.');
  const code = STATELESS ? otpCodeAt(nid, Math.floor(now() / 300e3)) : String(Math.floor(100000 + Math.random() * 900000));
  if (!STATELESS) db.prepare('UPDATE users SET otp_code=?, otp_expires=? WHERE id=?').run(code, now() + 5 * 60e3, u.id);
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
  if (!otpValid(u, code, nid)) return fail(c.res, 401, 'کد یک‌بارمصرف نادرست یا منقضی شده است.');
  if (!STATELESS) db.prepare('UPDATE users SET otp_code=NULL, otp_expires=NULL, fails=0, last_login=? WHERE id=?').run(now(), u.id);
  else db.prepare('UPDATE users SET fails=0, last_login=? WHERE id=?').run(now(), u.id);
  const sid = STATELESS ? makeStatelessSession(u) : crypto.randomBytes(32).toString('hex');
  const csrf = STATELESS ? readStateless(sid).csrf : crypto.randomBytes(24).toString('hex');
  if (!STATELESS) {
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
    db.prepare('INSERT INTO sessions(token_hash,user_id,csrf,created,last,ip) VALUES(?,?,?,?,?,?)').run(L.sha(sid), u.id, csrf, now(), now(), c.ip);
  }
  audit(u.id, 'login_otp', {}, c.ip);
  send(c.res, 200, { ok: true }, { 'Set-Cookie': `sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${process.env.COOKIE_SECURE !== '0' ? '; Secure' : ''}` });
}, { auth: false });
R('POST', '/api/logout', (c) => { if (!STATELESS) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(c.s.token_hash); audit(c.u.id, 'logout', {}, c.ip); send(c.res, 200, { ok: true }, { 'Set-Cookie': 'sid=; Max-Age=0; Path=/' }); });
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
  if (!u || isRoot(u) || !canManage(c.u, u.id, 'expert') || (+u.id === c.u.unit_id && !isRoot(u))) return fail(c.res, 403, 'اجازه ندارید یا واحد ریشه قابل حذف نیست.');
  // cascade: delete all descendants; people and invitations move to the parent so no FK breaks
  const ids = subtreeIds(u.id), ph = inList(ids), parent = u.parent_id;
  tx(() => {
    for (const t of ['users', 'allow', 'imported_experts']) db.prepare(`UPDATE ${t} SET unit_id=? WHERE unit_id IN (${ph})`).run(parent, ...ids);
    db.prepare(`DELETE FROM entries WHERE unit_id IN (${ph})`).run(...ids);
    db.prepare(`DELETE FROM entry_history WHERE unit_id IN (${ph})`).run(...ids);
    db.prepare(`DELETE FROM submissions WHERE unit_id IN (${ph})`).run(...ids);
    db.prepare(`DELETE FROM records WHERE unit_id IN (${ph})`).run(...ids);
    db.prepare(`DELETE FROM units WHERE id IN (${ph})`).run(...ids);
  });
  audit(c.u.id, 'unit_del', { id: u.id, count: ids.length, moved_to: parent }, c.ip); send(c.res, 200, { ok: true });
});

// --- فهرست مجاز، کاربران، بارگذاری گروهی
R('GET', '/api/allow', (c) => {
  if (!isManagerRole(c.u.role)) return fail(c.res, 403, 'اجازه ندارید.');
  const ids = scopeOf(c.u); send(c.res, 200, db.prepare(`SELECT id,nid_last4,unit_id,role,note,used FROM allow WHERE unit_id IN (${inList(ids)}) ORDER BY id DESC`).all(...ids));
});
R('GET', '/api/imported-experts', (c) => {
  if (!isManagerRole(c.u.role)) return fail(c.res, 403, 'اجازه ندارید.');
  const ids = scopeOf(c.u), q = str(c.q.q, 60).replace(/[%_]/g, '');
  const where = `unit_id IN (${inList(ids)})` + (q ? ' AND (full_name LIKE ? OR phone LIKE ? OR username LIKE ? OR nid_last4 LIKE ?)' : '');
  const args = [...ids, ...(q ? Array(4).fill('%' + q + '%') : [])];
  const rows = db.prepare(`SELECT id,source_id,full_name,nid_last4,phone,username,role,unit_id FROM imported_experts WHERE ${where} ORDER BY full_name`).all(...args);
  send(c.res, 200, rows);
});
function importedExpertFields(b, fallback = {}) {
  const full_name = str(b.full_name, 100);
  if (!full_name) return null;
  const unit_id = +b.unit_id || +fallback.unit_id;
  if (!unit_id) return null;
  const role = ROLES.includes(b.role) ? b.role : (ROLES.includes(fallback.role) ? fallback.role : 'expert_ohs');
  const last4 = L.faDigits(String(b.nid_last4 ?? fallback.nid_last4 ?? '')).trim().slice(-4);
  return { full_name, unit_id, role, nid_last4: /^\d{1,4}$/.test(last4) ? last4.padStart(4, '0') : '', phone: str(b.phone, 20), username: str(b.username, 60), source_id: str(b.source_id, 80) || String(fallback.source_id || 'manual-' + now()) };
}
R('POST', '/api/imported-experts', (c) => {
  if (!isManagerRole(c.u.role)) return fail(c.res, 403, 'اجازه ندارید.');
  const f = importedExpertFields(c.b); if (!f) return fail(c.res, 400, 'نام و واحد الزامی است.');
  if (!canManage(c.u, f.unit_id, f.role)) return fail(c.res, 403, 'اجازه یا نقش نامعتبر است.');
  try {
    const r = db.prepare('INSERT INTO imported_experts(source_id,full_name,nid_last4,phone,username,role,unit_id,source,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(f.source_id, f.full_name, f.nid_last4, f.phone, f.username, f.role, f.unit_id, str(c.b.source, 40) || 'manual', now());
    audit(c.u.id, 'imported_expert_add', { id: +r.lastInsertRowid, unit: f.unit_id }, c.ip); send(c.res, 200, { id: +r.lastInsertRowid });
  } catch (e) { fail(c.res, 400, 'شناسه منبع تکراری است.'); }
});
R('PUT', '/api/imported-experts/:id', (c) => {
  const old = db.prepare('SELECT * FROM imported_experts WHERE id=?').get(+c.p.id);
  if (!old || !canManage(c.u, old.unit_id, old.role)) return fail(c.res, 403, 'اجازه ندارید.');
  const f = importedExpertFields(c.b, old); if (!f) return fail(c.res, 400, 'نام و واحد الزامی است.');
  if (!canManage(c.u, f.unit_id, f.role)) return fail(c.res, 403, 'اجازه یا نقش نامعتبر است.');
  try {
    db.prepare('UPDATE imported_experts SET source_id=?,full_name=?,nid_last4=?,phone=?,username=?,role=?,unit_id=? WHERE id=?')
      .run(f.source_id, f.full_name, f.nid_last4, f.phone, f.username, f.role, f.unit_id, old.id);
    audit(c.u.id, 'imported_expert_edit', { id: old.id, unit: f.unit_id }, c.ip); send(c.res, 200, { ok: true });
  } catch (e) { fail(c.res, 400, 'شناسه منبع تکراری است.'); }
});
R('DELETE', '/api/imported-experts/:id', (c) => {
  const x = db.prepare('SELECT * FROM imported_experts WHERE id=?').get(+c.p.id);
  if (!x || !canManage(c.u, x.unit_id, x.role)) return fail(c.res, 403, 'اجازه ندارید.');
  db.prepare('DELETE FROM imported_experts WHERE id=?').run(x.id);
  audit(c.u.id, 'imported_expert_del', { id: x.id }, c.ip); send(c.res, 200, { ok: true });
});
function addAllow(actor, nidRaw, unit, role, note) {
  const nid = L.validNid(nidRaw); if (!nid) return 'کد ملی معتبر نیست';
  if (!canManage(actor, unit, role)) return 'اجازه‌ی ثبت برای این واحد/نقش را ندارید';
  try { db.prepare('INSERT INTO allow(nid_hash,nid_enc,nid_last4,unit_id,role,note,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)').run(L.hmac(nid), L.enc(nid), nid.slice(-4), unit, role, str(note, 100), actor.id, now()); return null; }
  catch (e) { return 'این کد ملی قبلاً در فهرست مجاز ثبت شده است'; }
}
R('POST', '/api/allow', (c) => {
  const role = ROLES.includes(c.b.role) ? c.b.role : 'expert_ohs';
  const err = addAllow(c.u, c.b.nid, +c.b.unit_id, role, c.b.note);
  if (err) return fail(c.res, 400, err); audit(c.u.id, 'allow_add', { unit: +c.b.unit_id, role }, c.ip); send(c.res, 200, { ok: true });
});
R('PUT', '/api/allow/:id', (c) => {
  const a = db.prepare('SELECT * FROM allow WHERE id=?').get(+c.p.id);
  if (!a || !canManage(c.u, a.unit_id, a.role)) return fail(c.res, 403, 'اجازه ندارید.');
  const unit = +c.b.unit_id || a.unit_id, role = ROLES.includes(c.b.role) ? c.b.role : a.role;
  if (!canManage(c.u, unit, role)) return fail(c.res, 403, 'اجازه یا نقش نامعتبر است.');
  if (a.used && (unit !== a.unit_id || role !== a.role)) return fail(c.res, 400, 'کد ملی ثبت‌نام کرده است؛ واحد و نقش آن قابل تغییر نیست.');
  const note = str(c.b.note, 100);
  db.prepare('UPDATE allow SET unit_id=?,role=?,note=? WHERE id=?').run(unit, role, note, a.id);
  audit(c.u.id, 'allow_edit', { id: a.id, unit, role }, c.ip); send(c.res, 200, { ok: true });
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
  if (!isManagerRole(c.u.role)) return fail(c.res, 403, 'اجازه ندارید.');
  let rows; try { rows = parseTable(c.b); } catch (e) { return fail(c.res, 400, e.message || 'فایل قابل خواندن نیست.'); }
  if (rows.length && !L.validNid(rows[0][0]) && /کد|ملی|نام|واحد/.test(rows[0].join(' '))) rows.shift();       // سطر عنوان
  if (rows.length > 5000) return fail(c.res, 400, 'حداکثر ۵۰۰۰ ردیف در هر بار.');
  const ids = scopeOf(c.u), units = db.prepare(`SELECT id,name,type FROM units WHERE id IN (${inList(ids)})`).all(...ids);
  const byName = new Map(); for (const u of units) { const k = L.norm(u.name); byName.set(k, (byName.get(k) || []).concat(u)); }
  const ok = [], errors = [];
  rows.forEach((r, i) => {
    const [nid, name, unitName, roleTxt] = r, row = i + 1;
    if (!name || !String(name).trim()) return errors.push({ row, msg: 'نام و نام خانوادگی الزامی است' });
    const key = L.norm(unitName || '').replace(/^(شهرستان|مرکز بهداشت|مرکز|دانشگاه)\s+/, '');
    let cand = byName.get(L.norm(unitName || '')) || byName.get(key) || [];
    if (!cand.length) cand = [...byName].filter(([k]) => k.replace(/^(شهرستان|مرکز بهداشت|مرکز|دانشگاه)\s+/, '') === key).flatMap(([, v]) => v);
    if (cand.length !== 1) return errors.push({ row, msg: cand.length ? 'نام واحد مبهم است' : 'واحد پیدا نشد: ' + (unitName || '(خالی)') });
    let role = 'expert_ohs';
const t = (roleTxt || '').trim();
if (/مدیر\s*گروه/i.test(t)) role = 'manager_ohs';
else if (/کارشناس\s*مسئول/i.test(t) || /\u0645\u0633\u0626\u0648\u0644/i.test(t)) role = 'responsible_ohs';
else if (/بهورز/i.test(t)) role = 'behvarz';
else if (/محیط/i.test(t)) role = 'expert_ehs';
else if (/حرفه/i.test(t)) role = 'expert_ohs';
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
  if (!isManagerRole(c.u.role)) return fail(c.res, 403, 'اجازه ندارید.');
  const ids = scopeOf(c.u);
  const rows = db.prepare(`SELECT * FROM users WHERE unit_id IN (${inList(ids)}) ORDER BY status,id DESC`).all(...ids).filter(u => u.id !== c.u.id && canManage(c.u, u.unit_id, u.role));
  send(c.res, 200, rows.map(u => ({ ...publicUser(u), email: u.email, phone: u.phone, totp_ok: !!u.totp_ok, last_login: u.last_login, nid: u.status === 'pending' ? L.dec(u.nid_enc) : undefined, unit_name: unitOf(u.unit_id).name })));
});
const userEmailOk = (email) => { const dom = String(email || '').split('@')[1]; return !!dom && DOMAINS.some(d => dom === d || dom.endsWith('.' + d)); };
R('POST', '/api/users', (c) => {
  if (!isManagerRole(c.u.role)) return fail(c.res, 403, 'اجازه ندارید.');
  const nid = L.validNid(c.b.nid), name = str(c.b.full_name, 100), email = str(c.b.email, 120).toLowerCase(), phone = str(c.b.phone, 20), pw = String(c.b.password || '');
  const unit = +c.b.unit_id, role = ROLES.includes(c.b.role) ? c.b.role : 'expert_ohs', status = ['pending', 'active', 'rejected', 'suspended'].includes(c.b.status) ? c.b.status : 'pending';
  if (!nid || !name || !userEmailOk(email) || !strongPw(pw)) return fail(c.res, 400, 'کد ملی معتبر، نام، ایمیل سازمانی و رمز حداقل ۱۲ کاراکتر شامل حرف و عدد الزامی است.');
  if (!canManage(c.u, unit, role)) return fail(c.res, 403, 'اجازه یا نقش نامعتبر است.');
  if (db.prepare('SELECT 1 FROM users WHERE nid_hash=?').get(L.hmac(nid))) return fail(c.res, 400, 'کاربری با این کد ملی وجود دارد.');
  const secret = L.newTotpSecret(); let id;
  tx(() => {
    const r = db.prepare(`INSERT INTO users(nid_hash,nid_enc,nid_last4,full_name,phone,email,unit_id,role,pw_hash,totp_enc,totp_ok,status,approved_by,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(L.hmac(nid), L.enc(nid), nid.slice(-4), name, phone, email, unit, role, L.hashPw(pw), L.enc(secret), 1, status, status === 'active' ? c.u.id : null, now());
    id = +r.lastInsertRowid;
    db.prepare('UPDATE allow SET used=1 WHERE nid_hash=?').run(L.hmac(nid));
  });
  audit(c.u.id, 'user_add', { id, unit, role, status }, c.ip); send(c.res, 200, { id, totp_secret: secret, otpauth: `otpauth://totp/AmarSalamat:${nid.slice(-4)}?secret=${secret}&issuer=AmarSalamat` });
});
R('PUT', '/api/users/:id', (c) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(+c.p.id);
  if (!u || !canManage(c.u, u.unit_id, u.role)) return fail(c.res, 403, 'اجازه ندارید.');
  const self = u.id === c.u.id;
  const unit = +c.b.unit_id || u.unit_id, role = ROLES.includes(c.b.role) ? c.b.role : u.role;
  const name = str(c.b.full_name, 100) || u.full_name, email = str(c.b.email, 120).toLowerCase() || u.email, phone = str(c.b.phone, 20);
  if (!canManage(c.u, unit, role) || (self && (unit !== u.unit_id || role !== u.role))) return fail(c.res, 403, 'نقش یا واحد نامعتبر است.');
  if (!userEmailOk(email)) return fail(c.res, 400, 'ایمیل باید سازمانی (ac.ir / gov.ir) باشد.');
  const status = c.b.status === undefined ? u.status : c.b.status;
  if (!['pending', 'active', 'rejected', 'suspended'].includes(status)) return fail(c.res, 400, 'وضعیت نامعتبر.');
  if (self && status !== u.status) return fail(c.res, 403, 'وضعیت خودتان را تغییر ندهید.');
  const pw = String(c.b.password || ''); if (pw && !strongPw(pw)) return fail(c.res, 400, 'رمز حداقل ۱۲ کاراکتر و شامل حرف و عدد باشد.');
  const reset = !!c.b.reset_totp, secret = reset ? L.newTotpSecret() : null, totpOk = reset || !!u.totp_ok;
  if (status === 'active' && !totpOk) return fail(c.res, 400, 'کاربر هنوز برنامه‌ی احراز هویت را تأیید نکرده است.');
  tx(() => {
    db.prepare(`UPDATE users SET full_name=?,phone=?,email=?,unit_id=?,role=?,status=?,totp_enc=?,totp_ok=?,approved_by=?,pw_hash=? WHERE id=?`)
      .run(name, phone, email, unit, role, status, reset ? L.enc(secret) : u.totp_enc, totpOk ? 1 : 0, status === 'active' ? c.u.id : u.approved_by, pw ? L.hashPw(pw) : u.pw_hash, u.id);
    if (unit !== u.unit_id || role !== u.role) db.prepare('UPDATE allow SET unit_id=?,role=? WHERE nid_hash=?').run(unit, role, u.nid_hash);
    if (status !== 'active') db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
  });
  audit(c.u.id, 'user_edit', { id: u.id, unit, role, status, reset_totp: reset }, c.ip);
  send(c.res, 200, { ok: true, ...(secret ? { totp_secret: secret, otpauth: `otpauth://totp/AmarSalamat:${u.nid_last4}?secret=${secret}&issuer=AmarSalamat` } : {}) });
});
R('DELETE', '/api/users/:id', (c) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(+c.p.id);
  if (!u || u.id === c.u.id || !canManage(c.u, u.unit_id, u.role)) return fail(c.res, 403, 'اجازه ندارید.');
  tx(() => {
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
    db.prepare('UPDATE allow SET used=0 WHERE nid_hash=?').run(u.nid_hash);
    db.prepare('DELETE FROM users WHERE id=?').run(u.id);
  });
  audit(c.u.id, 'user_del', { id: u.id }, c.ip); send(c.res, 200, { ok: true });
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
  if (!inScope(c.u, unit) || (!isManagerRole(c.u.role) && unit !== c.u.unit_id)) return fail(c.res, 403, 'اجازه ندارید.');
  send(c.res, 200, { values: entriesOf(per, unit), submission: getSub(per, unit) });
});
R('PUT', '/api/entries', (c) => {
  const unit = +c.b.unit || c.u.unit_id; if (!inScope(c.u, unit) || (!isManagerRole(c.u.role) && unit !== c.u.unit_id)) return fail(c.res, 403, 'اجازه ندارید.');
  const e = applyEntry(c.u, c.b.period, String(c.b.ind || ''), c.b.value, unit); if (e) return fail(c.res, 400, e); send(c.res, 200, { ok: true });
});
R('DELETE', '/api/entries', (c) => {
  const unit = +c.b.unit || c.u.unit_id; if (!inScope(c.u, unit) || (!isManagerRole(c.u.role) && unit !== c.u.unit_id)) return fail(c.res, 403, 'اجازه ندارید.');
  const ind = String(c.b.ind || '');
  if (!IND[ind]) return fail(c.res, 400, 'شاخص نامعتبر.');
  const old = db.prepare('SELECT value FROM entries WHERE period_id=? AND unit_id=? AND ind_id=?').get(+c.b.period, unit, ind);
  if (!old) return send(c.res, 200, { ok: true, deleted: false });
  const e = applyEntry(c.u, c.b.period, ind, '', unit); if (e) return fail(c.res, 400, e);
  audit(c.u.id, 'entry_del', { period: +c.b.period, unit, ind }, c.ip); send(c.res, 200, { ok: true, deleted: true });
});
R('POST', '/api/entries/batch', (c) => {          // برای ارسال صف آفلاین
  const items = Array.isArray(c.b.items) ? c.b.items.slice(0, 500) : [], res = [];
  for (const it of items) { const unit = +it.unit || c.u.unit_id; if (!inScope(c.u, unit) || (!isManagerRole(c.u.role) && unit !== c.u.unit_id)) { res.push('اجازه ندارید.'); continue; } res.push(applyEntry(c.u, it.period, String(it.ind || ''), it.value, unit)); }
  send(c.res, 200, { results: res.map(e => e || null) });
});
R('GET', '/api/history', (c) => {
  const unit = +c.q.unit || c.u.unit_id; if (!inScope(c.u, unit) || (!isManagerRole(c.u.role) && unit !== c.u.unit_id)) return fail(c.res, 403, 'اجازه ندارید.');
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
function requiredBlocks(unit) {
  const hidden = new Set(db.prepare('SELECT sub_key FROM form_off WHERE unit_type=?').all(unit.type).map(r => r.sub_key));
  const blks = new Set();
  let curHidden = false;
  for (const it of CAT.layout) {
    if (it.t === 'sub') { curHidden = hidden.has(it.key); continue; }
    if (it.t === 'ind' && IND[it.id] && !curHidden) blks.add(IND[it.id].blk);
  }
  for (const t of TAB.tables) blks.add('TX-' + t.key);
  return [...blks];
}
R('POST', '/api/submit/confirmations', (c) => {
  const per = db.prepare('SELECT * FROM periods WHERE id=?').get(+c.b.period), unit = +c.b.unit || c.u.unit_id;
  if (!per || per.status !== 'open') return fail(c.res, 400, 'این دوره بسته است.');
  if (!inScope(c.u, unit) || (!isManagerRole(c.u.role) && unit !== c.u.unit_id)) return fail(c.res, 403, 'اجازه ندارید.');
  if (!editable(per.id, unit)) return fail(c.res, 400, 'بعد از ارسال قابل تغییر نیست.');
  const conf = (c.b.confirmations && typeof c.b.confirmations === 'object') ? c.b.confirmations : {};
  const clean = {};
  for (const k of requiredBlocks(unitOf(unit))) clean[k] = !!conf[k];
  db.prepare("INSERT INTO submissions(period_id,unit_id,status,confirmations) VALUES(?,?,'draft',?) ON CONFLICT(period_id,unit_id) DO UPDATE SET confirmations=excluded.confirmations")
    .run(per.id, unit, JSON.stringify(clean));
  send(c.res, 200, { ok: true, confirmations: clean });
});
R('POST', '/api/submit', (c) => {
  const per = db.prepare('SELECT * FROM periods WHERE id=?').get(+c.b.period), unit = +c.b.unit || c.u.unit_id;
  if (!per || per.status !== 'open') return fail(c.res, 400, 'این دوره بسته است.');
  if (!inScope(c.u, unit) || (!isManagerRole(c.u.role) && unit !== c.u.unit_id)) return fail(c.res, 403, 'اجازه ندارید.');
  if (!editable(per.id, unit)) return fail(c.res, 400, 'اطلاعات قبلاً ارسال شده است.');
  const vals = numVals(per.id, unit);
  if (!Object.values(vals).some(v => v > 0)) return fail(c.res, 400, 'هنوز هیچ آماری ثبت نشده است.');
  const req = requiredBlocks(unitOf(unit));
  const conf = parseConfirmations(getSub(per.id, unit));
  const missing = req.filter(k => !conf[k]);
  if (missing.length) return fail(c.res, 400, 'قبل از ارسال، همه بخش‌ها باید بررسی و تیک تأیید شوند.', { missing });
  const w = checkRules(vals);
  if (w.length) return fail(c.res, 409, 'خطاهای منطقی باید قبل از ارسال برطرف شوند.', { warnings: w });
  db.prepare("INSERT INTO submissions(period_id,unit_id,status,confirmations,submitted_by,submitted_at,note) VALUES(?,?,'submitted',?,?,?,NULL) ON CONFLICT(period_id,unit_id) DO UPDATE SET status='submitted',submitted_by=excluded.submitted_by,submitted_at=excluded.submitted_at,note=NULL")
    .run(per.id, unit, JSON.stringify(conf), c.u.id, now());
  audit(c.u.id, 'submit', { period: per.id, unit, warnings: w.length }, c.ip); send(c.res, 200, { ok: true });
});
R('POST', '/api/submit/withdraw', (c) => {
  const unit = +c.b.unit || c.u.unit_id; if (!inScope(c.u, unit) || (!isManagerRole(c.u.role) && unit !== c.u.unit_id)) return fail(c.res, 403, 'اجازه ندارید.');
  const s = getSub(+c.b.period, unit); if (s.status !== 'submitted') return fail(c.res, 400, 'فقط ارسال‌های منتظر تأیید اولیه قابل پس‌گرفتن هستند.');
  db.prepare("UPDATE submissions SET status='draft',note=NULL WHERE period_id=? AND unit_id=?").run(s.period_id, s.unit_id); audit(c.u.id, 'withdraw', { period: s.period_id, unit }, c.ip); send(c.res, 200, { ok: true });
});
R('GET', '/api/approvals', (c) => {
  if (!isManagerRole(c.u.role)) return fail(c.res, 403, 'اجازه ندارید.');
  const per = +c.q.period, ids = scopeOf(c.u).filter(i => canDecide(c.u, i));
  if (!ids.length) return send(c.res, 200, []);
  const out = db.prepare(`SELECT u.id unit_id,u.name,u.type,COALESCE(s.status,'draft') status,s.confirmations,s.submitted_at,s.decided_at,s.note,(SELECT COUNT(*) FROM entries e WHERE e.period_id=? AND e.unit_id=u.id) filled
    FROM units u LEFT JOIN submissions s ON s.unit_id=u.id AND s.period_id=? WHERE u.id IN (${inList(ids)}) ORDER BY u.id`).all(per, per, ...ids);
  for (const r of out) {
    r.canDecide = ['submitted', 'county_approved'].includes(r.status) && canDecideStage(c.u, r.unit_id, r.status);
    r.warnings = ['submitted', 'county_approved'].includes(r.status) ? checkRules(numVals(per, r.unit_id)).length : 0;
  }
  send(c.res, 200, out);
});
R('POST', '/api/approvals/decide', (c) => {
  const per = db.prepare('SELECT * FROM periods WHERE id=?').get(+c.b.period), unit = +c.b.unit, act = c.b.action, note = str(c.b.note, 300);
  if (!per || per.status !== 'open') return fail(c.res, 400, 'این دوره بسته است.');
  if (!canDecide(c.u, unit)) return fail(c.res, 403, 'اجازه ندارید.');
  const s = getSub(per.id, unit);
  if (act === 'approve') {
    if (!['submitted', 'county_approved'].includes(s.status)) return fail(c.res, 400, 'این واحد در انتظار تأیید نیست.');
    if (!canDecideStage(c.u, unit, s.status)) return fail(c.res, 403, 'تأیید این مرحله در سطح شما مجاز نیست.');
    const w = checkRules(numVals(per.id, unit));
    if (w.length) return fail(c.res, 409, 'قبل از تأیید، خطاهای منطقی باید برطرف شوند.', { warnings: w });
    const ns = nextApprovalStatus(unit, s.status);
    db.prepare('UPDATE submissions SET status=?,decided_by=?,decided_at=?,note=NULL WHERE period_id=? AND unit_id=?').run(ns, c.u.id, now(), per.id, unit);
    audit(c.u.id, 'decision_approve', { period: per.id, unit, from: s.status, to: ns }, c.ip); return send(c.res, 200, { ok: true, status: ns });
  }
  if (act === 'return') {
    if (!['submitted', 'county_approved', 'approved'].includes(s.status)) return fail(c.res, 400, 'قابل برگشت نیست.');
    if (!note) return fail(c.res, 400, 'علت برگشت را بنویسید.');
    db.prepare('UPDATE submissions SET status=?,decided_by=?,decided_at=?,note=? WHERE period_id=? AND unit_id=?').run('returned', c.u.id, now(), note, per.id, unit);
    audit(c.u.id, 'decision_return', { period: per.id, unit, from: s.status, note }, c.ip); return send(c.res, 200, { ok: true, status: 'returned' });
  }
  return fail(c.res, 400, 'عملیات نامعتبر.');
});
R('DELETE', '/api/submissions', (c) => {
  const per = db.prepare('SELECT * FROM periods WHERE id=?').get(+c.b.period), unit = +c.b.unit || c.u.unit_id;
  if (!per || per.status !== 'open') return fail(c.res, 400, 'این دوره بسته است.');
  if (!canDecide(c.u, unit)) return fail(c.res, 403, 'اجازه ندارید.');
  const s = getSub(per.id, unit); if (s.status === 'draft') return send(c.res, 200, { ok: true, deleted: false });
  db.prepare('DELETE FROM submissions WHERE period_id=? AND unit_id=?').run(per.id, unit);
  audit(c.u.id, 'submission_del', { period: per.id, unit, status: s.status }, c.ip); send(c.res, 200, { ok: true, deleted: true });
});
R('GET', '/api/inbox', (c) => {
  const o = { returned: 0, pendingApprovals: 0, pendingUsers: 0, note: null };
  const per = (db.prepare("SELECT id FROM periods WHERE status='open' ORDER BY id DESC LIMIT 1").get() || {}).id;
  if (per) { const s = getSub(per, c.u.unit_id); o.status = s.status; if (s.status === 'returned') { o.returned = 1; o.note = s.note; } o.period = per; }
  if (isManagerRole(c.u.role)) {
    if (per) {
      const ids = scopeOf(c.u).filter(i => canDecide(c.u, i));
      if (ids.length) {
        const rows = db.prepare(`SELECT unit_id,status FROM submissions WHERE period_id=? AND status IN ('submitted','county_approved') AND unit_id IN (${inList(ids)})`).all(per, ...ids);
        o.pendingApprovals = rows.filter(r => canDecideStage(c.u, r.unit_id, r.status)).length;
      }
    }
    const ids = scopeOf(c.u); o.pendingUsers = db.prepare(`SELECT COUNT(*) n FROM users WHERE status='pending' AND totp_ok=1 AND unit_id IN (${inList(ids)})`).get(...ids).n;
  }
  send(c.res, 200, o);
});
// --- گزارش، داشبورد و خروجی
function matrix(c) {
  const unit = +c.q.unit || c.u.unit_id, per = +c.q.period, only = c.q.approved === '1';
  if (!inScope(c.u, unit) || (!isManagerRole(c.u.role) && unit !== c.u.unit_id)) return null;
  const kids = db.prepare('SELECT id,name,type FROM units WHERE parent_id=? ORDER BY id').all(unit);
  const cols = [{ id: unit, name: unitOf(unit).name + ' (جمع)', total: true }, ...kids.map(k => ({ id: k.id, name: k.name, status: getSub(per, k.id).status }))];
  return { unit, per, cols, data: cols.map(col => { const s = sums(per, col.id, only); return { s, r: computeReport(s) }; }) };
}
R('GET', '/api/rollup', (c) => { const m = matrix(c); if (!m) return fail(c.res, 403, 'اجازه ندارید.'); send(c.res, 200, { cols: m.cols, sums: m.data.map(d => d.s), report: m.data.map(d => d.r) }); });
R('GET', '/api/progress', (c) => {
  if (!isManagerRole(c.u.role)) return fail(c.res, 403, 'اجازه ندارید.');
  const per = +c.q.period, ids = scopeOf(c.u);
  send(c.res, 200, db.prepare(`SELECT unit_id, COUNT(*) n, MAX(updated_at) last FROM entries WHERE period_id=? AND unit_id IN (${inList(ids)}) GROUP BY unit_id`).all(per, ...ids));
});
R('GET', '/api/inspector-stats', (c) => {
  if (!isManagerRole(c.u.role)) return fail(c.res, 403, 'اجازه ندارید.');
  const per = +c.q.period, ids = scopeOf(c.u);
  const rows = db.prepare(`SELECT e.updated_by uid, u.full_name name, u.role role, COUNT(*) n, MAX(e.updated_at) last FROM entries e JOIN users u ON u.id=e.updated_by WHERE e.period_id=? AND e.unit_id IN (${inList(ids)}) GROUP BY e.updated_by ORDER BY n DESC`).all(per, ...ids);
  send(c.res, 200, rows);
});
R('GET', '/api/dashboard', (c) => {
  if (!isManagerRole(c.u.role)) return fail(c.res, 403, 'اجازه ندارید.');
  const unit = +c.q.unit || c.u.unit_id, per = +c.q.period; if (!inScope(c.u, unit)) return fail(c.res, 403, 'اجازه ندارید.');
  const only = c.q.approved === '1', kids = db.prepare('SELECT id,name FROM units WHERE parent_id=? ORDER BY id').all(unit);
  const pick = (r) => Object.fromEntries(KPIS.map(k => [k, r[k]]));
  const total = pick(computeReport(sums(per, unit, only)));
  const prev = db.prepare('SELECT id,label FROM periods WHERE id<? ORDER BY id DESC LIMIT 1').get(per);
  const status = { draft: 0, submitted: 0, county_approved: 0, approved: 0, returned: 0 };
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
    if (!isManagerRole(c.u.role) && uid !== c.u.unit_id) { report.errors.push(`${u.name}: شما فقط برای واحد خودتان می‌توانید درون‌ریزی کنید`); continue; }
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
  const unit = +c.q.unit || c.u.unit_id; if (!inScope(c.u, unit) || (!isManagerRole(c.u.role) && unit !== c.u.unit_id)) return fail(c.res, 403, 'اجازه ندارید.');
  const ids = subtreeIds(unit), q = str(c.q.q, 60), off = Math.max(0, +c.q.offset || 0);
  const where = `table_key=? AND unit_id IN (${inList(ids)})` + (q ? ' AND data LIKE ?' : ''), args = [t.key, ...ids, ...(q ? ['%' + q.replace(/[%_]/g, '') + '%'] : [])];
  const total = db.prepare(`SELECT COUNT(*) n FROM records WHERE ${where}`).get(...args).n;
  const rows = db.prepare(`SELECT r.id,r.unit_id,r.data,r.updated_at,u.name unit_name FROM records r JOIN units u ON u.id=r.unit_id WHERE ${where.replace(/table_key/, 'r.table_key').replace(/unit_id IN/, 'r.unit_id IN')} ORDER BY r.id DESC LIMIT 100 OFFSET ${off}`).all(...args);
  send(c.res, 200, { total, rows: rows.map(r => ({ ...r, data: JSON.parse(r.data) })) });
});
const recUnit = (c, t) => { const u = +c.b.unit_id || c.u.unit_id; if (!inScope(c.u, u) || (!isManagerRole(c.u.role) && u !== c.u.unit_id)) return null; return u; };
R('POST', '/api/records', (c) => {
  const t = TABLES[c.b.table]; if (!t) return fail(c.res, 400, 'جدول نامعتبر.'); const unit = recUnit(c, t); if (!unit) return fail(c.res, 403, 'اجازه ندارید.');
  let d; try { d = cleanRec(t, c.b.data); } catch (e) { return fail(c.res, 400, e.message); }
  if (!Object.keys(d).length) return fail(c.res, 400, 'حداقل یک خانه را پر کنید.');
  const r = db.prepare('INSERT INTO records(table_key,unit_id,data,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(t.key, unit, JSON.stringify(d), c.u.id, c.u.id, now(), now());
  audit(c.u.id, 'record_add', { t: t.key, id: +r.lastInsertRowid }, c.ip); send(c.res, 200, { id: +r.lastInsertRowid });
});
const ownRec = (c) => { const r = db.prepare('SELECT * FROM records WHERE id=?').get(+c.p.id); if (!r || !inScope(c.u, r.unit_id) || (!isManagerRole(c.u.role) && r.unit_id !== c.u.unit_id)) return null; return r; };
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
  const unit = +c.q.unit || c.u.unit_id; if (!inScope(c.u, unit) || (!isManagerRole(c.u.role) && unit !== c.u.unit_id)) return fail(c.res, 403, 'اجازه ندارید.');
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
module.exports = server;
module.exports.server = server;

'use strict';
/* سامانه آمار بهداشت حرفه‌ای — رابط کاربری (بدون وابستگی خارجی، سازگار با CSP سخت‌گیرانه) */
const S = { cat: null, me: null, csrf: null, per: null, periods: [], tab: null, units: [], inbox: {}, online: navigator.onLine };
const isMgrRole = (r) => r === 'responsible_ohs' || r === 'manager_ohs';
const $app = document.getElementById('app');
const FA = '۰۱۲۳۴۵۶۷۸۹', fa = (n) => String(n ?? '').replace(/\d/g, d => FA[d]);
const en = (s) => String(s ?? '').replace(/[۰-۹]/g, d => FA.indexOf(d)).replace(/[٠-٩]/g, d => d.charCodeAt(0) - 1632);
const fmt = (n) => n === null || n === undefined || n === '' ? '' : fa(Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 }));
const when = (ts) => ts ? new Date(+ts).toLocaleString('fa-IR', { dateStyle: 'short', timeStyle: 'short' }) : '';

function h(tag, a, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(a || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v; else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k in el && k !== 'list' && k !== 'form') el[k] = v; else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat(9)) if (k !== null && k !== undefined && k !== false) el.append(k.nodeType ? k : document.createTextNode(String(k)));
  return el;
}
const svg = (tag, a, ...kids) => { const el = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(a || {})) el.setAttribute(k, v); for (const k of kids.flat()) if (k) el.append(k.nodeType ? k : document.createTextNode(k)); return el; };
const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
let toastT; function toast(m, duration = 3200) { const t = document.getElementById('toast'); t.textContent = m; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), duration); }

async function api(method, path, body) {
  let r;
  try { r = await fetch(path, { method, credentials: 'same-origin', headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(S.csrf ? { 'x-csrf': S.csrf } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined }); }
  catch (e) { return { s: 0, j: { error: 'اتصال به اینترنت برقرار نیست.' }, offline: true }; }
  let j = {}; try { j = await r.json(); } catch (e) { }
  if (r.status === 401 && S.me) { S.me = null; S.csrf = null; renderLogin('نشست شما پایان یافت؛ دوباره وارد شوید.'); }
  return { s: r.status, j };
}
async function download(path, fallback) {
  let r; try { r = await fetch(path, { credentials: 'same-origin' }); } catch (e) { return toast('اتصال برقرار نیست.'); }
  if (!r.ok) { let m = 'خطا در دریافت فایل'; try { m = (await r.json()).error || m; } catch (e) { } return toast(m); }
  const cd = r.headers.get('Content-Disposition') || '', m = cd.match(/filename\*=UTF-8''([^;]+)/), name = m ? decodeURIComponent(m[1]) : fallback;
  const url = URL.createObjectURL(await r.blob()); const a = h('a', { href: url, download: name }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
}
const b64 = (file) => new Promise((ok, no) => { const f = new FileReader(); f.onload = () => ok(f.result.split(',')[1]); f.onerror = no; f.readAsDataURL(file); });
const msg = (cls, t) => h('div', { class: 'msg ' + cls, role: cls === 'err' ? 'alert' : 'status' }, t);
const field = (label, input) => h('label', { class: 'f' }, h('span', {}, label), input);

// ---------- صف آفلاین (به شناسه‌ی کاربر وابسته است و پس از خروج پاک نمی‌شود)
const qKey = () => 'amar.q.' + (S.me ? S.me.id : 0);
const qGet = () => { try { return JSON.parse(localStorage.getItem(qKey()) || '[]'); } catch (e) { return []; } };
const qSet = (a) => { try { localStorage.setItem(qKey(), JSON.stringify(a)); } catch (e) { } };
function qAdd(it) { const a = qGet().filter(x => !(x.period === it.period && x.ind === it.ind)); a.push(it); qSet(a); updNet(); }
async function qFlush() {
  const a = qGet(); if (!a.length || !S.me) return;
  const r = await api('POST', '/api/entries/batch', { items: a.slice(0, 500) });
  if (r.s !== 200) return;
  const bad = a.slice(0, 500).map((x, i) => r.j.results[i] ? { x, e: r.j.results[i] } : null).filter(Boolean);
  qSet(a.slice(500)); updNet();
  toast(bad.length ? `${fa(bad.length)} مورد آفلاین ثبت نشد: ${bad[0].e}` : 'داده‌های ذخیره‌شده‌ی آفلاین ارسال شد ✓');
}
function updNet() { const e = document.getElementById('net'); if (!e) return; const n = qGet().length; e.className = 'net' + (S.online ? '' : ' off'); e.textContent = S.online ? (n ? `${fa(n)} در صف` : 'آنلاین') : `آفلاین${n ? ' — ' + fa(n) + ' در صف' : ''}`; }
window.addEventListener('online', () => { S.online = true; updNet(); qFlush(); });
window.addEventListener('offline', () => { S.online = false; updNet(); });

// ---------- کاتالوگ
let IND = {}, BLOCKS = [], SUBOF = {};
function prepCatalog() {
  IND = Object.fromEntries(S.cat.indicators.map(i => [i.id, i])); BLOCKS = []; SUBOF = {};
  let b = null, sub = null;
  for (const it of S.cat.layout) {
    if (it.t === 'sec') { b = { blk: it.blk, title: it.title, subs: [] }; BLOCKS.push(b); sub = null; }
    else if (it.t === 'sub') { sub = { key: it.key, title: it.title, inds: [] }; b.subs.push(sub); }
    else { if (!sub) { sub = { key: b.blk + '|', title: 'عمومی', inds: [] }; b.subs.push(sub); } sub.inds.push(it.id); SUBOF[it.id] = sub.key; }
  }
}
function warnings(V) {
  const v = (id) => Number(V[id]) || 0, out = [];
  for (const r of S.cat.rules) { const s = r.b.reduce((x, id) => x + v(id), 0); if (v(r.a) > s) out.push({ a: r.a, got: v(r.a), max: s, b: r.b }); }
  return out;
}
const warnText = (w) => `«${IND[w.a].title}» (${fmt(w.got)}) از جمع «${w.b.map(i => IND[i].title).join(' + ')}» (${fmt(w.max)}) بیشتر است.`;

// ---------- شروع
async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => { });
  const c = await api('GET', '/api/catalog'); if (c.s !== 200) { $app.textContent = 'خطا در بارگذاری. صفحه را تازه کنید.'; return; }
  S.cat = c.j; prepCatalog();
  const m = await api('GET', '/api/me');
  if (m.s === 200) { S.me = m.j.user; S.csrf = m.j.csrf; await enter(); } else renderLogin();
}
async function enter() {
  const [p, u] = await Promise.all([api('GET', '/api/periods'), api('GET', '/api/units')]);
  S.periods = p.j || []; S.units = u.j || []; if (!S.per || !S.periods.some(x => x.id === S.per)) { const o = S.periods.find(x => x.status === 'open') || S.periods[0]; S.per = o ? o.id : null; }
  await qFlush(); renderShell();
}

// ---------- ورود و ثبت‌نام
function renderLogin(note) {
  clear($app); let mode = 'login';
  const box = h('div', { class: 'card' }), wrap = h('div', { class: 'login' }, h('h1', {}, 'سامانه‌ی آمار بهداشت حرفه‌ای'), h('p', { class: 'mut' }, 'ویژه‌ی کارشناسان بهداشت حرفه‌ای دانشگاه‌های علوم پزشکی. ورود فقط با کد ملیِ ثبت‌شده در فهرست مجاز، رمز و کد برنامه‌ی احراز هویت.'), note ? msg('warn', note) : null, box);
  $app.append(wrap);
  const draw = () => {
    clear(box);
    box.append(h('div', { class: 'row' }, h('button', { class: 'b' + (mode === 'login' ? '' : ' sec'), on: { click: () => { mode = 'login'; draw(); } } }, 'ورود'), h('button', { class: 'b' + (mode === 'reg' ? '' : ' sec'), on: { click: () => { mode = 'reg'; draw(); } } }, 'ثبت‌نام (دعوت‌شده)')));
    if (mode === 'login') loginForm(box); else regForm(box);
  };
  draw();
}
/* ورود آزمایشی/موقت — کد ملی و رمز از پیش پر می‌شوند تا بعداً تغییر کنند */
const TEMP_NID = '1387140175', TEMP_PW = '3-hWVrMfb2rjQ3ama1';
function loginForm(box) {
  const nid = h('input', { class: 'ltr', inputMode: 'numeric', autocomplete: 'username', maxLength: 10, value: TEMP_NID }), code = h('input', { class: 'ltr', inputMode: 'numeric', autocomplete: 'one-time-code', maxLength: 6 }), out = h('div');
  const sendBtn = h('button', { class: 'b sec', type: 'button' }, 'ارسال کد یک‌بارمصرف');
  const loginBtn = h('button', { class: 'b', type: 'submit', disabled: true }, 'ورود');
  sendBtn.addEventListener('click', async () => { clear(out); sendBtn.disabled = true;
    const r = await api('POST', '/api/otp/send', { nid: en(nid.value) });
    sendBtn.disabled = false;
    if (r.s !== 200) { out.append(msg('err', r.j.error || 'خطا')); return; }
    out.append(msg('ok', r.j.message || 'کد ارسال شد.'));
    if (r.j.dev_code) out.append(msg('info', 'کد یک‌بارمصرف (حالت توسعه): ' + r.j.dev_code));
    loginBtn.disabled = false; code.focus();
  });
  const f = h('form', { on: { submit: async (e) => { e.preventDefault(); loginBtn.disabled = true; clear(out);
    const r = await api('POST', '/api/otp/verify', { nid: en(nid.value), code: en(code.value) });
    loginBtn.disabled = false; if (r.s !== 200) { out.append(msg('err', r.j.error || 'خطا')); return; }
    const m = await api('GET', '/api/me'); S.me = m.j.user; S.csrf = m.j.csrf; await enter(); } } },
    field('کد ملی', nid), field('کد ۶ رقمی یک‌بارمصرف', code), out,
    h('div', { class: 'row' }, sendBtn, loginBtn));
  box.append(f);
}
function regForm(box) {
  const nid = h('input', { class: 'ltr', inputMode: 'numeric', maxLength: 10 }), name = h('input', { autocomplete: 'name' }), mail = h('input', { class: 'ltr', type: 'email' }), tel = h('input', { class: 'ltr', inputMode: 'tel' }), pw = h('input', { type: 'password', class: 'ltr', autocomplete: 'new-password' }), out = h('div'), btn = h('button', { class: 'b', type: 'submit' }, 'ثبت‌نام');
  box.append(msg('info', 'ثبت‌نام فقط برای کسانی ممکن است که مسئول بالادستی، کد ملی‌شان را در فهرست مجاز ثبت کرده باشد. ایمیل باید سازمانی (ac.ir / gov.ir) باشد.'),
    h('form', { on: { submit: async (e) => { e.preventDefault(); btn.disabled = true; clear(out);
      const r = await api('POST', '/api/register', { nid: en(nid.value), full_name: name.value, email: mail.value, phone: en(tel.value), password: pw.value });
      btn.disabled = false; if (r.s !== 200) return out.append(msg('err', r.j.error || 'خطا'));
      clear(box); const code = h('input', { class: 'ltr', inputMode: 'numeric', maxLength: 6 }), o2 = h('div'), b2 = h('button', { class: 'b', type: 'submit' }, 'تأیید و ارسال برای تأیید مسئول');
      box.append(h('h2', {}, 'مرحله‌ی ۲: فعال‌سازی احراز هویت دومرحله‌ای'), h('p', {}, 'یک برنامه‌ی احراز هویت (Google Authenticator، Microsoft Authenticator، FreeOTP یا مشابه) را باز کنید و «افزودن حساب با کلید» را بزنید؛ کلید زیر را وارد کنید (نوع: زمان‌محور):'), h('div', { class: 'secret' }, r.j.totp_secret), h('p', {}, h('a', { href: r.j.otpauth }, 'باز کردن مستقیم در برنامه (موبایل)')), msg('warn', 'این کلید فقط همین یک بار نمایش داده می‌شود. آن را جای دیگری ننویسید.'),
        h('form', { on: { submit: async (e2) => { e2.preventDefault(); b2.disabled = true; clear(o2); const v = await api('POST', '/api/register/verify', { nid: en(nid.value), password: pw.value, code: en(code.value) }); b2.disabled = false;
          if (v.s !== 200) return o2.append(msg('err', v.j.error || 'خطا')); clear(box); box.append(msg('ok', 'ثبت‌نام کامل شد. پس از تأیید مسئول بالادستی می‌توانید وارد شوید.')); } } }, field('کد ۶ رقمی نمایش‌داده‌شده در برنامه', code), o2, b2)); } } },
      field('کد ملی', nid), field('نام و نام خانوادگی', name), field('ایمیل سازمانی', mail), field('تلفن همراه', tel), field('رمز عبور (حداقل ۱۲ کاراکتر، حرف و عدد)', pw), out, btn));
}

// ---------- قالب اصلی
const TABS = () => {
  const mgr = isMgrRole(S.me.role), root = mgr && !S.me.unit.parent_id;
  return [['entry', 'ورود آمار', true], ['records', 'جدول‌ها و فهرست‌ها', true], ['dash', 'داشبورد', mgr], ['report', 'گزارش و جمع', mgr], ['analytics', 'تحلیل و شاخص‌ها', mgr], ['appr', 'تأیید ارسال‌ها', mgr, S.inbox.pendingApprovals], ['users', 'کاربران و دسترسی', mgr, S.inbox.pendingUsers], ['admin', 'مدیریت ستاد', root]].filter(t => t[2]);
};
const TAB_ICONS = { entry: '✎', records: '☰', dash: '📊', report: '📈', analytics: '📉', appr: '✓', users: '👥', admin: '⚙' };
let $view;
async function renderShell() {
  const ib = await api('GET', '/api/inbox'); S.inbox = ib.j || {};
  clear($app); const tabs = TABS(); if (!S.tab || !tabs.some(t => t[0] === S.tab)) S.tab = tabs[0][0];
  const nav = h('nav', { class: 'tabs', 'aria-label': 'منوی اصلی' }, tabs.map(t => h('button', { class: S.tab === t[0] ? 'on' : '', 'data-icon': TAB_ICONS[t[0]] || '•', 'aria-current': S.tab === t[0] ? 'page' : null, on: { click: () => { S.tab = t[0]; renderShell(); } } }, h('span', { class: 'lbl' }, t[1]), t[3] ? h('span', { class: 'badge' }, fa(t[3])) : null)));
  const initials = (S.me.full_name || ' ').trim().split(/\s+/).slice(0, 2).map(x => x[0]).join('‌');
  $view = h('main');
  $app.append(h('header', { class: 'top' },
    h('div', { class: 'brand' }, h('span', {}, 'آمار بهداشت حرفه‌ای'), h('span', { class: 'sep' }, '·'), h('span', { class: 'unit' }, S.me.unit.name)),
    h('span', { id: 'net', class: 'net' }),
    h('div', { class: 'actions' },
      h('button', { class: 'who', 'aria-label': 'حساب من', title: 'حساب من', on: { click: accountDlg } }, h('span', { class: 'avatar' }, initials), h('span', { class: 'nm' }, S.me.full_name), h('span', { class: 'rl' }, isMgrRole(S.me.role) ? 'مسئول' : 'کارشناس')),
      h('button', { class: 'out', 'aria-label': 'خروج', title: 'خروج از حساب', on: { click: logout } }, 'خروج'))),
    nav, $view);
  updNet(); ({ entry: viewEntry, records: viewRecords, dash: viewDash, report: viewReport, analytics: viewAnalytics, appr: viewAppr, users: viewUsers, admin: viewAdmin })[S.tab]();
}
async function logout() { await api('POST', '/api/logout', {}); S.me = null; S.csrf = null; renderLogin(); }
function modal(title, body, wide) {
  const m = h('div', { class: 'modal', on: { click: (e) => { if (e.target === m) m.remove(); } } }, h('div', { class: 'card', role: 'dialog', 'aria-label': title }, h('div', { class: 'row sp' }, h('h2', {}, title), h('button', { class: 'b sec sm', on: { click: () => m.remove() } }, 'بستن')), body));
  document.body.append(m); return m;
}
function accountDlg() {
  const o = h('input', { type: 'password', class: 'ltr', autocomplete: 'current-password' }), n = h('input', { type: 'password', class: 'ltr', autocomplete: 'new-password' }), out = h('div');
  const m = modal('حساب من', h('div', {}, h('p', {}, S.me.full_name, ' — کد ملی: ••••••', S.me.nid_last4, h('br'), S.me.unit.name),
    h('form', { on: { submit: async (e) => { e.preventDefault(); clear(out); const r = await api('POST', '/api/password', { old_password: o.value, new_password: n.value }); out.append(r.s === 200 ? msg('ok', 'رمز تغییر کرد.') : msg('err', r.j.error)); } } }, field('رمز فعلی', o), field('رمز جدید (حداقل ۱۲ کاراکتر، حرف و عدد)', n), out, h('button', { class: 'b' }, 'تغییر رمز'))));
}
const periodSel = (onch) => { const s = h('select', { on: { change: () => { S.per = +s.value; onch(); } } }, S.periods.map(p => h('option', { value: p.id, selected: p.id === S.per }, p.label + (p.status === 'closed' ? ' (بسته)' : '')))); return s; };
const unitSel = (cur, onch, filter) => { const s = h('select', { on: { change: () => onch(+s.value) } }, S.units.filter(filter || (() => true)).map(u => h('option', { value: u.id, selected: u.id === cur }, '— '.repeat(depth(u)) + u.name))); return s; };
function depth0(id) { let d = 0, x = S.units.find(y => y.id === id); while (x && x.parent_id && S.units.some(y => y.id === x.parent_id)) { x = S.units.find(y => y.id === x.parent_id); d++; } return d; }
const depth = (u) => depth0(u.id);

// ================= ورود آمار =================
async function viewEntry() {
  const st = { unit: S.me.unit_id, blk: sessionStorageGet('blk') || BLOCKS[0].blk, V: {}, sub: {}, hidden: new Set(), warnEl: null };
  const loadUnit = async (u) => { st.unit = u; const [en_, pf] = await Promise.all([api('GET', `/api/entries?period=${S.per}&unit=${u}`), api('GET', '/api/profile')]); if (en_.s !== 200) { $view.append(msg('err', en_.j.error || 'خطا')); return false; } st.V = en_.j.values; st.sub = en_.j.submission; st.hidden = new Set(pf.j.hidden || []); return true; };
  if (!(await loadUnit(st.unit))) return;
  const per = S.periods.find(p => p.id === S.per) || { status: 'closed', label: '' };
  const locked = per.status !== 'open' || ['submitted', 'approved'].includes(st.sub.status);
  // اعمال صف آفلاین روی نمایش
  for (const q of qGet()) if (q.period === S.per && (q.unit || S.me.unit_id) === st.unit) st.V[q.ind] = q.value;
  const head = h('div'), pills = h('div', { class: 'pills' }), body = h('div'), warn = h('div', { class: 'warnbox' });
  $view.append(head, pills, body, warn);
  const visibleInds = (b) => b.subs.filter(s => !st.hidden.has(s.key)).flatMap(s => s.inds).filter(i => IND[i].kind === 'num');
  const prog = (b) => { const l = visibleInds(b); return l.length ? Math.round(100 * l.filter(i => st.V[i] !== undefined && st.V[i] !== '').length / l.length) : 0; };
  const drawHead = () => {
    clear(head); const s = st.sub.status || 'draft';
    head.append(h('div', { class: 'card' }, h('div', { class: 'row sp' }, h('div', {}, h('h1', {}, 'ورود آمار — ', (S.units.find(u=>u.id===st.unit)||{}).name || S.me.unit.name), h('div', {}, 'وضعیت: ', h('span', { class: 'st ' + s }, S.cat.statusFa[s]))), h('div', { class: 'row' }, isMgrRole(S.me.role) ? unitSel(st.unit, (v) => { loadUnit(v).then(() => { drawHead(); drawPills(); drawBody(); drawWarn(); }); }) : null, h('span', {}, 'دوره: '), periodSel(() => renderShell()))),
      s === 'returned' && st.sub.note ? msg('warn', 'برگشت از مسئول: ' + st.sub.note) : null,
      s === 'approved' ? msg('ok', 'آمار این دوره تأیید و قفل شده است. برای اصلاح، مسئول بالادستی باید آن را برگشت دهد.') : null,
      s === 'submitted' ? h('div', {}, msg('info', 'آمار ارسال شد و منتظر تأیید است؛ ویرایش قفل است.'), h('button', { class: 'b sec sm', on: { click: async () => { const r = await api('POST', '/api/submit/withdraw', { period: S.per, unit: st.unit }); if (r.s === 200) renderShell(); else toast(r.j.error); } } }, 'پس‌گرفتن ارسال برای اصلاح')) : null,
      per.status !== 'open' ? (S.periods.length
        ? msg('warn', (per.label ? `دوره‌ی «${per.label}» بسته است.` : 'این دوره بسته است.') + (isMgrRole(S.me.role) ? ' برای ورود آمار، از بخش «مدیریت ستاد» آن را باز کنید.' : ' برای ورود آمار باید دوره باز شود.'))
        : msg('warn', 'هنوز هیچ دوره‌ی آماری تعریف نشده است؛ به همین دلیل ورود آمار غیرفعال است.' + (isMgrRole(S.me.role) ? ' از بخش «مدیریت ستاد» یک دوره بسازید.' : ''))) : null,
      h('div', { class: 'row' }, h('button', { class: 'b sec sm', on: { click: () => download(`/api/export.xlsx?period=${S.per}&unit=${st.unit}`, 'آمار.xlsx') } }, 'خروجی اکسل'), locked ? null : h('button', { class: 'b sec sm', on: { click: () => importDlg(st.unit) } }, 'درون‌ریزی از اکسل'),
        locked ? null : h('button', { class: 'b', on: { click: submitDlg } }, 'ارسال برای تأیید'))));
  };
  const drawPills = () => { clear(pills); for (const b of BLOCKS) { const p = prog(b); if (!visibleInds(b).length && b.subs.every(s => st.hidden.has(s.key))) continue; pills.append(h('button', { class: 'pill' + (b.blk === st.blk ? ' on' : ''), on: { click: () => { st.blk = b.blk; sessionStorageSet('blk', b.blk); drawPills(); drawBody(); } } }, b.title.replace(/^بخش\s*\S+\s*—\s*/, ''), h('span', { class: 'pr' }, fa(p) + '٪ تکمیل'))); } };
  const rowEls = {};
  const drawBody = () => {
    clear(body); const b = BLOCKS.find(x => x.blk === st.blk); body.append(h('h2', {}, b.title));
    let first = true;
    for (const sub of b.subs) {
      if (st.hidden.has(sub.key)) continue;
      const nums = sub.inds.filter(i => IND[i].kind === 'num'), done = nums.filter(i => st.V[i] !== undefined && st.V[i] !== '').length;
      const d = h('details', { class: 'sub', open: first || b.subs.length <= 3 || done > 0 }, h('summary', {}, h('span', {}, sub.title), h('small', {}, `${fa(done)} از ${fa(nums.length)}`)));
      // ردیف‌ها فقط هنگام باز شدن ساخته می‌شوند (سرعت روی موبایل)
      let built = false; const build = () => { if (built) return; built = true; for (const id of sub.inds) d.append(indRow(id)); };
      d.addEventListener('toggle', () => { if (d.open) build(); }); if (d.open) build();
      body.append(d); first = false;
    }
  };
  function indRow(id) {
    const I = IND[id], isNum = I.kind === 'num', v = st.V[id] ?? '';
    const inp = h('input', { value: v, inputMode: isNum ? 'decimal' : 'text', class: isNum ? '' : 'txt', disabled: locked, title: locked ? 'غیرفعال: دوره بسته است یا آمار ارسال/تأیید شده است.' : 'برای ذخیره، بیرون کلیک کنید یا Enter را بزنید', 'aria-label': I.title, enterKeyHint: 'next', autocomplete: 'off' });
    const row = h('div', { class: 'ind', id: 'r-' + id }, h('div', { class: 't' }, I.title, h('small', {}, id)), inp, locked ? null : null, h('button', { class: 'h', title: 'تاریخچه', 'aria-label': 'تاریخچه', on: { click: () => histDlg(id) } }, '⟲'));
    rowEls[id] = row;
    inp.addEventListener('input', () => { st.V[id] = isNum ? en(inp.value) : inp.value; inp.classList.remove('sv'); inp.classList.toggle('bad', isNum && inp.value !== '' && !/^\d{1,12}([.٫]\d{1,4})?$/.test(en(inp.value))); drawWarn(); });
    inp.addEventListener('change', async () => {
      const val = isNum ? en(inp.value).replace('٫', '.') : inp.value.trim(); if (isNum) inp.value = fa(val);
      if (inp.classList.contains('bad')) return;
      const r = await api('PUT', '/api/entries', { period: S.per, unit: st.unit, ind: id, value: val });
      if (r.offline) { qAdd({ period: S.per, unit: st.unit, ind: id, value: val }); inp.classList.add('sv'); return; }
      if (r.s !== 200) { inp.classList.add('bad'); toast(r.j.error || 'ذخیره نشد'); return; }
      inp.classList.add('sv'); drawPills();
      const sm = row.closest('details.sub'); if (sm) { const sub = BLOCKS.flatMap(x => x.subs).find(x => x.key === SUBOF[id]); if (sub) { const nums = sub.inds.filter(i => IND[i].kind === 'num'); sm.querySelector('small').textContent = `${fa(nums.filter(i => st.V[i] !== undefined && st.V[i] !== '').length)} از ${fa(nums.length)}`; } }
    });
    if (isNum) inp.value = v === '' ? '' : fa(v);
    return row;
  }
  function drawWarn() {
    const w = warnings(Object.fromEntries(Object.entries(st.V).map(([k, v]) => [k, Number(en(v)) || 0])));
    for (const el of document.querySelectorAll('.ind.w')) el.classList.remove('w');
    clear(warn); if (!w.length) return;
    for (const x of w) for (const id of [x.a]) if (rowEls[id]) rowEls[id].classList.add('w');
    warn.append(h('div', { class: 'msg warn' }, h('b', {}, `${fa(w.length)} هشدار منطقی: `), 'مقدارها را دوباره بررسی کنید (مانع ذخیره نیست). ', h('details', {}, h('summary', {}, 'نمایش'), h('ul', {}, w.map(x => h('li', {}, h('a', { href: '#', on: { click: (e) => { e.preventDefault(); const b = BLOCKS.find(bb => bb.subs.some(s => s.inds.includes(x.a))); if (b && b.blk !== st.blk) { st.blk = b.blk; drawPills(); drawBody(); } const el = document.getElementById('r-' + x.a); if (el) { const dt = el.closest('details'); if (dt) dt.open = true; el.scrollIntoView({ block: 'center' }); } } } }, warnText(x)))))))); }
  async function histDlg(id) {
    const r = await api('GET', `/api/history?period=${S.per}&ind=${encodeURIComponent(id)}&unit=${st.unit}`);
    modal('تاریخچه‌ی تغییرات', h('div', {}, h('p', { class: 'mut' }, IND[id].title), r.j.length ? h('table', { class: 'tbl' }, h('tr', {}, h('th', {}, 'زمان'), h('th', {}, 'کاربر'), h('th', {}, 'قبلی'), h('th', {}, 'جدید')), r.j.map(x => h('tr', {}, h('td', {}, when(x.ts)), h('td', {}, x.full_name), h('td', {}, fa(x.old ?? '—')), h('td', {}, fa(x.new || '(پاک شد)'))))) : 'تغییری ثبت نشده.'));
  }
  async function submitDlg() {
    await qFlush();
    const r = await api('POST', '/api/submit', { period: S.per, unit: st.unit });
    if (r.s === 200) { toast('ارسال شد ✓'); return renderShell(); }
    if (r.s === 409) {
      const ck = h('input', { type: 'checkbox' }), go = h('button', { class: 'b', disabled: true, on: { click: async () => { const r2 = await api('POST', '/api/submit', { period: S.per, unit: st.unit, ack: true }); if (r2.s === 200) { m.remove(); toast('ارسال شد ✓'); renderShell(); } else toast(r2.j.error); } } }, 'ارسال با وجود هشدارها');
      ck.addEventListener('change', () => { go.disabled = !ck.checked; });
      const m = modal('هشدارهای منطقی', h('div', {}, msg('warn', 'پیش از ارسال، این موارد را بررسی کنید. اگر مقدارها درست است (مثلاً به‌دلیل شرایط خاص)، با تیک زیر ارسال کنید.'), h('ul', {}, warnings(Object.fromEntries(Object.entries(st.V).map(([k, v]) => [k, Number(en(v)) || 0]))).map(w => h('li', {}, warnText(w)))), h('label', { class: 'chk' }, ck, 'مقدارها را بررسی کرده‌ام و صحیح است'), go));
    } else toast(r.j.error || 'ارسال نشد');
  }
  drawHead(); drawPills(); drawBody(); drawWarn();
}
function sessionStorageGet(k) { try { return sessionStorage.getItem('amar.' + k); } catch (e) { return null; } }
function sessionStorageSet(k, v) { try { sessionStorage.setItem('amar.' + k, v); } catch (e) { } }

// ---------- درون‌ریزی از اکسل (پیش‌نمایش ← اعمال)
function importDlg(unitId) {
  const f = h('input', { type: 'file', accept: '.xlsx' }), out = h('div'), apply = h('button', { class: 'b', disabled: true }, 'اعمال'); let data = null;
  const m = modal('درون‌ریزی آمار از اکسل', h('div', {}, h('p', { class: 'mut' }, 'از «خروجی اکسل» همین سامانه استفاده کنید: عددها را در ستون واحد خودتان پر کنید و بارگذاری کنید. ابتدا پیش‌نمایش نشان داده می‌شود و تا تأیید شما چیزی ذخیره نمی‌شود.'), field('فایل اکسل (xlsx)', f), out, apply));
  f.addEventListener('change', async () => { clear(out); apply.disabled = true; if (!f.files[0]) return; data = await b64(f.files[0]); const r = await api('POST', '/api/import/entries', { period: S.per, data, dry: true });
    if (r.s !== 200) return out.append(msg('err', r.j.error)); const n = Object.values(r.j.units).reduce((a, b) => a + b, 0);
    out.append(msg(n ? 'info' : 'warn', `${fa(n)} مقدار برای ${fa(Object.keys(r.j.units).length)} واحد آماده‌ی ثبت است.`), ...r.j.errors.map(e => msg('warn', e))); apply.disabled = !n; });
  apply.addEventListener('click', async () => { apply.disabled = true; const r = await api('POST', '/api/import/entries', { period: S.per, data }); if (r.s !== 200) return out.append(msg('err', r.j.error)); m.remove(); toast(`${fa(r.j.applied)} مقدار ثبت شد`); renderShell(); });
}

// ================= جدول‌ها و فهرست‌ها (فایل ۲) =================
async function viewRecords() {
  const st = { t: sessionStorageGet('tab') || S.cat.tables[0].key, unit: S.me.unit_id, q: '', off: 0 };
  const mgr = isMgrRole(S.me.role), ctl = h('div', { class: 'card' }), list = h('div', { class: 'card' });
  $view.append(ctl, list);
  const T = () => S.cat.tables.find(x => x.key === st.t);
  const draw = () => {
    clear(ctl);
    const ts = h('select', { on: { change: () => { st.t = ts.value; st.off = 0; sessionStorageSet('tab', st.t); draw(); load(); } } }, S.cat.tables.map(t => h('option', { value: t.key, selected: t.key === st.t }, t.title)));
    const q = h('input', { placeholder: 'جست‌وجو در ردیف‌ها…', value: st.q, on: { change: () => { st.q = q.value; st.off = 0; load(); } } });
    ctl.append(h('h1', {}, 'جدول‌ها و فهرست‌ها'), h('div', { class: 'grid2' }, field('جدول', ts), mgr ? field('واحد (شامل زیرمجموعه)', unitSel(st.unit, (v) => { st.unit = v; st.off = 0; load(); })) : null, field('جست‌وجو', q)),
      h('div', { class: 'row' }, h('button', { class: 'b', on: { click: () => recDlg(null) } }, '＋ ردیف جدید'), h('button', { class: 'b sec', on: { click: () => download(`/api/records.xlsx?table=${st.t}&unit=${st.unit}`, 'جدول.xlsx') } }, 'خروجی اکسل')));
  };
  async function load() {
    const r = await api('GET', `/api/records?table=${st.t}&unit=${st.unit}&q=${encodeURIComponent(st.q)}&offset=${st.off}`); clear(list);
    if (r.s !== 200) return list.append(msg('err', r.j.error));
    const t = T(), cols = t.cols.slice(0, 6);
    list.append(h('div', { class: 'mut' }, `${fa(r.j.total)} ردیف`),
      h('div', { class: 'scroll' }, h('table', { class: 'tbl' }, h('tr', {}, h('th', {}, 'واحد'), cols.map(c => h('th', {}, c.label)), h('th', {}, '')), r.j.rows.map(x => h('tr', {}, h('td', {}, x.unit_name), cols.map(c => h('td', {}, show(c, x.data[c.k]))), h('td', {}, h('button', { class: 'b sm sec', on: { click: () => recDlg(x) } }, 'ویرایش')))))),
      h('div', { class: 'row' }, st.off > 0 ? h('button', { class: 'b sec sm', on: { click: () => { st.off = Math.max(0, st.off - 100); load(); } } }, 'قبلی') : null, st.off + 100 < r.j.total ? h('button', { class: 'b sec sm', on: { click: () => { st.off += 100; load(); } } }, 'بعدی') : null));
  }
  const show = (c, v) => v === undefined ? '' : c.type === 'list' ? ((c.options.find(o => o[0] === v) || [])[1] ?? v) : c.type === 'mark' ? '✓' : c.type === 'num' ? fmt(v) : v;
  function recDlg(rec) {
    const t = T(), inputs = {}, out = h('div'), groups = [...new Set(t.cols.map(c => c.group))];
    const unitPick = !rec && mgr ? unitSel(st.unit, () => { }) : null;
    const form = h('form');
    for (const g of groups) {
      const cs = t.cols.filter(c => c.group === g);
      const grid = h('div', { class: 'grid2' });
      for (const c of cs) {
        const v = rec ? rec.data[c.k] : undefined; let el;
        if (c.type === 'list') el = h('select', {}, h('option', { value: '' }, '—'), c.options.map(o => h('option', { value: o[0], selected: v === o[0] }, o[1])));
        else if (c.type === 'mark') { el = h('input', { type: 'checkbox', checked: v === '*' }); inputs[c.k] = el; grid.append(h('label', { class: 'chk' }, el, c.label)); continue; }
        else el = h('input', { value: v ?? '', inputMode: c.type === 'num' ? 'decimal' : 'text' });
        inputs[c.k] = el; grid.append(field(c.label, el));
      }
      form.append(g ? h('details', { class: 'sub', open: groups.length <= 3 || (rec ? cs.some(c => rec.data[c.k]) : groups.indexOf(g) < 2) }, h('summary', {}, g), h('div', { class: 'ind' }, grid)) : grid);
    }
    const body = () => { const d = {}; for (const c of t.cols) { const e = inputs[c.k]; const v = c.type === 'mark' ? (e.checked ? '*' : '') : en(e.value).trim(); if (v !== '') d[c.k] = v; } return d; };
    const save = h('button', { class: 'b', type: 'submit' }, 'ذخیره');
    form.append(out, h('div', { class: 'row' }, save, rec ? h('button', { class: 'b red', type: 'button', on: { click: async () => { if (!confirm('این ردیف حذف شود؟ (در گزارش حسابرسی ثبت می‌شود)')) return; const r = await api('DELETE', '/api/records/' + rec.id); if (r.s === 200) { m.remove(); load(); } else toast(r.j.error); } } }, 'حذف') : null));
    form.addEventListener('submit', async (e) => { e.preventDefault(); clear(out); save.disabled = true; const d = body();
      const r = rec ? await api('PUT', '/api/records/' + rec.id, { data: d }) : await api('POST', '/api/records', { table: t.key, unit_id: unitPick ? +unitPick.value : st.unit, data: d });
      save.disabled = false; if (r.s !== 200) return out.append(msg('err', r.j.error)); m.remove(); toast('ذخیره شد ✓'); load(); });
    const m = modal(t.title + (rec ? ' — ویرایش' : ' — ردیف جدید'), h('div', {}, unitPick ? field('واحد', unitPick) : null, form), true);
  }
  draw(); load();
}

// ================= داشبورد =================
async function viewDash() {
  const st = { unit: S.me.unit_id, kpi: S.cat.kpis[0], only: false }, box = h('div');
  $view.append(box);
  async function load() {
    const r = await api('GET', `/api/dashboard?period=${S.per}&unit=${st.unit}${st.only ? '&approved=1' : ''}`); clear(box);
    if (r.s !== 200) return box.append(msg('err', r.j.error));
    const d = r.j, kt = Object.fromEntries(d.kpis.map(k => [k.code, k.title])), ST = S.cat.statusFa;
    const back = d.unit.parent_id && S.units.some(u => u.id === d.unit.parent_id) ? h('button', { class: 'b sec sm', on: { click: () => { st.unit = d.unit.parent_id; load(); } } }, '↑ بالاتر') : null;
    box.append(h('div', { class: 'card' }, h('div', { class: 'row sp' }, h('h1', {}, 'داشبورد — ', d.unit.name), h('div', { class: 'row' }, back, periodSel(() => renderShell()))),
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: st.only, on: { change: (e) => { st.only = e.target.checked; load(); } } }), 'فقط واحدهای تأییدشده محاسبه شود'),
      h('div', { class: 'row' }, ['approved', 'submitted', 'returned', 'draft'].map(k => h('span', { class: 'st ' + k }, `${ST[k].split('—')[0]}: ${fa(d.status[k])}`)))));
    const kp = h('div', { class: 'kpis' }, d.kpis.map(k => { const v = d.total[k.code], pv = d.prev ? d.prev.kpi[k.code] : null, df = (pv !== null && v !== null && pv !== undefined) ? v - pv : null;
      return h('div', { class: 'kpi' + (k.code === st.kpi ? ' on' : ''), tabindex: 0, role: 'button', on: { click: () => { st.kpi = k.code; load(); } } }, h('b', {}, v === null || v === undefined ? '—' : fa(v) + '٪'), h('span', {}, k.title), df !== null ? h('i', { class: df >= 0 ? 'up' : 'dn' }, (df >= 0 ? '▲ ' : '▼ ') + fa(Math.abs(Math.round(df * 100) / 100)) + ' نسبت به ' + d.prev.label) : null); }));
    box.append(h('div', { class: 'card' }, kp));
    const rows = d.rows.map(x => ({ ...x, v: x.kpi[st.kpi] })).sort((a, b) => (b.v ?? -1) - (a.v ?? -1));
    const W = 420, BH = 26, H = rows.length * BH + 10, svgEl = svg('svg', { class: 'bars', direction: 'ltr', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': kt[st.kpi] });
    const mx = Math.max(100, ...rows.map(r => r.v || 0));
    rows.forEach((r, i) => { const y = 5 + i * BH, w = r.v ? (r.v / mx) * 220 : 0, col = r.status === 'approved' ? '#0f8a79' : r.status === 'submitted' ? '#3b82f6' : '#9ca3af';
      svgEl.append(svg('text', { x: W - 4, y: y + 17, 'text-anchor': 'end', 'font-size': 12, fill: '#17302c' }, r.name), svg('rect', { x: W - 100 - w, y: y + 3, width: Math.max(w, 1), height: 18, rx: 3, fill: col }), svg('text', { x: W - 104 - w, y: y + 17, 'text-anchor': 'end', 'font-size': 12, fill: '#5d7570' }, r.v === null || r.v === undefined ? '—' : fa(r.v) + '٪')); });
    box.append(h('div', { class: 'card' }, h('h2', {}, kt[st.kpi]), h('p', { class: 'mut' }, 'رنگ: سبز = تأییدشده، آبی = منتظر تأیید، خاکستری = پیش‌نویس/برگشتی'), svgEl,
      h('div', { class: 'scroll' }, h('table', { class: 'tbl' }, h('tr', {}, h('th', {}, 'واحد'), h('th', {}, 'وضعیت'), h('th', {}, 'شاخص‌های پرشده'), d.kpis.map(k => h('th', {}, k.title))),
        d.rows.map(x => h('tr', {}, h('td', { class: 'l' }, S.units.some(u => u.parent_id === x.id) ? h('a', { href: '#', on: { click: (e) => { e.preventDefault(); st.unit = x.id; load(); } } }, x.name) : x.name), h('td', {}, h('span', { class: 'st ' + x.status }, ST[x.status].split('—')[0])), h('td', {}, fa(x.filled)), d.kpis.map(k => h('td', {}, x.kpi[k.code] === null ? '—' : fa(x.kpi[k.code])))))))));
  }
  load();
}

// ================= گزارش و جمع =================
async function viewReport() {
  const st = { unit: S.me.unit_id, mode: 'ind', only: false, hide: true, q: '' }, box = h('div');
  $view.append(box);
  async function load() {
    const r = await api('GET', `/api/rollup?period=${S.per}&unit=${st.unit}${st.only ? '&approved=1' : ''}`); clear(box);
    if (r.s !== 200) return box.append(msg('err', r.j.error));
    const d = r.j, ST = S.cat.statusFa, ctl = h('div', { class: 'card' });
    const q = h('input', { placeholder: 'جست‌وجو در عنوان…', value: st.q, on: { input: () => { st.q = q.value; drawT(); } } });
    ctl.append(h('h1', {}, 'گزارش و جمع زیرمجموعه‌ها'), h('div', { class: 'grid2' }, field('واحد', unitSel(st.unit, (v) => { st.unit = v; load(); })), field('دوره', periodSel(load)), field('نمایش', h('select', { on: { change: (e) => { st.mode = e.target.value; drawT(); } } }, h('option', { value: 'ind', selected: st.mode === 'ind' }, 'جمع شاخص‌ها'), h('option', { value: 'rep', selected: st.mode === 'rep' }, 'گزارش محاسباتی و درصدی'))), field('جست‌وجو', q)),
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: st.only, on: { change: (e) => { st.only = e.target.checked; load(); } } }), 'فقط واحدهای تأییدشده'), h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: st.hide, on: { change: (e) => { st.hide = e.target.checked; drawT(); } } }), 'پنهان کردن ردیف‌های خالی'),
      h('div', { class: 'row' }, h('button', { class: 'b', on: { click: () => download(`/api/export.xlsx?period=${S.per}&unit=${st.unit}`, 'گزارش.xlsx') } }, 'خروجی اکسل (همه‌ی شیت‌ها)'), h('button', { class: 'b sec', on: { click: () => importDlg(st.unit) } }, 'درون‌ریزی از اکسل')));
    const tb = h('div', { class: 'card' }); box.append(ctl, tb);
    function drawT() {
      clear(tb); const head = h('tr', {}, h('th', {}, 'کد'), h('th', {}, 'شاخص'), d.cols.map(c => h('th', {}, c.name, c.status ? h('div', {}, h('span', { class: 'st ' + c.status }, ST[c.status].split('—')[0])) : null)));
      const t = h('table', { class: 'tbl matrix' }, head), qq = st.q.trim(); let n = 0;
      if (st.mode === 'ind') {
        for (const b of BLOCKS) { const rows = [];
          for (const sub of b.subs) for (const id of sub.inds) { const I = IND[id]; if (I.kind !== 'num') continue; const vals = d.sums.map(s => s[id]); if (st.hide && !vals.some(v => v)) continue; if (qq && !I.title.includes(qq) && id !== qq) continue; rows.push(h('tr', {}, h('td', {}, id), h('td', { class: 'l' }, I.title), vals.map(v => h('td', {}, fmt(v))))); }
          if (rows.length) { t.append(h('tr', {}, h('th', { colSpan: d.cols.length + 2, class: 'l' }, b.title)), rows); n += rows.length; } }
      } else for (const x of S.cat.report) { if (qq && !x.title.includes(qq) && x.code !== qq) continue; const vals = d.report.map(rp => rp[x.code]); if (st.hide && vals.every(v => v === null || v === undefined || v === 0)) continue; t.append(h('tr', {}, h('td', {}, x.code), h('td', { class: 'l' }, x.title), vals.map(v => h('td', {}, v === null || v === undefined ? '—' : fmt(v) + (x.pct ? '٪' : ''))))); n++; }
      tb.append(n ? h('div', { class: 'scroll' }, t) : h('p', { class: 'mut' }, 'ردیفی برای نمایش نیست (هنوز آماری ثبت نشده یا فیلتر فعال است).'));
    }
    drawT();
  }
  load();
}

// ================= تأیید ارسال‌ها =================
async function viewAppr() {
  const r = await api('GET', `/api/approvals?period=${S.per}`), box = h('div', { class: 'card' }); $view.append(box);
  if (r.s !== 200) return box.append(msg('err', r.j.error));
  const ST = S.cat.statusFa, per = S.periods.find(p => p.id === S.per);
  box.append(h('div', { class: 'row sp' }, h('h1', {}, 'تأیید ارسال‌ها'), periodSel(() => renderShell())), h('div', {}, r.j.length ? null : h('p', { class: 'mut' }, 'واحدی برای تأیید در محدوده‌ی شما نیست.')),
    h('div', { class: 'scroll' }, h('table', { class: 'tbl' }, h('tr', {}, ['واحد', 'وضعیت', 'خانه‌های پرشده', 'هشدار', 'زمان ارسال', ''].map(x => h('th', {}, x))),
      r.j.map(x => h('tr', {}, h('td', { class: 'l' }, x.name), h('td', {}, h('span', { class: 'st ' + x.status }, ST[x.status].split('—')[0])), h('td', {}, fa(x.filled)), h('td', {}, x.warnings ? fa(x.warnings) : '—'), h('td', {}, when(x.submitted_at)),
        h('td', {}, h('div', { class: 'row' }, x.filled ? h('button', { class: 'b sm sec', on: { click: () => viewUnit(x) } }, 'مشاهده') : null, x.status === 'submitted' && per.status === 'open' ? h('button', { class: 'b sm', on: { click: () => decide(x, 'approve') } }, 'تأیید') : null, ['submitted', 'approved'].includes(x.status) && per.status === 'open' ? h('button', { class: 'b sm red', on: { click: () => decide(x, 'return') } }, 'برگشت') : null)))))));
  async function decide(x, act) {
    if (act === 'approve') { if (x.warnings && !confirm(`${x.name} دارای ${fa(x.warnings)} هشدار منطقی است. با این حال تأیید شود؟`)) return; const r2 = await api('POST', '/api/approvals/decide', { period: S.per, unit: x.unit_id, action: 'approve' }); if (r2.s === 200) renderShell(); else toast(r2.j.error); return; }
    const note = h('textarea', { rows: 3, placeholder: 'علت برگشت (الزامی)' }), out = h('div');
    const m = modal('برگشت برای اصلاح — ' + x.name, h('div', {}, note, out, h('button', { class: 'b red', on: { click: async () => { const r2 = await api('POST', '/api/approvals/decide', { period: S.per, unit: x.unit_id, action: 'return', note: note.value }); if (r2.s === 200) { m.remove(); renderShell(); } else out.append(msg('err', r2.j.error)); } } }, 'برگشت دادن')));
  }
  async function viewUnit(x) {
    const e = await api('GET', `/api/entries?period=${S.per}&unit=${x.unit_id}`); if (e.s !== 200) return toast(e.j.error);
    const V = e.j.values, w = warnings(Object.fromEntries(Object.entries(V).map(([k, v]) => [k, Number(v) || 0])));
    const rows = Object.entries(V).filter(([k]) => IND[k]).sort((a, b) => S.cat.indicators.findIndex(i => i.id === a[0]) - S.cat.indicators.findIndex(i => i.id === b[0]));
    modal(x.name, h('div', {}, w.length ? msg('warn', h('div', {}, h('b', {}, 'هشدارها:'), h('ul', {}, w.map(i => h('li', {}, warnText(i)))))) : msg('ok', 'هشدار منطقی ندارد.'), h('div', { class: 'scroll' }, h('table', { class: 'tbl' }, rows.map(([k, v]) => h('tr', {}, h('td', {}, k), h('td', { class: 'l' }, IND[k].title), h('td', {}, IND[k].kind === 'num' ? fmt(v) : v))))), h('button', { class: 'b sec sm', on: { click: () => download(`/api/export.xlsx?period=${S.per}&unit=${x.unit_id}`, 'آمار.xlsx') } }, 'خروجی اکسل')), true);
  }
}

// ================= کاربران و دسترسی =================
async function viewUsers() {
  const box = h('div'); $view.append(box);
  async function load() {
    const [us, al] = await Promise.all([api('GET', '/api/users'), api('GET', '/api/allow')]); clear(box);
    if (us.s !== 200) return box.append(msg('err', us.j.error));
    const pend = us.j.filter(u => u.status === 'pending' && u.totp_ok), SF = { pending: 'در انتظار', active: 'فعال', rejected: 'ردشده', suspended: 'معلق' };
    const setSt = async (u, st) => { const r = await api('POST', `/api/users/${u.id}/status`, { status: st }); if (r.s === 200) { toast('انجام شد'); load(); renderBadges(); } else toast(r.j.error); };
    box.append(h('div', { class: 'card' }, h('h1', {}, 'درخواست‌های در انتظار تأیید شما'),
      pend.length ? h('div', { class: 'scroll' }, h('table', { class: 'tbl' }, h('tr', {}, ['نام', 'واحد', 'کد ملی', 'ایمیل', 'تلفن', ''].map(x => h('th', {}, x))), pend.map(u => h('tr', {}, h('td', {}, u.full_name), h('td', {}, u.unit_name), h('td', { class: 'ltr' }, u.nid), h('td', { class: 'ltr' }, u.email), h('td', { class: 'ltr' }, u.phone), h('td', {}, h('div', { class: 'row' }, h('button', { class: 'b sm', on: { click: () => { if (confirm(`دسترسی ${u.full_name} (کد ملی ${u.nid}) تأیید شود؟\nبا تأیید، این فرد به آمار واحد «${u.unit_name}» دسترسی می‌یابد.`)) setSt(u, 'active'); } } }, 'تأیید'), h('button', { class: 'b sm red', on: { click: () => setSt(u, 'rejected') } }, 'رد'))))))) : h('p', { class: 'mut' }, 'درخواستی نیست. (کسانی که هنوز برنامه‌ی احراز هویت را تأیید نکرده‌اند اینجا نمی‌آیند.)')));
    // فهرست مجاز
    const nid = h('input', { class: 'ltr', inputMode: 'numeric', maxLength: 10 }), note = h('input', { placeholder: 'نام (اختیاری)' }), role = h('select', {}, (S.cat.roleFa?Object.entries(S.cat.roleFa):[]).map(([k,v])=>h('option',{value:k},v))), uSel = unitSel(S.me.unit_id, () => { }), out = h('div');
    box.append(h('div', { class: 'card' }, h('h1', {}, 'فهرست مجاز (دعوت)'), h('p', { class: 'mut' }, 'ثبت‌نام فقط برای کد ملی‌هایی ممکن است که شما اینجا ثبت کنید. پس از ثبت‌نامِ فرد، باید همین‌جا دسترسی‌اش را تأیید کنید.'),
      h('form', { on: { submit: async (e) => { e.preventDefault(); clear(out); const r = await api('POST', '/api/allow', { nid: en(nid.value), unit_id: +uSel.value, role: role.value, note: note.value }); if (r.s === 200) { toast('افزوده شد'); load(); } else out.append(msg('err', r.j.error)); } } },
        h('div', { class: 'grid2' }, field('کد ملی', nid), field('نام', note), field('واحد', uSel), field('نقش', role)), out, h('div', { class: 'row' }, h('button', { class: 'b' }, 'افزودن'), h('button', { type: 'button', class: 'b sec', on: { click: bulkDlg } }, 'بارگذاری گروهی (اکسل / متن)'), h('button', { type: 'button', class: 'b sec', on: { click: () => download('/api/allow/template.xlsx', 'قالب.xlsx') } }, 'دانلود قالب اکسل'))),
      h('div', { class: 'scroll' }, h('table', { class: 'tbl' }, h('tr', {}, ['کد ملی', 'نام', 'واحد', 'نقش', 'وضعیت', ''].map(x => h('th', {}, x))), (al.j || []).map(a => h('tr', {}, h('td', { class: 'ltr' }, '••••••' + a.nid_last4), h('td', {}, a.note), h('td', {}, (S.units.find(u => u.id === a.unit_id) || {}).name), h('td', {}, (S.cat.roleFa || {})[a.role] || a.role), h('td', {}, a.used ? 'ثبت‌نام کرده' : 'منتظر ثبت‌نام'), h('td', {}, a.used ? null : h('button', { class: 'b sm red', on: { click: async () => { if (confirm('حذف شود؟')) { await api('DELETE', '/api/allow/' + a.id); load(); } } } }, 'حذف'))))))));
    box.append(h('div', { class: 'card' }, h('h1', {}, 'همه‌ی کاربران'), h('div', { class: 'scroll' }, h('table', { class: 'tbl' }, h('tr', {}, ['نام', 'واحد', 'نقش', 'کد ملی', 'وضعیت', 'آخرین ورود', ''].map(x => h('th', {}, x))),
      us.j.map(u => h('tr', {}, h('td', {}, u.full_name), h('td', {}, u.unit_name), h('td', {}, (S.cat.roleFa || {})[u.role] || u.role), h('td', { class: 'ltr' }, '••••••' + u.nid_last4), h('td', {}, SF[u.status] || u.status), h('td', {}, when(u.last_login)),
        h('td', {}, h('div', { class: 'row' }, u.status === 'active' ? h('button', { class: 'b sm red', on: { click: () => { if (confirm('دسترسی معلق شود؟')) setSt(u, 'suspended'); } } }, 'تعلیق') : null, ['suspended', 'rejected'].includes(u.status) && u.totp_ok ? h('button', { class: 'b sm', on: { click: () => setSt(u, 'active') } }, 'فعال‌سازی') : null,
          h('button', { class: 'b sm sec', on: { click: async () => { if (!confirm('حساب پاک و کد ملی دوباره برای ثبت‌نام آزاد می‌شود (مثلاً برای گم‌شدن گوشی). ادامه؟')) return; const r = await api('POST', `/api/users/${u.id}/reset`, {}); if (r.s === 200) load(); else toast(r.j.error); } } }, 'بازنشانی')))))))));
  }
  async function renderBadges() { const ib = await api('GET', '/api/inbox'); S.inbox = ib.j; }
  function bulkDlg() {
    const f = h('input', { type: 'file', accept: '.xlsx' }), ta = h('textarea', { rows: 6, class: 'ltr', placeholder: 'هر خط: کدملی، نام، واحد، نقش\n0012345678, علی احمدی, مهاباد, کارشناس' }), out = h('div'), go = h('button', { class: 'b', disabled: true }, 'ثبت نهایی'); let payload = null;
    const preview = async () => { clear(out); go.disabled = true; payload = f.files[0] ? { data: await b64(f.files[0]) } : { csv: ta.value }; if (!f.files[0] && !ta.value.trim()) return;
      const r = await api('POST', '/api/allow/bulk', { ...payload, dry: true }); if (r.s !== 200) return out.append(msg('err', r.j.error));
      out.append(msg(r.j.valid ? 'info' : 'warn', `${fa(r.j.valid)} ردیف معتبر`), ...r.j.errors.slice(0, 30).map(e => msg('warn', (e.row ? `ردیف ${fa(e.row)}: ` : '') + e.msg))); go.disabled = !r.j.valid; };
    const m = modal('بارگذاری گروهی کد ملی', h('div', {}, h('p', { class: 'mut' }, 'ستون‌ها: کد ملی، نام، واحد (دقیقاً مطابق فهرست واحدها)، نقش. می‌توانید قالب اکسل را دانلود کنید.'), field('فایل اکسل', f), field('یا متن (هر خط یک نفر)', ta), h('button', { class: 'b sec', on: { click: preview } }, 'پیش‌نمایش و بررسی'), out, go), true);
    go.addEventListener('click', async () => { const r = await api('POST', '/api/allow/bulk', payload); if (r.s !== 200) return toast(r.j.error); m.remove(); toast(`${fa(r.j.added)} کد ملی ثبت شد`); load(); });
  }
  load();
}

// ================= تحلیل و شاخص‌ها =================
async function viewAnalytics() {
  const st = { unit: S.me.unit_id, kpi: S.cat.kpis[0], only: false }, box = h('div');
  $view.append(box);
  async function load() {
    const r = await api('GET', `/api/dashboard?period=${S.per}&unit=${st.unit}${st.only ? '&approved=1' : ''}`); clear(box);
    if (r.s !== 200) return box.append(msg('err', r.j.error));
    const d = r.j, ST = S.cat.statusFa, kt = Object.fromEntries(d.kpis.map(k => [k.code, k.title]));
    const rows = d.rows.map(x => ({ ...x, v: x.kpi[st.kpi] })).sort((a, b) => (b.v ?? -1) - (a.v ?? -1));
    const unitName = (S.units.find(u => u.id === st.unit) || {}).name || d.unit.name;
    box.append(h('div', { class: 'card' },
      h('div', { class: 'row sp' },
        h('h1', {}, 'تحلیل و شاخص‌ها — ', unitName),
        h('div', { class: 'row' },
          h('button', { class: 'b sec sm', on: { click: () => { if (d.unit.parent_id) { st.unit = d.unit.parent_id; load(); } } } }, '↑ بالاتر'),
          periodSel(() => renderShell()))),
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: st.only, on: { change: (e) => { st.only = e.target.checked; load(); } } }), 'فقط تأییدشده‌ها'),
      h('div', { class: 'row' }, S.cat.kpis.map(function (k) { return h('button', { class: 'pill' + (k === st.kpi ? ' on' : ''), on: { click: function () { st.kpi = k; load(); } } }, kt[k]); }))));
    // KPI summary
    box.append(h('div', { class: 'card' }, h('h2', {}, 'شاخص کل واحد'), h('div', { class: 'kpis' }, d.kpis.map(function (k) { return h('div', { class: 'kpi' }, h('b', {}, d.total[k.code] === null ? '—' : fa(d.total[k.code]) + '٪'), h('span', {}, k.title)); }))));
    // Ranking table
    const tbl = h('table', { class: 'tbl' }, h('tr', {}, h('th', {}, 'رتبه'), h('th', {}, 'واحد'), h('th', {}, 'وضعیت'), h('th', {}, kt[st.kpi]), h('th', {}, 'نقاط قوت/ضعف')));
    rows.forEach((x, i) => {
      const strong = x.v !== null && x.v >= 80; const weak = x.v !== null && x.v < 50;
      tbl.append(h('tr', {}, h('td', {}, fa(i + 1)), h('td', { class: 'l' }, x.name), h('td', {}, h('span', { class: 'st ' + x.status }, ST[x.status].split('—')[0])), h('td', {}, x.v === null ? '—' : fa(x.v) + '٪'), h('td', {}, strong ? '✓ قوی' : weak ? '⚠ ضعیف — نیاز به مداخله' : '—')));
    });
    box.append(h('div', { class: 'card' }, h('h2', {}, 'رتبه‌بندی واحدها بر اساس ' + kt[st.kpi]), h('div', { class: 'scroll' }, tbl)));
    // Weaknesses / interventions
    const weakUnits = rows.filter(x => x.v !== null && x.v < 50);
    if (weakUnits.length) box.append(h('div', { class: 'card' }, h('h2', {}, 'نقاط ضعف و مداخلات پیشنهادی'), h('ul', {}, weakUnits.map(x => h('li', {}, x.name + ' — ' + kt[st.kpi] + ': ' + fa(x.v) + '٪. پیشنهاد: بازرسی هدفمند، آموزش، و پایش ماهانه.')))));
    const strongUnits = rows.filter(x => x.v !== null && x.v >= 80);
    if (strongUnits.length) box.append(h('div', { class: 'card' }, h('h2', {}, 'نقاط قوت'), h('ul', {}, strongUnits.map(x => h('li', {}, x.name + ' — ' + kt[st.kpi] + ': ' + fa(x.v) + '٪. الگو برای سایر واحدها.')))));
    // Verification section
    box.append(h('div', { class: 'card' }, h('h2', {}, 'راستی‌آزمایی (Audit)'), h('p', { class: 'mut' }, 'برای بررسی یکپارچگی داده‌ها، از بخش «مدیریت ستاد» ← «ممیزی» استفاده کنید. هشدارهای منطقی در صفحه‌ی «تأیید ارسال‌ها» قابل مشاهده است.')));
  }
  load();
}
// ================= مدیریت ستاد =================
async function viewAdmin() {
  const box = h('div'); $view.append(box);
  async function load() {
    const [pf, au] = await Promise.all([api('GET', '/api/profile/all'), api('GET', '/api/audit')]); clear(box);
    // دوره‌ها
    const lab = h('input', { placeholder: 'مثلاً: ۱۴۰۵ — سه‌ماهه‌ی دوم' });
    box.append(h('div', { class: 'card' }, h('h1', {}, 'دوره‌های آماری'), h('table', { class: 'tbl' }, S.periods.map(p => h('tr', {}, h('td', { class: 'l' }, p.label), h('td', {}, p.status === 'open' ? 'باز' : 'بسته'), h('td', {}, h('div', { class: 'row' }, h('button', { class: 'b sm sec', on: { click: async () => { await api('POST', `/api/periods/${p.id}/status`, { status: p.status === 'open' ? 'closed' : 'open' }); await enter(); } } }, p.status === 'open' ? 'بستن' : 'بازکردن'), h('button', { class: 'b sm sec', on: { click: async () => { const nl = prompt('عنوان جدید:', p.label); if (!nl) return; const r = await api('PUT', `/api/periods/${p.id}`, { label: nl }); if (r.s === 200) await enter(); else toast(r.j.error); } } }, 'ویرایش'), h('button', { class: 'b sm red', on: { click: async () => { if (!confirm('این دوره و تمام داده‌های آن حذف شود؟')) return; const r = await api('DELETE', `/api/periods/${p.id}`); if (r.s === 200) await enter(); else toast(r.j.error); } } }, 'حذف')))))),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, lab), h('button', { class: 'b', on: { click: async () => { const r = await api('POST', '/api/periods', { label: lab.value }); if (r.s === 200) { await enter(); } else toast(r.j.error); } } }, 'دوره‌ی جدید'))));
    // پروفایل فرم
    const off = new Set((pf.j || []).map(x => x.unit_type + '|' + x.sub_key)), types = [['country', 'کشور'], ['university', 'دانشگاه'], ['county', 'شهرستان'], ['center', 'مرکز خدمات'], ['base', 'پایگاه'], ['house', 'خانه بهداشت']], chg = {};
    const prof = h('div', { class: 'card' }, h('h1', {}, 'فرم کوتاه برای هر سطح'), h('p', { class: 'mut' }, 'تیک = این بخش در فرم آن سطح نمایش داده شود. بخش‌های نبسته بدون حذف داده فقط پنهان می‌شوند (مثلاً مرکز خدمات جامع روستایی فقط ردیف‌های مرتبط را ببیند).'));
    for (const b of BLOCKS) { const d = h('details', { class: 'sub' }, h('summary', {}, b.title));
      const t = h('table', { class: 'tbl' }, h('tr', {}, h('th', {}, 'بخش'), types.map(x => h('th', {}, x[1]))));
      for (const s of b.subs) t.append(h('tr', {}, h('td', { class: 'l' }, s.title), types.map(([ty]) => { const k = ty + '|' + s.key; const c = h('input', { type: 'checkbox', checked: !off.has(k) }); c.addEventListener('change', () => { chg[k] = [ty, s.key, c.checked]; }); return h('td', {}, c); })));
      d.append(t); prof.append(d); }
    prof.append(h('button', { class: 'b', on: { click: async () => { for (const [ty] of types) { const hide = [], show = []; for (const [t2, k, on] of Object.values(chg)) if (t2 === ty) (on ? show : hide).push(k); if (hide.length || show.length) await api('POST', '/api/profile', { unit_type: ty, hide, show }); } toast('ذخیره شد'); load(); } } }, 'ذخیره‌ی پروفایل‌ها'));
    box.append(prof);
    // واحدها
    const nm = h('input', { placeholder: 'نام واحد جدید' }), par = unitSel(S.me.unit_id, () => { }, (u) => u.type !== 'house');
    box.append(h('div', { class: 'card' }, h('h1', {}, 'ساختار واحدها'), h('p', { class: 'mut' }, `${fa(S.units.length)} واحد تعریف شده است. (برای افزودن مرکز/پایگاه/خانه‌ی بهداشت، واحد والد را انتخاب کنید؛ نوع واحد به‌صورت خودکار تعیین می‌شود.)`), h('div', { class: 'grid2' }, field('زیرمجموعه‌ی', par), field('نام واحد جدید', nm)),
      h('div', { class: 'row' }, h('button', { class: 'b', on: { click: async () => { const r = await api('POST', '/api/units', { parent_id: +par.value, name: nm.value }); if (r.s === 200) { const u = await api('GET', '/api/units'); S.units = u.j; load(); } else toast(r.j.error); } } }, 'افزودن واحد'),
        h('button', { class: 'b red sm', on: { click: async () => { if (!confirm('این واحد و تمام زیرمجموعه‌های آن حذف شوند؟')) return; const r = await api('DELETE', '/api/units/' + par.value); if (r.s === 200) { const u = await api('GET', '/api/units'); S.units = u.j; load(); } else toast(r.j.error); } } }, 'حذف واحد انتخاب‌شده'))));
    // فایل ۲
    const f = h('input', { type: 'file', accept: '.xlsx' }), o2 = h('div'), ap = h('button', { class: 'b', disabled: true }, 'درون‌ریزی نهایی'); let data = null;
    f.addEventListener('change', async () => { clear(o2); ap.disabled = true; if (!f.files[0]) return; data = await b64(f.files[0]); const r = await api('POST', '/api/import/file2', { data, dry: true }); if (r.s !== 200) return o2.append(msg('err', r.j.error));
      o2.append(h('table', { class: 'tbl' }, Object.entries(r.j.tables).map(([k, v]) => h('tr', {}, h('td', { class: 'l' }, k), h('td', {}, fa(v))))), r.j.unmatched.length ? msg('warn', `${fa(r.j.unmatched.length)} ردیف با نام شهرستان نامطابق نادیده گرفته می‌شود.`) : null, r.j.missingSheets.length ? msg('warn', 'شیت‌های یافت‌نشده: ' + r.j.missingSheets.join('، ')) : null); ap.disabled = !r.j.total; });
    ap.addEventListener('click', async () => { ap.disabled = true; const r = await api('POST', '/api/import/file2', { data }); if (r.s === 200) { toast(`${fa(r.j.total)} ردیف وارد شد`); clear(o2); } else toast(r.j.error); });
    box.append(h('div', { class: 'card' }, h('h1', {}, 'درون‌ریزی «فایل ۲» (فهرست‌ها و جدول‌های قدیمی)'), h('p', { class: 'mut' }, 'فایل اکسل اصلی (استان ۲) را بدهید. ردیف‌های قبلاً درون‌ریزی‌شده جایگزین می‌شوند و تکرار نمی‌شوند؛ ردیف‌هایی که دستی ثبت شده‌اند دست‌نخورده می‌مانند.'), field('فایل', f), o2, ap));
    // ممیزی
    box.append(h('div', { class: 'card' }, h('h1', {}, 'گزارش حسابرسی (زنجیره‌ی درهم)'), au.s === 200 ? [msg(au.j.verify && au.j.verify.ok !== false ? 'ok' : 'err', au.j.verify && au.j.verify.ok !== false ? 'یکپارچگی زنجیره‌ی حسابرسی تأیید شد.' : 'هشدار: زنجیره‌ی حسابرسی دست‌کاری شده است! ' + JSON.stringify(au.j.verify)), h('div', { class: 'scroll' }, h('table', { class: 'tbl' }, h('tr', {}, ['زمان', 'کاربر', 'عمل', 'جزئیات', 'IP'].map(x => h('th', {}, x))), au.j.rows.map(x => h('tr', {}, h('td', {}, when(x.ts)), h('td', {}, x.full_name || '—'), h('td', {}, x.action), h('td', { class: 'ltr' }, (x.detail || '').slice(0, 80)), h('td', { class: 'ltr' }, x.ip)))))] : null));
  }
  load();
}
boot();

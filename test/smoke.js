'use strict';
const path = require('node:path'), fs = require('node:fs'), cp = require('node:child_process'), assert = require('node:assert');
const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'amar-')); process.env.DB_FILE = path.join(tmp, 't.db'); process.env.ALLOW_DEV_SECRET = '1'; process.env.COOKIE_SECURE = '0';
const run = (f, ...a) => cp.execFileSync('node', ['--no-warnings', path.join(__dirname, '..', 'scripts', f), ...a], { env: process.env, encoding: 'utf8' });
const L = require('../lib'), X = require('../xlsx');
const mkNid = (base) => { let s = 0; for (let i = 0; i < 9; i++) s += (+base[i]) * (10 - i); const r = s % 11; return base + (r < 2 ? r : 11 - r); };
const N = { root: '1387140175', mgr: mkNid('123456781'), exA: mkNid('223456782'), exB: mkNid('323456783'), exC: mkNid('423456784'), bad: '1234567890' };
for (const k of Object.keys(N)) if (k !== 'bad') assert(L.validNid(N[k]), k);
assert(!L.validNid(N.bad));
const out = run('create-root.js', N.root, 'مسئول ستاد', 'root@umsu.ac.ir');
const rootPw = out.match(/رمز موقت.*?: (\S+)/)[1], rootSecret = out.match(/کلید احراز.*?: (\S+)/)[1];
console.log(run('seed-urmia.js').trim());
const { server } = require('../server');
let base;
const code = (secret, d = 0) => L.totpAt(secret, Math.floor(Date.now() / 30000) + d);
function client() { let cookie = '', csrf = '';
  return { async call(m, u, b, noCsrf) { const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', 'x-csrf': noCsrf ? '' : csrf, cookie }, body: b ? JSON.stringify(b) : undefined });
      const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; const ct = r.headers.get('content-type') || ''; let j;
      if (ct.includes('json')) j = await r.json(); else j = Buffer.from(await r.arrayBuffer()); return { s: r.status, j }; },
    setCsrf(c) { csrf = c; } }; }
async function login(cl, nid, pw, secret, d) { const r = await cl.call('POST', '/api/login', { nid, password: pw, code: code(secret, d) }, true); assert.equal(r.s, 200, JSON.stringify(r.j)); const me = await cl.call('GET', '/api/me'); cl.setCsrf(me.j.csrf); return me.j.user; }
(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r)); base = 'http://127.0.0.1:' + server.address().port;
  const root = client(); let r;
  r = await root.call('POST', '/api/login', { nid: N.root, password: 'wrong-password-1', code: code(rootSecret) }, true); assert.equal(r.s, 401);
  await login(root, N.root, rootPw, rootSecret, 0);
  r = await root.call('POST', '/api/periods', { label: 'x' }, true); assert.equal(r.s, 403, 'csrf');
  assert.equal((await root.call('POST', '/api/periods', { label: 'شش‌ماهه اول ۱۴۰۵' })).s, 200);
  const units = (await root.call('GET', '/api/units')).j; assert.equal(units.length, 20);
  const county = (n) => units.find(u => u.name === n);
  // ----- بارگذاری گروهی کدملی
  const csv = [`کد ملی,نام,واحد,نقش`, `${N.mgr},مسئول مهاباد,مهاباد,مسئول`, `${N.exA},کارشناس مهاباد,مهاباد,کارشناس`, `${N.exB},کارشناس اشنویه,شهرستان اشنویه,کارشناس`, `${N.bad},بد,ارومیه,کارشناس`, `${N.exC},ناشناس,قم,کارشناس`].join('\n');
  r = await root.call('POST', '/api/allow/bulk', { csv, dry: true }); assert.equal(r.s, 200); assert.equal(r.j.valid, 3); assert.equal(r.j.errors.length, 2);
  r = await root.call('POST', '/api/allow/bulk', { csv }); assert.equal(r.j.added, 3);
  const xl = X.build([{ name: 'فهرست مجاز', rows: [['کد ملی', 'نام', 'واحد', 'نقش'], [N.exC, 'کارشناس ارومیه', 'ارومیه', 'کارشناس']] }]);
  r = await root.call('POST', '/api/allow/bulk', { data: xl.toString('base64') }); assert.equal(r.j.added, 1, JSON.stringify(r.j));
  assert.equal((await root.call('GET', '/api/allow/template.xlsx')).s, 200);
  // ----- ثبت‌نام
  const reg = {};
  for (const [k, nm, em] of [['mgr', 'مسئول مهاباد', 'm@umsu.ac.ir'], ['exA', 'کارشناس مهاباد', 'a@umsu.ac.ir'], ['exB', 'کارشناس اشنویه', 'b@umsu.ac.ir'], ['exC', 'کارشناس ارومیه', 'c@umsu.ac.ir']]) {
    const cl = client(); const x = await cl.call('POST', '/api/register', { nid: N[k], full_name: nm, email: em, password: 'Abcdefghij12' }, true); assert.equal(x.s, 200, JSON.stringify(x.j));
    reg[k] = { cl, secret: x.j.totp_secret };
  }
  assert.equal((await client().call('POST', '/api/register', { nid: N.root, full_name: 'x', email: 'a@x.ac.ir', password: 'Abcdefghij12' }, true)).s, 400);
  assert.equal((await client().call('POST', '/api/register', { nid: N.exA, full_name: 'x', email: 'a@gmail.com', password: 'Abcdefghij12' }, true)).s, 400);
  for (const k of ['mgr', 'exA', 'exB', 'exC']) {
    r = await reg[k].cl.call('POST', '/api/register/verify', { nid: N[k], password: 'Abcdefghij12', code: code(reg[k].secret, -1) }, true); assert.equal(r.s, 200);
  }
  r = await reg.exA.cl.call('POST', '/api/register/verify', { nid: N.exA, password: 'Abcdefghij12', code: code(reg.exA.secret, -1) }, true); assert.equal(r.s, 401, 'replay');
  r = await reg.exA.cl.call('POST', '/api/login', { nid: N.exA, password: 'Abcdefghij12', code: code(reg.exA.secret, 0) }, true); assert.equal(r.s, 403, 'pending');
  assert.equal((await root.call('GET', '/api/inbox')).j.pendingUsers, 4);
  const users = (await root.call('GET', '/api/users')).j;
  for (const u of users.filter(u => u.status === 'pending')) assert.equal((await root.call('POST', `/api/users/${u.id}/status`, { status: 'active' })).s, 200);
  // ----- ورود آمار
  const exA = client(); await login(exA, N.exA, 'Abcdefghij12', reg.exA.secret, 1);
  const per = (await exA.call('GET', '/api/periods')).j[0].id;
  const put = (cl, ind, v) => cl.call('PUT', '/api/entries', { period: per, ind, value: v });
  for (const [k, v] of Object.entries({ 'B1-C': 10, 'B1-D': 20, 'B1-E': 30, 'B1-F': 5, 'B1-G': 5, 'B1-I': 7, 'B1-J': 8, 'B1-K': 9, 'B1-L': 1, 'B1-M': 0 })) assert.equal((await put(exA, k, v)).s, 200);
  assert.equal((await put(exA, 'B1-C', '-5')).s, 400); assert.equal((await put(exA, 'B1-C', 'abc')).s, 400); assert.equal((await put(exA, 'NOPE', 1)).s, 400);
  assert.equal((await put(exA, 'B1-D', '۲۰')).s, 200, 'persian digits');
  r = await exA.call('GET', `/api/history?period=${per}&ind=B1-D`); assert(r.j.length >= 1);
  assert.equal((await put(exA, 'B1-P', 99)).s, 200);                               // بازرسی‌شده (O..T) > شناسایی‌شده → هشدار
  r = await exA.call('POST', '/api/entries/batch', { items: [{ period: per, ind: 'B1-Q', value: 3 }, { period: per, ind: 'ZZ', value: 1 }] }); assert.equal(r.j.results[0], null); assert(r.j.results[1]);
  assert.equal((await exA.call('GET', `/api/entries?period=${per}&unit=${county('اشنویه').id}`)).s, 403);
  assert.equal((await exA.call('GET', '/api/users')).s, 403); assert.equal((await exA.call('GET', `/api/approvals?period=${per}`)).s, 403); assert.equal((await exA.call('GET', `/api/dashboard?period=${per}`)).s, 403);
  // ----- ارسال و تأیید
  r = await exA.call('POST', '/api/submit', { period: per }); assert.equal(r.s, 409); assert(r.j.warnings.length >= 1);
  r = await exA.call('POST', '/api/submit', { period: per, ack: true }); assert.equal(r.s, 200);
  assert.equal((await put(exA, 'B1-C', 11)).s, 400, 'locked after submit');
  r = await root.call('GET', `/api/approvals?period=${per}`); const mah = r.j.find(x => x.name === 'مهاباد'); assert.equal(mah.status, 'submitted'); assert(mah.warnings >= 1);
  assert.equal((await root.call('GET', '/api/inbox')).j.pendingApprovals, 1);
  const mgr = client(); await login(mgr, N.mgr, 'Abcdefghij12', reg.mgr.secret, 1);
  r = await mgr.call('POST', '/api/approvals/decide', { period: per, unit: county('مهاباد').id, action: 'approve' }); assert.equal(r.s, 403, 'manager cannot approve own unit');
  r = await root.call('POST', '/api/approvals/decide', { period: per, unit: county('مهاباد').id, action: 'return' }); assert.equal(r.s, 400, 'note required');
  r = await root.call('POST', '/api/approvals/decide', { period: per, unit: county('مهاباد').id, action: 'return', note: 'عدد کارگاه‌های بازرسی‌شده را بررسی کنید' }); assert.equal(r.s, 200);
  assert.equal((await exA.call('GET', '/api/inbox')).j.returned, 1);
  assert.equal((await put(exA, 'B1-P', 5)).s, 200, 'editable after return');
  r = await exA.call('POST', '/api/submit', { period: per }); assert([200, 409].includes(r.s), 'resubmit');
  if (r.s === 409) assert.equal((await exA.call('POST', '/api/submit', { period: per, ack: true })).s, 200);
  assert.equal((await root.call('POST', '/api/approvals/decide', { period: per, unit: county('مهاباد').id, action: 'approve' })).s, 200);
  assert.equal((await put(exA, 'B1-C', 12)).s, 400, 'approved = locked');
  // ----- جمع و داشبورد
  const uni = units.find(u => u.parent_id === null);
  r = await root.call('GET', `/api/rollup?period=${per}&unit=${uni.id}`); assert.equal(r.s, 200);
  assert.equal(r.j.sums[0]['B1-C'], 10); const mi = r.j.cols.findIndex(c => c.name === 'مهاباد'); assert.equal(r.j.sums[mi]['B1-E'], 30);
  assert.equal(r.j.report[0]['PCT-B'], Math.round(25 / 70 * 10000) / 100);
  r = await root.call('GET', `/api/rollup?period=${per}&unit=${uni.id}&approved=1`); assert.equal(r.j.sums[0]['B1-C'], 10);
  r = await root.call('GET', `/api/dashboard?period=${per}`); assert.equal(r.j.status.approved, 1); assert.equal(r.j.rows.length, 19); assert.equal(r.j.total['PCT-B'], 35.71);
  // ----- اکسل: خروجی و درون‌ریزی
  r = await root.call('GET', `/api/export.xlsx?period=${per}&unit=${uni.id}`); assert.equal(r.s, 200);
  const wbk = X.read(r.j); assert.deepEqual(wbk.map(s => s.name), ['ورود آمار', 'جمع زیرمجموعه‌ها', 'گزارش محاسباتی']);
  const hdr = wbk[0].rows[4]; assert.equal(hdr[0], 'کد شاخص'); assert(hdr.includes('مهاباد'));
  const rowC = wbk[0].rows.find(x => x && x[0] === 'B1-C'); assert.equal(rowC[hdr.indexOf('مهاباد')], 10);
  const imp = X.build([{ name: 'ورود آمار', header: 4, rows: [[], [], [], ['کد شاخص', 'عنوان', 'اشنویه', 'نقده'], ['B1-C', 'x', 4, 6], ['B1-D', 'x', 3], ['ZZZ', 'x', 1]] }]);
  r = await root.call('POST', '/api/import/entries', { period: per, data: imp.toString('base64'), dry: true }); assert.equal(r.j.units['اشنویه'], 2); assert.equal(r.j.units['نقده'], 1);
  r = await root.call('POST', '/api/import/entries', { period: per, data: imp.toString('base64') }); assert.equal(r.j.applied, 3, JSON.stringify(r.j));
  r = await root.call('GET', `/api/entries?period=${per}&unit=${county('نقده').id}`); assert.equal(r.j.values['B1-C'], '6');
  r = await exA.call('POST', '/api/import/entries', { period: per, data: imp.toString('base64') }); assert.equal(r.j.applied, 0);             // کارشناس فقط واحد خود
  // ----- پروفایل فرم
  const sub = (await root.call('GET', '/api/catalog')).j.layout.find(x => x.t === 'sub' && x.blk === 'B5');
  assert.equal((await root.call('POST', '/api/profile', { unit_type: 'county', hide: [sub.key] })).s, 200);
  assert((await exA.call('GET', '/api/profile')).j.hidden.includes(sub.key));
  assert.equal((await exA.call('POST', '/api/profile', { unit_type: 'county', show: [sub.key] })).s, 403);
  // ----- جدول‌های فایل ۲
  const tb = (await root.call('GET', '/api/catalog')).j.tables, acc = tb.find(t => t.key === 'accident');
  const sexCol = acc.cols.find(c => c.label === 'جنس'), ageCol = acc.cols.find(c => c.label === 'سن');
  r = await exA.call('POST', '/api/records', { table: 'accident', data: { c1: 'علی', [sexCol.k]: '3' } }); assert.equal(r.s, 400);
  r = await exA.call('POST', '/api/records', { table: 'accident', data: { c1: 'علی', [sexCol.k]: '1', [ageCol.k]: '۳۴' } }); assert.equal(r.s, 200); const rid = r.j.id;
  r = await exA.call('GET', '/api/records?table=accident'); assert.equal(r.j.total, 1); assert.equal(r.j.rows[0].data[ageCol.k], '34');
  assert.equal((await exB_get(rid)).s, 403);
  async function exB_get() { const b = client(); await login(b, N.exB, 'Abcdefghij12', reg.exB.secret, 1); return b.call('PUT', `/api/records/${rid}`, { data: { c1: 'x' } }); }
  assert.equal((await exA.call('PUT', `/api/records/${rid}`, { data: { c1: 'علی رضایی' } })).s, 200);
  r = await root.call('GET', '/api/records?table=accident'); assert.equal(r.j.total, 1);
  r = await root.call('GET', '/api/records.xlsx?table=accident'); assert.equal(r.s, 200); assert.equal(X.read(r.j)[0].rows[3][1], 'علی رضایی');
  assert.equal((await exA.call('DELETE', `/api/records/${rid}`)).s, 200);
  const f2 = process.env.F2_FILE;
  if (f2 && fs.existsSync(f2)) {
    const b64 = fs.readFileSync(f2).toString('base64');
    r = await root.call('POST', '/api/import/file2', { data: b64, dry: true }); assert.equal(r.s, 200, JSON.stringify(r.j)); console.log('file2 preview', JSON.stringify(r.j.tables), 'unmatched', r.j.unmatched.length);
    r = await root.call('POST', '/api/import/file2', { data: b64 }); assert(r.j.total > 150);
    r = await root.call('GET', '/api/records?table=exams'); console.log('exam records', r.j.total); assert(r.j.total > 100);
    r = await root.call('POST', '/api/import/file2', { data: b64 }); r = await root.call('GET', '/api/records?table=exams'); console.log('exam records after re-import (no duplicates)', r.j.total);
  }
  // ----- امنیت
  for (let i = 0; i < 6; i++) await client().call('POST', '/api/login', { nid: N.exB, password: 'bad-password-123', code: '000000' }, true);
  r = await root.call('GET', '/api/audit'); assert.equal(r.j.verify.ok, true);
  assert.equal((await root.call('POST', `/api/users/${users.find(u => u.nid_last4 === N.exA.slice(-4)).id}/status`, { status: 'suspended' })).s, 200);
  assert.equal((await exA.call('GET', '/api/me')).s, 401);
  const idx = await fetch(base + '/'); assert(idx.headers.get('content-security-policy').includes("script-src 'self'"));
  assert.notEqual((await fetch(base + '/..%2Fserver.js')).status, 200); assert.equal((await fetch(base + '/api/records?table=accident')).status, 401);
  console.log('ALL SMOKE TESTS PASSED'); server.close(); process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });

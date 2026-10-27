'use strict';
// node scripts/create-root.js <کدملی> "<نام و نام خانوادگی>" <ایمیل سازمانی> ["نام واحد ریشه"]
const crypto = require('node:crypto');
const L = require('../lib'); const { db, audit } = require('../db');
const [nidRaw, name, email, rootName, rootType] = process.argv.slice(2);
const nid = L.validNid(nidRaw);
if (!nid || !name || !email) { console.error('استفاده: node scripts/create-root.js <کدملی معتبر> "<نام>" <ایمیل> ["دانشگاه علوم پزشکی ارومیه"]'); process.exit(1); }
let c = db.prepare('SELECT id FROM units WHERE parent_id IS NULL').get();
const rType = (rootType === 'country') ? 'country' : 'university';
const rName = rootName || (rType === 'country' ? 'ایران' : 'دانشگاه علوم پزشکی ارومیه');
if (!c) c = { id: +db.prepare("INSERT INTO units(parent_id,type,name) VALUES(NULL,?,?)").run(rType, rName).lastInsertRowid };
if (db.prepare('SELECT 1 FROM users WHERE nid_hash=?').get(L.hmac(nid))) { console.error('این کد ملی قبلاً ثبت شده است.'); process.exit(1); }
const pw = crypto.randomBytes(12).toString('base64url') + 'a1', secret = L.newTotpSecret();
db.prepare("INSERT INTO users(nid_hash,nid_enc,nid_last4,full_name,email,unit_id,role,pw_hash,totp_enc,totp_ok,status,created_at) VALUES(?,?,?,?,?,?,'manager_ohs',?,?,1,'active',?)")
  .run(L.hmac(nid), L.enc(nid), nid.slice(-4), name, email.toLowerCase(), c.id, L.hashPw(pw), L.enc(secret), Date.now());
audit(null, 'root_created', { last4: nid.slice(-4) }, 'cli');
console.log('\nمسئول ستاد ساخته شد.\nرمز موقت (بلافاصله تغییر دهید):', pw, '\nکلید احراز هویت (در Google Authenticator/برنامه‌ی مشابه وارد کنید):', secret,
  '\notpauth://totp/AmarSalamat:' + nid.slice(-4) + '?secret=' + secret + '&issuer=AmarSalamat\n');

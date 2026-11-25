'use strict';
// bootstrap.js — راهاندازی خودکار پایگاهداده خالی (برای Vercel / استقرار تازه)
// فقط زمانی اجرا میشود که هึงچ واحدهای تعریف نشده باشد.
const crypto = require('node:crypto');
const L = require('./lib');
const { db, audit } = require('./db');

if (!db.prepare('SELECT 1 FROM units LIMIT 1').get()) {
  const rootId = +db.prepare("INSERT INTO units(parent_id,type,name) VALUES(NULL,'country','ایران')").run().lastInsertRowid;
  const nid = '1387140175';
  const pw = crypto.randomBytes(12).toString('base64url') + 'a1';
  const secret = L.newTotpSecret();
  db.prepare("INSERT INTO users(nid_hash,nid_enc,nid_last4,full_name,email,unit_id,role,pw_hash,totp_enc,totp_ok,status,created_at) VALUES(?,?,?,?,?,?,'manager_ohs',?,?,1,'active',?)")
    .run(L.hmac(nid), L.enc(nid), nid.slice(-4), 'مسئول ستاد', 'admin@amar.local', rootId, L.hashPw(pw), L.enc(secret), Date.now());
  audit(null, 'bootstrap_root', { last4: nid.slice(-4) }, 'bootstrap');

  // دانشگاهها و شهرستانها
  require('./scripts/seed-iran');
  // دورههای آماری
  require('./scripts/seed-periods');
  // نمونه مراکز خدمات جامع سلامت (در صورت وجود فایل)
  try { require('./scripts/seed-centers'); } catch (e) { console.warn('seed-centers skipped:', e.message); }

  console.log('Bootstrap complete. root user:', nid, 'temp password:', pw, 'totp:', secret);
}

// اطمینان از وجود دورهها حتی اگر واحدها قبلاً ساخته شده باشند
if (!db.prepare('SELECT 1 FROM periods LIMIT 1').get()) {
  for (const p of ['۱۴۰۵ — ششماهه‌ی اول', '۱۴۰۵ — سالیانه']) db.prepare('INSERT OR IGNORE INTO periods(label) VALUES(?)').run(p);
}

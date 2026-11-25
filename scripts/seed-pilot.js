'use strict';
// seed-pilot.js — پایلوت دانشگاه علوم پزشکی ارومیه / شهرستان پیرانشهر
// اجرا: node scripts/seed-pilot.js
// این اسکریپت ایکدیگر بار هم قابل اجرا است (INSERT OR IGNORE).
const crypto = require('node:crypto');
const L = require('../lib');
const { db, audit } = require('../db');

const uni = db.prepare("SELECT id FROM units WHERE type='university' AND name='دانشگاه علوم پزشکی ارومیه'").get();
if (!uni) { console.error('دانشگاه ارومیه یافت نشد. ابتدا seed-iran.js را اجرا کنید.'); process.exit(1); }

let county = db.prepare("SELECT id FROM units WHERE parent_id=? AND type='county' AND name='پیرانشهر'").get(uni.id);
if (!county) county = { id: +db.prepare("INSERT INTO units(parent_id,type,name) VALUES(?,'county','پیرانشهر')").run(uni.id).lastInsertRowid };

const tree = [
  ['center', 'مرکز خدمات جامع سلامت پسوه', [
    ['base', 'پایگاه سلامت پسوه', [
      ['house', 'خانه بهداشت پسوه ۱'],
      ['house', 'خانه بهداشت پسوه ۲']
    ]],
    ['base', 'پایگاه سلامت سردشت', [
      ['house', 'خانه بهداشت سردشت ۱']
    ]]
  ]],
  ['center', 'مرکز خدمات جامع سلامت مرکز شهر پیرانشهر', [
    ['base', 'پایگاه سلامت مرکز شهر', [
      ['house', 'خانه بهداشت مرکز شهر ۱']
    ]]
  ]]
];

function add(parentId, type, name) {
  let row = db.prepare('SELECT id FROM units WHERE parent_id=? AND type=? AND name=?').get(parentId, type, name);
  if (!row) row = { id: +db.prepare('INSERT INTO units(parent_id,type,name) VALUES(?,?,?)').run(parentId, type, name).lastInsertRowid };
  return row.id;
}
const ids = {};
for (const [type, name, children] of tree) {
  const cid = add(county.id, type, name);
  ids[name] = cid;
  for (const [btype, bname, houses] of children) {
    const bid = add(cid, btype, bname);
    ids[bname] = bid;
    for (const [htype, hname] of houses) ids[hname] = add(bid, htype, hname);
  }
}

const users = [
  ['1001234561', 'مسئول بهداشت حرفه‌ای پیرانشهر', 'responsible_ohs', county.id, 'responsibility@piranshahr.ir'],
  ['1002345677', 'کارشناس بهداشت حرفه‌ای مرکز پسوه', 'expert_ohs', ids['مرکز خدمات جامع سلامت پسوه'], 'expert.ohs@piranshahr.ir'],
  ['1003456782', 'کارشناس بهداشت محیط مرکز پسوه', 'expert_ehs', ids['مرکز خدمات جامع سلامت پسوه'], 'expert.ehs@piranshahr.ir'],
  ['1004567898', 'بهورز خانه بهداشت پسوه ۱', 'behvarz', ids['خانه بهداشت پسوه ۱'], 'behvarz@piranshahr.ir'],
  ['1005678901', 'مدیر گروه بهداشت حرفه‌ای ارومیه', 'manager_ohs', uni.id, 'manager@piranshahr.ir']
];

let created = 0;
for (const [nid, name, role, unitId, email] of users) {
  if (db.prepare('SELECT 1 FROM users WHERE nid_hash=?').get(L.hmac(nid))) continue;
  const secret = L.newTotpSecret();
  db.prepare("INSERT INTO users(nid_hash,nid_enc,nid_last4,full_name,email,unit_id,role,pw_hash,totp_enc,totp_ok,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,1,'active',?)")
    .run(L.hmac(nid), L.enc(nid), nid.slice(-4), name, email, unitId, role, L.hashPw(crypto.randomBytes(12).toString('base64url') + 'a1'), L.enc(secret), Date.now());
  created++;
}
if (created) audit(null, 'pilot_seeded', { county: county.id, users: created }, 'seed');

console.log('پایلوت پیرانشهر آماده است.');
console.log('دانشگاه:', uni.id, '| شهرستان:', county.id);
for (const [nid, name, role] of users) console.log(' ', nid, role, name);
console.log('کاربران جدید:', created);

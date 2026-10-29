'use strict';
// seed-buinzahra.js — مراکز خدمات جامع سلامت شهرستان بوئین‌زهرا (از پورتال دانشگاه علوم پزشکی قزوین)
// اجرا: node scripts/seed-buinzahra.js
const { db } = require('../db');

const ROOT = db.prepare('SELECT id FROM units WHERE parent_id IS NULL').get();
if (!ROOT) { console.error('ابتدا create-root.js را اجرا کنید.'); process.exit(1); }
// find university
let uni = db.prepare("SELECT id FROM units WHERE parent_id=? AND type='university' AND name LIKE '%قزوین%'").get(ROOT.id);
if (!uni) { console.error('دانشگاه قزوین یافت نشد. ابتدا seed-iran.js را اجرا کنید.'); process.exit(1); }
// find county
let county = db.prepare("SELECT id FROM units WHERE parent_id=? AND type='county' AND name='بوئین زهرا'").get(uni.id);
if (!county) { county = { id: +db.prepare("INSERT INTO units(parent_id,type,name) VALUES(?,'county',?)").run(uni.id, 'بوئین زهرا').lastInsertRowid }; }

const centers = [
  'مرکز خدمات جامع سلامت شبانه روزی ارداق',
  'مرکز خدمات جامع سلامت شبانه روزی شال',
  'مرکز خدمات جامع سلامت شبانه روزی دانسفهان',
  'مرکز خدمات جامع سلامت شهری-روستایی بویین زهرا',
  'مرکز خدمات جامع سلامت شهری-روستایی سگزآباد',
  'مرکز خدمات جامع سلامت شهری روستایی عصمت آباد',
  'مرکز خدمات جامع سلامت روستایی آراسنج',
  'مرکز خدمات جامع سلامت روستایی ابراهیم آباد',
  'مرکز خدمات جامع سلامت روستایی شاهین تپه',
  'مرکز خدمات جامع سلامت روستایی شهرک مدرس',
  'مرکز خدمات جامع سلامت روستایی شهرستانک',
  'مرکز خدمات جامع سلامت روستایی لهارد'
];

let n = 0;
for (const c of centers) n += +db.prepare("INSERT OR IGNORE INTO units(parent_id,type,name) VALUES(?,'center',?)").run(county.id, c).changes;
console.log(`${n} مرکز به شهرستان بوئین‌زهرا افزوده شد.`);
console.log('کل واحدها:', db.prepare('SELECT COUNT(*) n FROM units').get().n);
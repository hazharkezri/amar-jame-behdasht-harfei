'use strict';
// seed-centers.js — بارگذاری مراکز/پایگاه‌ها/خانه‌های بهداشت از فایل JSON
// فرمت فایل data/health_centers.json:
// { "نام دانشگاه": { "نام شهرستان": ["نام مرکز 1", "نام مرکز 2", ...] } }
// اجرا: node scripts/seed-centers.js [path/to/file.json]
const fs = require('node:fs');
const path = require('node:path');
const { db } = require('../db');

const file = process.argv[2] || path.join(__dirname, '..', 'data', 'health_centers.json');
if (!fs.existsSync(file)) { console.error('فایل یافت نشد:', file); console.error('فرمت: { "دانشگاه علوم پزشکی X": { "شهرستان Y": ["مرکز 1", "مرکز 2"] } }'); process.exit(1); }
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const ROOT = db.prepare('SELECT id FROM units WHERE parent_id IS NULL').get();
if (!ROOT) { console.error('ابتدا create-root.js را اجرا کنید.'); process.exit(1); }

let total = 0;
for (const [uniName, counties] of Object.entries(data)) {
  const uni = db.prepare("SELECT id FROM units WHERE parent_id=? AND type='university' AND name=?").get(ROOT.id, uniName);
  if (!uni) { console.warn('دانشگاه یافت نشد:', uniName); continue; }
  for (const [countyName, centers] of Object.entries(counties)) {
    let county = db.prepare("SELECT id FROM units WHERE parent_id=? AND type='county' AND name=?").get(uni.id, countyName);
    if (!county) { county = { id: +db.prepare("INSERT INTO units(parent_id,type,name) VALUES(?,'county',?)").run(uni.id, countyName).lastInsertRowid }; console.log('  شهرستان جدید:', countyName); }
    for (const c of centers) {
      const t = /پایگاه/i.test(c) ? 'base' : /خانه/i.test(c) ? 'house' : 'center';
      total += +db.prepare("INSERT OR IGNORE INTO units(parent_id,type,name) VALUES(?,?,?)").run(county.id, t, c).changes;
    }
  }
}
console.log(`${total} واحد افزوده شد.`);
console.log('کل واحدها:', db.prepare('SELECT COUNT(*) n FROM units').get().n);
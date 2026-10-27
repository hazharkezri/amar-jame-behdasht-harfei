'use strict';
// شهرستان‌های دانشگاه علوم پزشکی ارومیه — دقیقاً مطابق شیت‌های فایل اکسل ۱. node scripts/seed-urmia.js
const { db } = require('../db');
const root = db.prepare('SELECT * FROM units WHERE parent_id IS NULL').get();
if (!root) { console.error('ابتدا create-root.js را اجرا کنید.'); process.exit(1); }
// اگر ریشه «کشور» باشد، دانشگاه ارومیه را زیر آن بساز (یا پیدا کن) و شهرستان‌ها را زیر دانشگاه بگذار.
let uni = root;
if (root.type === 'country') {
  let u = db.prepare("SELECT id FROM units WHERE parent_id=? AND type='university' AND name='دانشگاه علوم پزشکی ارومیه'").get(root.id);
  if (!u) u = { id: +db.prepare("INSERT INTO units(parent_id,type,name) VALUES(?,'university',?)").run(root.id, 'دانشگاه علوم پزشکی ارومیه').lastInsertRowid };
  uni = { id: u.id };
}
const C = ['ارومیه', 'اشنویه', 'بوکان', 'باروق', 'پلدشت', 'پیرانشهر', 'تکاب', 'چالدران', 'چایپاره', 'چهاربرج', 'سردشت', 'سلماس', 'شاهین دژ', 'شوط', 'ماکو', 'مهاباد', 'میاندوآب', 'میرآباد', 'نقده'];
let n = 0; for (const x of C) n += +db.prepare("INSERT OR IGNORE INTO units(parent_id,type,name) VALUES(?,'county',?)").run(uni.id, x).changes;
console.log(`${n} شهرستان افزوده شد (جمعاً ${C.length}).`);

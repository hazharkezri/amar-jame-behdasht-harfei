'use strict';
// seed-periods.js — دوره‌های آماری پیش‌فرض (شش‌ماهه و سالیانه)
// اجرا: node scripts/seed-periods.js
const { db } = require('../db');
const periods = ['۱۴۰۵ — شش‌ماهه‌ی اول', '۱۴۰۵ — سالیانه'];
let n = 0;
for (const p of periods) n += +db.prepare('INSERT OR IGNORE INTO periods(label) VALUES(?)').run(p).changes;
console.log(`${n} دوره افزوده شد.`);
console.log(db.prepare('SELECT * FROM periods').all());
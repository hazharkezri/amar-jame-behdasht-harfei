'use strict';
// node scripts/import-file2.js <فایل۲.xlsx> [--apply]   (بدون --apply فقط پیش‌نمایش)
const fs = require('node:fs'); const { db } = require('../db'); const { importFile2 } = require('../import2');
const [f, flag] = process.argv.slice(2); if (!f) { console.error('استفاده: node scripts/import-file2.js فایل.xlsx [--apply]'); process.exit(1); }
const root = db.prepare('SELECT id FROM units WHERE parent_id IS NULL').get(); const actor = (db.prepare("SELECT id FROM users WHERE role='manager' AND unit_id=? LIMIT 1").get(root.id) || {}).id || null;
const r = importFile2(fs.readFileSync(f), { root: root.id, actor, dry: flag !== '--apply' });
console.log(JSON.stringify(r, null, 1)); if (flag !== '--apply') console.log('\nپیش‌نمایش بود؛ برای ثبت نهایی --apply را اضافه کنید.');

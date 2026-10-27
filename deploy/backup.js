'use strict';
/* پشتیبان‌گیری دیتابیس و داده‌ها — ویندوز و لینوکس، بدون وابستگی خارجی.
   اجرا: node deploy/backup.js
   VACUUM INTO روی دیتابیسِ در حال کار هم امن است و ردیف‌های WAL را از دست نمی‌دهد. */
const path = require('node:path'), fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const root = path.join(__dirname, '..');
const dbFile = process.env.DB_FILE || path.join(root, 'data', 'app.db');
const dataDir = path.dirname(dbFile);
const backupDir = process.env.BACKUP_DIR || path.join(dataDir, 'backup');
const keep = Math.max(1, +(process.env.KEEP || 30));

if (!fs.existsSync(dbFile)) { console.error('دیتابیس پیدا نشد:', dbFile); process.exit(1); }
fs.mkdirSync(backupDir, { recursive: true });

// تاریخ محلی سرور (نه UTC) تا نام فایل با روز واقعی یکی باشد
const d = new Date();
const pad = (n) => String(n).padStart(2, '0');
const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const out = path.join(backupDir, `app-${stamp}.db`);

const db = new DatabaseSync(dbFile, { readOnly: false });
try {
  // اگر امروز قبلاً بکاپ گرفته شده، از روی همان روز بازنویسی نکن و نام جدید بده
  let target = out;
  if (fs.existsSync(target)) target = path.join(backupDir, `app-${stamp}-${Date.now()}.db`);
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  console.log('بکاپ دیتابیس:', target, `(${fs.statSync(target).size} بایت)`);
} finally { db.close(); }

// فایل‌های داده‌ی (شاخص‌ها، جدول‌ها، گزارش) هم کپی می‌شوند
for (const f of ['indicators.json', 'tables.json', 'report.json']) {
  const src = path.join(dataDir, f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(backupDir, f));
}

// نگه‌داشتن فقط KEEP نسخه‌ی آخر
const olds = fs.readdirSync(backupDir)
  .filter(f => /^app-\d{4}-\d{2}-\d{2}.*\.db$/.test(f))
  .sort();
for (const f of olds.slice(0, Math.max(0, olds.length - keep))) {
  fs.unlinkSync(path.join(backupDir, f));
  console.log('حذف نسخه‌ی قدیمی:', f);
}
console.log('تعداد نسخه‌های نگه‌داشته‌شده:', Math.min(olds.length, keep));

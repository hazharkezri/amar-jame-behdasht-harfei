'use strict';
// import-sameh.js — وارد کردن ساختار رسمی سامانه سامح (ارومیه / پیرانشهر)
// اجرا: node scripts/import-sameh.js
// این اسکریپت ایکدیگر بار قابل اجرا است و واحدهای رسمی را حفظ میکند.
const fs = require('node:fs');
const path = require('node:path');
const { db, audit, tx } = require('../db');

const SOURCE = path.join(__dirname, '..', 'data', 'sameh-network-piranshahr.json');
const ROOT_ID = 1;
const UNI_ID = 5;
const COUNTY_ID = 92;

// سه سطح بالای سامح با شناسههای موجود در پایگاهداده نگاشته میشوند.
const ID_MAP = {
  '10001': ROOT_ID,
  '1370000001': UNI_ID,
  '1370000836': COUNTY_ID
};

// ارجاعهای پایلوت قبلی به شناسههای رسمی سامح منتقل میشوند.
const REF_MAP = {
  518: 1370001214, // مرکز خدمات جامع سلامت پسوه
  520: 1370000903, // خانه بهداشت پسوه ۱
  521: 1370000901, // خانه بهداشت پسوه ۲
  524: 1370001213, // مرکز خدمات جامع سلامت شماره ۱
  525: 1370000849, // پایگاه سلامت شماره ۱
  526: 1370000853  // خانه بهداشت کشاورز
};

const stripType = (s) => String(s || '').replace(/\s*\([^)]*\)\s*$/, '').trim();

function officialName(x) {
  if (x.level === 4) return String(x.level4Name || stripType(x.name)).trim();
  if (x.level === 5 && /پایگاه/.test(x.type || '')) {
    const short = stripType(x.name);
    return /پایگاه/.test(short) ? short : `پایگاه سلامت ${short}`;
  }
  if (x.level === 5) return String(x.level5Name || stripType(x.name)).trim();
  if (x.level === 6) {
    const base = String(x.level6Name || stripType(x.name)).trim();
    return /دفاتر خدمات سلامت/.test(x.type) ? `دفتر خدمات سلامت ${base}` : base;
  }
  return stripType(x.name);
}

function officialType(x) {
  if (x.level === 4) return 'center';
  if (x.level === 5) return /پایگاه/.test(x.type || '') ? 'base' : 'house';
  if (x.level === 6) return 'base'; // آزمایشگاه / دفاتر خدمات سلامت بهعنوان واحد خدماتی
  if (x.level === 3) return 'county';
  if (x.level === 2) return 'university';
  return 'country';
}

if (!fs.existsSync(SOURCE)) {
  console.error(`فایل ساختار سامح یافت نشد: ${SOURCE}`);
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(SOURCE, 'utf8'));
if (!Array.isArray(raw) || !raw.length) throw new Error('ساختار سامح خالی است.');

const units = raw.map((x) => {
  const id = ID_MAP[x.id] !== undefined ? ID_MAP[x.id] : Number(x.id);
  const parentId = x.pid === '0' || x.pid === 0 || x.pid == null ? null : (ID_MAP[x.pid] !== undefined ? ID_MAP[x.pid] : Number(x.pid));
  return { id, parentId, type: officialType(x), name: officialName(x), level: x.level, rawId: String(x.id) };
}).filter((u) => Number.isFinite(u.id));

const keep = new Set(units.map((u) => u.id));

db.exec('PRAGMA defer_foreign_keys=ON');

const result = { inserted: 0, remapped: 0, removed: 0 };

const run = () => {
  // ۱) درج واحدهای رسمی با شناسهی ثابت سامح
  const ins = db.prepare(`INSERT INTO units(id,parent_id,type,name) VALUES(?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET parent_id=excluded.parent_id, type=excluded.type, name=excluded.name
    WHERE units.parent_id IS NOT excluded.parent_id OR units.type IS NOT excluded.type OR units.name IS NOT excluded.name`);
  for (const u of units) {
    if (Object.values(ID_MAP).includes(u.id)) continue; // ریشه، دانشگاه و شهرستان از قبل وجود دارند
    result.inserted += ins.run(u.id, u.parentId, u.type, u.name).changes;
  }

  // ۲) انتقال ارجاعهای قدیمی به شناسههای رسمی
  const refTables = [
    ['users', 'unit_id'], ['entries', 'unit_id'], ['entry_history', 'unit_id'],
    ['submissions', 'unit_id'], ['records', 'unit_id'], ['allow', 'unit_id']
  ];
  for (const [table, col] of refTables) {
    for (const [oldId, newId] of Object.entries(REF_MAP)) {
      if (!db.prepare('SELECT 1 FROM units WHERE id=?').get(newId)) continue;
      const sql = ['entries', 'submissions'].includes(table)
        ? `UPDATE OR REPLACE ${table} SET ${col}=? WHERE ${col}=?`
        : `UPDATE ${table} SET ${col}=? WHERE ${col}=?`;
      result.remapped += db.prepare(sql).run(newId, Number(oldId)).changes;
    }
  }

  // ۳) حذف واحدهای پایلوت قدیمی که جایگزین رسمی ندارند
  const descendantRows = db.prepare(`WITH RECURSIVE t(id) AS (SELECT ?1 UNION ALL SELECT u.id FROM units u JOIN t ON u.parent_id=t.id) SELECT id FROM t`).all(COUNTY_ID).map((r) => r.id);
  const stale = descendantRows.filter((id) => !keep.has(id));
  if (stale.length) {
    const ph = stale.map(() => '?').join(',');
    for (const [table, col] of refTables) db.prepare(`DELETE FROM ${table} WHERE ${col} IN (${ph})`).run(...stale);
    // حذف برگها تا باقیماندهای پیوندی نماند
    let guard = 0;
    while (guard++ < 100) {
      const leaves = db.prepare(`SELECT id FROM units WHERE id IN (${ph}) AND id NOT IN (SELECT parent_id FROM units WHERE parent_id IS NOT NULL AND parent_id IN (${ph}))`).all(...stale, ...stale).map((r) => r.id);
      if (!leaves.length) break;
      const lph = leaves.map(() => '?').join(',');
      result.removed += db.prepare(`DELETE FROM units WHERE id IN (${lph})`).run(...leaves).changes;
    }
  }

  audit(null, 'sameh_import', { file: path.basename(SOURCE), ...result }, 'import');

  return descendantRows.filter((id) => keep.has(id)).length;
};

const officialUnderCounty = tx(run);
console.log('ساختار سامح وارد شد:', JSON.stringify(result));
console.log('واحدهای رسمی در شهرستان پیرانشهر:', officialUnderCounty);
console.log('کل واحدها:', db.prepare('SELECT COUNT(*) n FROM units').get().n);

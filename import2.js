'use strict';
// درون‌ریزی داده‌های «فایل ۲» (جدول‌های حوادث، معاینات، سیلیس ...) به رکوردهای سامانه
const X = require('./xlsx');
const L = require('./lib');
const { db, subtreeIds, inList, tx } = require('./db');
const { TAB, normVal } = require('./report');

function importFile2(buf, { root, actor, dry }) {
  const sheets = X.read(buf), bySheet = new Map(sheets.map(s => [s.name, s]));
  const ids = subtreeIds(root), units = db.prepare(`SELECT id,name FROM units WHERE id IN (${inList(ids)})`).all(...ids);
  const byName = new Map(units.map(u => [L.norm(u.name), u.id]));
  const out = { tables: {}, unmatched: [], total: 0, missingSheets: [] }, batches = [];
  for (const t of TAB.tables) {
    const imp = t.import, sh = bySheet.get(imp.sheet);
    if (!sh) { if (!out.missingSheets.includes(imp.sheet)) out.missingSheets.push(imp.sheet); continue; }
    const recs = []; let last = null;
    for (let r = imp.first; r <= Math.min(imp.last, sh.rows.length - 1); r++) {
      const row = sh.rows[r]; if (!row) continue;
      const cell = (c) => { const v = row[c - 1]; return v === undefined || v === null ? '' : v; };
      let uname = imp.unit_col ? L.norm(String(cell(imp.unit_col))).replace(/^شهرستان /, '') : '';
      if (!uname && imp.ffill) uname = last || ''; else if (uname) last = uname;
      const data = {}; let any = false;
      for (const [c, k] of imp.cols) {
        let v = cell(c); if (v === '') continue;
        const col = t.cols.find(x => x.k === k);
        v = col.type === 'num' && typeof v === 'number' ? String(v) : String(v).trim();
        if (col.type === 'num') v = normVal(v);
        if (v !== '') { data[k] = v; any = true; }
      }
      if (imp.subtotal) {
        const txt = [String(cell(imp.unit_col)), ...imp.cols.slice(0, 3).map(x => String(cell(x[0])))].join(' ');
        if (/جمع|مجموع/.test(txt)) continue;
        const named = imp.cols.slice(0, 3).some(x => cell(x[0]) !== ''), counted = imp.cols.slice(3, 7).some(x => cell(x[0]) !== '');
        if (!named && !counted) continue;
      }
      if (!any && !(imp.keep_unit_only && uname)) continue;
      let uid;
      if (imp.unit_col) { uid = byName.get(uname); if (!uid) { out.unmatched.push({ table: t.title, row: r, unit: uname || '(خالی)' }); continue; } } else uid = root;
      recs.push({ uid, data: { ...data, _imp: 1 } });
    }
    out.tables[t.title] = recs.length; out.total += recs.length; batches.push([t.key, recs]);
  }
  if (!dry) tx(() => {
    for (const [key, recs] of batches) {
      db.prepare(`DELETE FROM records WHERE table_key=? AND unit_id IN (${inList(ids)}) AND data LIKE '%"_imp":1%'`).run(key, ...ids);
      for (const r of recs) db.prepare('INSERT INTO records(table_key,unit_id,data,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(key, r.uid, JSON.stringify(r.data), actor, actor, Date.now(), Date.now());
    }
  });
  return out;
}
module.exports = { importFile2 };

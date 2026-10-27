'use strict';
const fs = require('node:fs'), path = require('node:path');
const { col } = require('./xlsx');
function rd(f){
  const p = path.join(__dirname,'data',f);
  if(!fs.existsSync(p)){
    console.error(`خطا: فایل ${f} در پوشه data/ پیدا نشد.`);
    console.error('راهنما: ابتدا فایل‌های اکسل مرجع را آماده کرده و با دستور زیر داده‌ها را تولید کنید:');
    console.error('  py tools/extract.py <f1.xlsx> <f2.xlsx> data');
    process.exit(1);
  }
  try {
    return JSON.parse(fs.readFileSync(p,'utf8'));
  } catch (e) {
    console.error(`خطا در خواندن فایل ${f}: ${e.message}`);
    process.exit(1);
  }
}
const CAT = rd('indicators.json'), REP = rd('report.json'), TAB = rd('tables.json');
const IND = Object.fromEntries(CAT.indicators.map(i => [i.id, i]));
const letter = (c) => col(c - 1);           // ستون شیت‌های شهرستان (۱‌مبنا) ← حروف
const b1 = (c) => 'B1-' + letter(c);
// ---- قواعد منطقی (هشدار هنگام ثبت)
const RULES = [];
const rule = (a, bs) => RULES.push({ a, b: bs });
for (let k = 0; k < 6; k++) { rule(b1(9 + k), [b1(3 + k)]); rule(b1(15 + k), [b1(9 + k)]); rule(b1(27 + k), [b1(21 + k)]); }
rule(b1(41), [b1(40)]); rule(b1(42), [b1(41)]);
const insp = [15, 16, 17, 18, 19, 20].map(b1), inspW = [27, 28, 29, 30, 31, 32].map(b1);
for (let j = 0; j < 15; j++) { rule(b1(57 + 2 * j), insp); rule(b1(58 + 2 * j), inspW); }
for (let c = 47; c <= 56; c++) rule(b1(c), insp);
const RULES_OK = RULES.filter(r => IND[r.a] && r.b.every(x => IND[x]));
function checkRules(vals) {
  const out = [], v = (id) => Number(vals[id]) || 0;
  RULES_OK.forEach((r, i) => { const s = r.b.reduce((x, id) => x + v(id), 0); if (v(r.a) > s) out.push({ rule: i, a: r.a, got: v(r.a), max: s }); });
  return out;
}
// ---- فرمول‌های گزارش
const byCode = Object.fromEntries(REP.map(r => [r.code, r]));
function computeReport(vals) {
  const memo = {}, S = (a) => a.reduce((x, id) => x + (vals[id] || 0), 0);
  const val = (id) => id.startsWith('R:') ? rep(id.slice(2)) : (vals[id] || 0);
  function rep(code) {
    if (code in memo) return memo[code];
    const r = byCode[code]; memo[code] = null;
    const ex = r.toks.map(t => t[0] === 'l' ? t[1].replace(/SUM\(/g, '(') : t[0] === 'r' ? `v(${JSON.stringify(t[1])})` : `S(${JSON.stringify(t[1])})`).join('');
    let out; try { out = new Function('v', 'S', 'return ' + ex)(val, S); } catch (e) { out = null; }
    memo[code] = (typeof out === 'number' && isFinite(out)) ? Math.round(out * 100) / 100 : null; return memo[code];
  }
  const o = {}; for (const r of REP) o[r.code] = rep(r.code); return o;
}
const normVal = (v) => String(v == null ? '' : v).replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[٬،,\s]/g, '').replace(/٫/g, '.');
module.exports = { CAT, REP, TAB, IND, RULES: RULES_OK, checkRules, computeReport, normVal };

'use strict';
// seed-example.js — نمونه سلسله‌مراتب: وزارت بهداشت ← دانشگاه ← شبکه ← مرکز ← خانه بهداشت
const { db } = require('../db');

const ROOT = db.prepare('SELECT id FROM units WHERE parent_id IS NULL').get();
if (!ROOT) { console.error('ابتدا create-root.js را اجرا کنید.'); process.exit(1); }

// 1. دانشگاه
let uni = db.prepare("SELECT id FROM units WHERE parent_id=? AND type='university' AND name='دانشگاه آذربایجان غربی'").get(ROOT.id);
if (!uni) uni = { id: +db.prepare("INSERT INTO units(parent_id,type,name) VALUES(?,'university',?)").run(ROOT.id, 'دانشگاه آذربایجان غربی').lastInsertRowid };

// 2. شبکه (شهرستان)
let county = db.prepare("SELECT id FROM units WHERE parent_id=? AND type='county' AND name='شبکه پیرانشهر'").get(uni.id);
if (!county) county = { id: +db.prepare("INSERT INTO units(parent_id,type,name) VALUES(?,'county',?)").run(uni.id, 'شبکه پیرانشهر').lastInsertRowid };

// 3. مرکز خدمات جامع سلامت
let center = db.prepare("SELECT id FROM units WHERE parent_id=? AND type='center' AND name='مرکز پسوه'").get(county.id);
if (!center) center = { id: +db.prepare("INSERT INTO units(parent_id,type,name) VALUES(?,'center',?)").run(county.id, 'مرکز پسوه').lastInsertRowid };

// 4. خانه بهداشت
let house = db.prepare("SELECT id FROM units WHERE parent_id=? AND type='house' AND name='خانه پسوه 1'").get(center.id);
if (!house) house = { id: +db.prepare("INSERT INTO units(parent_id,type,name) VALUES(?,'house',?)").run(center.id, 'خانه پسوه 1').lastInsertRowid };

console.log('سلسله‌مراتب افزوده شد:');
console.log('  دانشگاه:', uni.id, 'دانشگاه آذربایجان غربی');
console.log('  شبکه:', county.id, 'شبکه پیرانشهر');
console.log('  مرکز:', center.id, 'مرکز پسوه');
console.log('  خانه:', house.id, 'خانه پسوه 1');
console.log('کل واحدها:', db.prepare('SELECT COUNT(*) n FROM units').get().n);
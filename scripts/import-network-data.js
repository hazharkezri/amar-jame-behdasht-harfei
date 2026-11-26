'use strict';
// import-network-data.js — وارد کردن کارگاه/اماکن و فهرست کاربران واردشده
// اجرا: node scripts/import-network-data.js
// فایل کاربران به دلیل حساسیت کد ملی در موقت نگهداری میشود و وارد جدول مجازها میشود.
const fs = require('node:fs');
const path = require('node:path');
const L = require('../lib');
const { db, audit, tx } = require('../db');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FACILITIES_FILE = path.join(DATA_DIR, 'units-piranshahr.json');
const EXPERTS_FILE = path.join(DATA_DIR, 'experts-piranshahr.json');
// فایل خام کاربران (شامل کد ملی) فقط بهصورت موقت و اختیاری است؛ در استقرارها وجود ندارد.
const USERS_FILE = process.env.USERS_IMPORT_FILE || 'C:/Users/laptopMad/AppData/Local/Temp/opencode/users-raw-piranshahr.json';
const COUNTY_ID = 92;
const ID_MAP = { '10001': 1, '1370000001': 5, '1370000836': COUNTY_ID };

const mapId = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v);
  return ID_MAP[s] !== undefined ? ID_MAP[s] : (/^\d+$/.test(s) ? Number(s) : null);
};
const exists = (id) => id != null && !!db.prepare('SELECT 1 FROM units WHERE id=?').get(id);
const text = (v) => String(v ?? '').trim();

function workforce(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '';
  if (v < 20) return 'کمتر از 20 نفر';
  if (v < 50) return '20-49 نفر';
  if (v < 500) return '50-499 نفر';
  return '>500 نفر';
}

function unitForFacility(x) {
  for (const key of ['networkId', 'level5Id', 'level4Id', 'level3Id']) {
    const id = mapId(x[key]);
    if (exists(id)) return id;
  }
  return COUNTY_ID;
}

function roleForUser(x) {
  const s = `${text(x.firstName)} ${text(x.lastName)} ${text(x.username)}`;
  if (/بهورز/.test(s)) return 'behvarz';
  if (/مدیر|مدير/.test(s)) return 'manager_ohs';
  if (/مسئول|مسوول/.test(s)) return 'responsible_ohs';
  return 'expert_ohs';
}

if (!fs.existsSync(FACILITIES_FILE)) {
  console.warn(`فایل کارگاهها یافت نشد؛ وارد کردن دادههای شبکه رد شد: ${FACILITIES_FILE}`);
} else {
  const facilities = JSON.parse(fs.readFileSync(FACILITIES_FILE, 'utf8'));
  const experts = fs.existsSync(EXPERTS_FILE) ? JSON.parse(fs.readFileSync(EXPERTS_FILE, 'utf8')) : [];
  const users = fs.existsSync(USERS_FILE) ? JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')) : [];

  const result = { facilities: 0, experts: 0, users: 0, skippedUsers: 0, notedUsers: 0 };

  tx(() => {
    db.prepare("DELETE FROM records WHERE table_key='tashkilat' AND (data LIKE '%\"_imported\":1%' OR data LIKE '%\"_sameh\":1%')").run();
    const ins = db.prepare('INSERT INTO records(table_key,unit_id,data,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,NULL,NULL,?,?)');
    const now = Date.now();
    for (const x of facilities) {
      const data = {
        c1: text(x.name),
        c2: text(x.address || x.postAddress),
        c3: text(x.activityName || x.isic_name),
        c4: workforce(x.staffCount),
        c11: text(x.lastProInspectorId_name),
        _imported: 1,
        _sourceId: text(x.id),
        _network: text(x.network_name),
        _healthCategory: text(x.healthCategory_name),
        _city: text(x.city_name || x.township_name),
        _inspectedAt: x.proInspectedAt || null,
        _compliant: !!x.compliance
      };
      ins.run('tashkilat', unitForFacility(x), JSON.stringify(data), now, now);
      result.facilities++;
    }

    // فهرست نمایشی کارشناسان (بدون کد ملی) — منبع پایدار برای نمای کاربران
    const upsertExpert = db.prepare(`INSERT INTO imported_experts(source_id,full_name,nid_last4,phone,username,role,unit_id,source,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(source_id) DO UPDATE SET full_name=excluded.full_name,nid_last4=excluded.nid_last4,
        phone=excluded.phone,username=excluded.username,role=excluded.role,unit_id=excluded.unit_id`);
    for (const x of experts) {
      if (!text(x.full_name) || !text(x.source_id)) continue;
      upsertExpert.run(text(x.source_id), text(x.full_name), text(x.nid_last4), text(x.phone), text(x.username),
        text(x.role) || 'expert_ohs', +x.unit_id || COUNTY_ID, text(x.source) || 'imported', Date.now());
      result.experts++;
    }

    const insAllow = db.prepare(`INSERT OR IGNORE INTO allow(nid_hash,nid_enc,nid_last4,unit_id,role,note,created_by,created_at,used)
      VALUES(?,?,?,?,?,?,NULL,?,0)`);
    const noteAllow = db.prepare('UPDATE allow SET note=? WHERE nid_hash=?');
    const hasNid = (table, hash) => !!db.prepare(`SELECT 1 FROM ${table} WHERE nid_hash=?`).get(hash);
    for (const x of users) {
      const nid = text(x.nationalId).replace(/\D/g, '');
      if (!L.validNid(nid) || hasNid('users', L.hmac(nid))) { result.skippedUsers++; continue; }
      const name = `${text(x.firstName)} ${text(x.lastName)}`.trim();
      const note = `${name || 'کارشناس واردشده'} — وارد شده از فهرست رسمی`.trim();
      const hash = L.hmac(nid);
      const changes = insAllow.run(hash, L.enc(nid), nid.slice(-4), COUNTY_ID, roleForUser(x), note, Date.now()).changes;
      result.users += changes;
      result.notedUsers += noteAllow.run(note, hash).changes;
    }

    audit(null, 'network_data_import', { ...result, facilitiesFile: path.basename(FACILITIES_FILE) }, 'import');
  });

  console.log('دادههای شبکه وارد شد:', JSON.stringify(result));
  console.log('کل کارگاهها در جدول تشکیلات:', db.prepare("SELECT COUNT(*) n FROM records WHERE table_key='tashkilat'").get().n);
}

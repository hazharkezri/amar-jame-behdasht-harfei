'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');
const { sha } = require('./lib');
const file = process.env.DB_FILE || path.join(__dirname, 'data', 'app.db');
fs.mkdirSync(path.dirname(file), { recursive: true });
const db = new DatabaseSync(file);
db.exec(`
PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS units(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES units(id), type TEXT NOT NULL, name TEXT NOT NULL, UNIQUE(parent_id,name));
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, nid_hash TEXT UNIQUE NOT NULL, nid_enc TEXT NOT NULL, nid_last4 TEXT NOT NULL,
  full_name TEXT NOT NULL, phone TEXT, email TEXT NOT NULL, unit_id INTEGER NOT NULL REFERENCES units(id), role TEXT NOT NULL CHECK(role IN('expert_ohs','behvarz','expert_ehs','responsible_ohs','manager_ohs')),
  pw_hash TEXT NOT NULL, totp_enc TEXT NOT NULL, totp_ok INTEGER DEFAULT 0, totp_last INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','active','rejected','suspended')),
  fails INTEGER DEFAULT 0, locked_until INTEGER DEFAULT 0, approved_by INTEGER, created_at INTEGER, last_login INTEGER);
CREATE TABLE IF NOT EXISTS allow(id INTEGER PRIMARY KEY, nid_hash TEXT UNIQUE NOT NULL, nid_enc TEXT NOT NULL, nid_last4 TEXT NOT NULL, unit_id INTEGER NOT NULL REFERENCES units(id),
  role TEXT NOT NULL CHECK(role IN('expert_ohs','behvarz','expert_ehs','responsible_ohs','manager_ohs')), note TEXT, created_by INTEGER, created_at INTEGER, used INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, csrf TEXT NOT NULL, created INTEGER, last INTEGER, ip TEXT);
CREATE TABLE IF NOT EXISTS periods(id INTEGER PRIMARY KEY, label TEXT UNIQUE NOT NULL, status TEXT NOT NULL DEFAULT 'open' CHECK(status IN('open','closed')));
CREATE TABLE IF NOT EXISTS entries(period_id INTEGER, unit_id INTEGER, ind_id TEXT, value TEXT, updated_by INTEGER, updated_at INTEGER, PRIMARY KEY(period_id,unit_id,ind_id));
CREATE TABLE IF NOT EXISTS entry_history(id INTEGER PRIMARY KEY, period_id INTEGER, unit_id INTEGER, ind_id TEXT, old TEXT, new TEXT, by_user INTEGER, ts INTEGER);
CREATE INDEX IF NOT EXISTS ix_eh ON entry_history(period_id,unit_id,ind_id);
CREATE TABLE IF NOT EXISTS submissions(period_id INTEGER, unit_id INTEGER, status TEXT NOT NULL CHECK(status IN('draft','submitted','approved','returned')),
  submitted_by INTEGER, submitted_at INTEGER, decided_by INTEGER, decided_at INTEGER, note TEXT, PRIMARY KEY(period_id,unit_id));
CREATE TABLE IF NOT EXISTS form_off(unit_type TEXT NOT NULL, sub_key TEXT NOT NULL, PRIMARY KEY(unit_type,sub_key));
CREATE TABLE IF NOT EXISTS records(id INTEGER PRIMARY KEY, table_key TEXT NOT NULL, unit_id INTEGER NOT NULL REFERENCES units(id), data TEXT NOT NULL,
  created_by INTEGER, updated_by INTEGER, created_at INTEGER, updated_at INTEGER);
CREATE INDEX IF NOT EXISTS ix_rec ON records(table_key,unit_id);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, ts INTEGER, user_id INTEGER, action TEXT, detail TEXT, ip TEXT, prev TEXT, hash TEXT);
`);
function audit(userId, action, detail, ip) {
  const last = db.prepare('SELECT hash FROM audit ORDER BY id DESC LIMIT 1').get();
  const prev = last ? last.hash : 'GENESIS', ts = Date.now(), d = JSON.stringify(detail || {});
  db.prepare('INSERT INTO audit(ts,user_id,action,detail,ip,prev,hash) VALUES(?,?,?,?,?,?,?)')
    .run(ts, userId || null, action, d, ip || '', prev, sha(prev + '|' + ts + '|' + (userId || '') + '|' + action + '|' + d));
}
function verifyAudit() {
  let prev = 'GENESIS';
  for (const r of db.prepare('SELECT * FROM audit ORDER BY id').all()) {
    if (r.prev !== prev || r.hash !== sha(prev + '|' + r.ts + '|' + (r.user_id || '') + '|' + r.action + '|' + r.detail)) return { ok: false, at: r.id };
    prev = r.hash;
  }
  return { ok: true };
}
const _sub = new Map();
function subtreeIds(unitId) {
  const k = unitId + ':' + (db.prepare('SELECT COUNT(*) n FROM units').get().n);
  if (_sub.has(k)) return _sub.get(k);
  const ids = db.prepare(`WITH RECURSIVE t(id) AS (SELECT ?1 UNION ALL SELECT u.id FROM units u JOIN t ON u.parent_id=t.id) SELECT id FROM t`).all(unitId).map(r => r.id);
  if (_sub.size > 500) _sub.clear(); _sub.set(k, ids); return ids;
}
const inList = (ids) => ids.map(() => '?').join(',');
const tx = (fn) => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
// مهاجرت: افزودن ستون‌های کد یک‌بارمصرف (OTP) برای ورود پیامکی
try { db.exec('ALTER TABLE users ADD COLUMN otp_code TEXT'); } catch (e) {}
try { db.exec('ALTER TABLE users ADD COLUMN otp_expires INTEGER'); } catch (e) {}
module.exports = { db, audit, verifyAudit, subtreeIds, inList, tx };

'use strict';
const crypto = require('node:crypto');
const SECRET = process.env.APP_SECRET || '';
if (SECRET.length < 32 && process.env.ALLOW_DEV_SECRET !== '1') {
  console.error('APP_SECRET (حداقل ۳۲ کاراکتر تصادفی) تنظیم نشده است. راهنما: README-fa.md'); process.exit(1);
}
const root = SECRET || 'dev-only-secret-dev-only-secret-0000';
const key = (label) => Buffer.from(crypto.hkdfSync('sha256', root, 'amar-salt', label, 32));
const K_HMAC = key('hmac'), K_ENC = key('enc');

const hmac = (s) => crypto.createHmac('sha256', K_HMAC).update(String(s)).digest('hex');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
function enc(plain) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', K_ENC, iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
function dec(b64) {
  const b = Buffer.from(b64, 'base64'), d = crypto.createDecipheriv('aes-256-gcm', K_ENC, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
function hashPw(pw) {
  const salt = crypto.randomBytes(16);
  return 's1$' + salt.toString('hex') + '$' + crypto.scryptSync(pw, salt, 64, SCRYPT).toString('hex');
}
function checkPw(pw, stored) {
  const [v, s, h] = stored.split('$');
  if (v !== 's1') return false;
  return crypto.timingSafeEqual(crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64, SCRYPT), Buffer.from(h, 'hex'));
}
const faDigits = (s) => String(s == null ? '' : s).replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
// ---- کد ملی (الگوریتم رسمی صحت کد ملی)
function validNid(n) {
  n = faDigits(n).trim();
  if (!/^\d{10}$/.test(n) || /^(\d)\1{9}$/.test(n)) return null;
  let s = 0; for (let i = 0; i < 9; i++) s += (+n[i]) * (10 - i);
  const r = s % 11, c = +n[9];
  return ((r < 2 && c === r) || (r >= 2 && c === 11 - r)) ? n : null;
}
// ---- TOTP (RFC 6238)
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32enc(buf) { let bits = '', out = ''; for (const b of buf) bits += b.toString(2).padStart(8, '0');
  for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)]; return out; }
function b32dec(s) { let bits = ''; for (const ch of s) bits += B32.indexOf(ch).toString(2).padStart(5, '0');
  const out = []; for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(out); }
function totpAt(secret, step) {
  const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', b32dec(secret)).update(b).digest(); const o = h[19] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1000000)).padStart(6, '0');
}
function totpVerify(secret, code, lastStep) {
  const now = Math.floor(Date.now() / 30000), c = faDigits(code).trim();
  if (!/^\d{6}$/.test(c)) return null;
  for (const d of [0, -1, 1]) { const st = now + d;
    if (st > (lastStep || 0) && crypto.timingSafeEqual(Buffer.from(totpAt(secret, st)), Buffer.from(c))) return st; }
  return null;
}
const newTotpSecret = () => b32enc(crypto.randomBytes(20));
// نام‌ها: یکسان‌سازی ی/ک عربی و فاصله‌ها برای تطبیق نام واحدها
const norm = (s) => String(s == null ? '' : s).replace(/ي/g, 'ی').replace(/ك/g, 'ک').replace(/ى/g, 'ی').replace(/[‌ ]/g, ' ').replace(/\s+/g, ' ').trim();
module.exports = { hmac, sha, enc, dec, hashPw, checkPw, validNid, totpVerify, newTotpSecret, totpAt, norm, faDigits };

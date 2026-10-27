'use strict';
// خواندن و نوشتن xlsx بدون هیچ وابستگی خارجی (فقط zlib داخلی Node)
const zlib = require('node:zlib');
const col = (n) => { let s = ''; for (n++; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
const colIdx = (s) => { let n = 0; for (const ch of s) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
const esc = (s) => String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&amp;/g, '&');

function zipWrite(files) {
  const chunks = [], central = []; let off = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8'), data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const comp = zlib.deflateRawSync(data), crc = zlib.crc32(data) >>> 0;
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8); lh.writeUInt16LE(0x21, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26);
    chunks.push(lh, name, comp);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10); ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
    central.push(ch, name); off += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...chunks, cd, end]);
}
function zipRead(buf, limit = 80 * 1024 * 1024) {
  let e = buf.length - 22; while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error('فایل xlsx معتبر نیست.');
  const n = buf.readUInt16LE(e + 10); let p = buf.readUInt32LE(e + 16); const out = {}; let total = 0;
  for (let i = 0; i < n; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('فایل xlsx معتبر نیست.');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), lo = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nl).toString('utf8'); p += 46 + nl + el + cl;
    if (!/^(xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml))$/.test(name)) continue;
    const ds = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28), raw = buf.subarray(ds, ds + csize);
    const data = method === 0 ? raw : zlib.inflateRawSync(raw, { maxOutputLength: limit });
    total += data.length; if (total > limit) throw new Error('فایل بیش از حد بزرگ است.');
    out[name] = data.toString('utf8');
  }
  return out;
}
// sheets: [{name, rows:[[v,...]], widths?:[n], rtl?:true, header?:n(تعداد ردیف‌های سرستون), freeze?:{row,col}, titleRow?:true}]
function build(sheets) {
  const files = [];
  files.push({ name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>` });
  files.push({ name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' });
  files.push({ name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView rtl="1"/></bookViews><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name.replace(/[\[\]:*?/\\]/g, ' ').slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>` });
  files.push({ name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` });
  files.push({ name: 'xl/styles.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="3"><font><sz val="10"/><name val="Tahoma"/></font><font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Tahoma"/></font><font><b/><sz val="13"/><name val="Tahoma"/></font></fonts><fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F6F7D"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFD6ECF0"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="5"><xf fontId="0" fillId="0" applyFont="1"/><xf fontId="1" fillId="2" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1" readingOrder="2"/></xf><xf fontId="2" applyFont="1"/><xf fontId="0" applyAlignment="1" applyFont="1"><alignment vertical="center" wrapText="1" readingOrder="2"/></xf><xf fontId="0" fillId="3" applyFill="1" applyFont="1" applyAlignment="1"><alignment vertical="center" readingOrder="2"/></xf></cellXfs></styleSheet>' });
  sheets.forEach((s, i) => {
    const rows = s.rows, hdr = s.header || 1; let x = '';
    rows.forEach((r, ri) => {
      let cells = ''; const style = r && r.__style;
      (r || []).forEach((v, ci) => {
        if (v === null || v === undefined || v === '') return;
        const ref = col(ci) + (ri + 1), st = ri < hdr && s.headStyle !== false ? 1 : (style || (ci === 1 && s.wrapB ? 3 : 0));
        cells += (typeof v === 'number' && isFinite(v)) ? `<c r="${ref}" s="${st}"><v>${v}</v></c>` : `<c r="${ref}" t="inlineStr" s="${st}"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
      });
      x += `<row r="${ri + 1}"${s.rowHeights && s.rowHeights[ri] ? ` ht="${s.rowHeights[ri]}" customHeight="1"` : ''}>${cells}</row>`;
    });
    const fz = s.freeze ? `<pane ${s.freeze.col ? `xSplit="${s.freeze.col}" ` : ''}${s.freeze.row ? `ySplit="${s.freeze.row}" ` : ''}topLeftCell="${col(s.freeze.col || 0)}${(s.freeze.row || 0) + 1}" activePane="bottomRight" state="frozen"/>` : '';
    const cols = s.widths ? `<cols>${s.widths.map((w, k) => `<col min="${k + 1}" max="${k + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '';
    files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView ${s.rtl === false ? '' : 'rightToLeft="1" '}workbookViewId="0">${fz}</sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${x}</sheetData></worksheet>` });
  });
  return zipWrite(files);
}
function read(buf) {
  const z = zipRead(buf);
  if (!z['xl/workbook.xml']) throw new Error('فایل xlsx معتبر نیست.');
  const ss = [];
  if (z['xl/sharedStrings.xml']) for (const m of z['xl/sharedStrings.xml'].matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) ss.push(unesc([...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join('')));
  const rels = {}; for (const m of (z['xl/_rels/workbook.xml.rels'] || '').matchAll(/<Relationship\b[^>]*>/g)) { const id = /Id="([^"]+)"/.exec(m[0]), tg = /Target="([^"]+)"/.exec(m[0]); if (id && tg) rels[id[1]] = tg[1]; }
  const out = [];
  for (const m of z['xl/workbook.xml'].matchAll(/<sheet\b[^>]*>/g)) {
    const nm = /name="([^"]*)"/.exec(m[0]), rid = /r:id="([^"]+)"/.exec(m[0]); if (!nm || !rid) continue;
    let t = rels[rid[1]] || ''; t = t.replace(/^\/?(xl\/)?/, 'xl/'); const xml = z[t]; if (!xml) continue;
    const rows = [];
    for (const c of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = /r="([A-Z]+)(\d+)"/.exec(c[1]); if (!ref || c[2] === undefined) continue;
      const ty = (/\bt="([^"]+)"/.exec(c[1]) || [])[1]; let v;
      if (ty === 'inlineStr') v = unesc([...c[2].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(x => x[1]).join(''));
      else { const vv = /<v>([\s\S]*?)<\/v>/.exec(c[2]); if (!vv) continue; v = ty === 's' ? ss[+vv[1]] : ty === 'str' ? unesc(vv[1]) : ty === 'b' ? vv[1] === '1' : ty === 'e' ? null : Number(vv[1]); }
      if (v === undefined || v === null || v === '') continue;
      const r = +ref[2], ci = colIdx(ref[1]); (rows[r] = rows[r] || [])[ci] = v;
    }
    out.push({ name: unesc(nm[1]), rows });
  }
  return out;
}
module.exports = { build, read, col, colIdx, zipRead };

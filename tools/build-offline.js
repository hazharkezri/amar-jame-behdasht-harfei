'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cat = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'indicators.json'), 'utf8'));
const data = JSON.stringify(cat);
const html = `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ورود آفلاین آمار بهداشت حرفه‌ای</title>
<style>
body{font-family:Tahoma,Arial,sans-serif;margin:0;background:#f4f6f9;color:#17302c}
header{background:#0f6bff;color:#fff;padding:12px 16px;position:sticky;top:0;z-index:5}
main{padding:16px;max-width:1100px;margin:0 auto}
.card{background:#fff;border-radius:10px;padding:12px 14px;margin-bottom:12px;box-shadow:0 1px 3px #0001}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.pill{padding:6px 10px;border-radius:20px;border:1px solid #d5dde6;background:#fff;cursor:pointer;margin:2px}
.pill.on{background:#0f6bff;color:#fff;border-color:#0f6bff}
.ind{display:grid;grid-template-columns:1fr 160px;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid #eef2f7}
.ind .t{font-size:13px}
.ind input{padding:6px;border:1px solid #cfd8e3;border-radius:6px;width:100%;box-sizing:border-box}
button.b{background:#0f6bff;color:#fff;border:0;padding:8px 14px;border-radius:8px;cursor:pointer}
button.sec{background:#e5eaf2;color:#17302c}
select,input[type=text]{padding:6px;border:1px solid #cfd8e3;border-radius:6px}
.mut{color:#5d7570;font-size:12px}
.warn{background:#fff7e6;border:1px solid #f0c36d;padding:8px;border-radius:8px;margin:8px 0}
.ok{background:#e8f5f1;border:1px solid #0f8a79;padding:8px;border-radius:8px;margin:8px 0}
</style>
</head>
<body>
<header><b>ورود آفلاین آمار بهداشت حرفه‌ای</b> — داده‌ها در مرورگر ذخیره می‌شود؛ خروجی CSV/JSON برای بارگذاری در سامانه.</header>
<main>
<div class="card">
  <div class="row">
    <label>واحد: <input id="unit" type="text" value="واحد نمونه"></label>
    <label>دوره: <input id="period" type="text" value="۱۴۰۵"></label>
    <button class="b" id="saveAll">ذخیره در مرورگر</button>
    <button class="b sec" id="exportCsv">خروجی CSV</button>
    <button class="b sec" id="exportJson">خروجی JSON</button>
    <input type="file" id="imp" accept=".csv,.json">
    <button class="b sec" id="importBtn">درون‌ریزی</button>
  </div>
  <div id="status" class="mut"></div>
</div>
<div class="card" id="pills"></div>
<div class="card" id="body"></div>
</main>
<script>
const CAT = ${data};
const IND = Object.fromEntries(CAT.indicators.map(i=>[i.id,i]));
const BLOCKS=[]; let b=null,sub=null;
for(const it of CAT.layout){ if(it.t==='sec'){b={blk:it.blk,title:it.title,subs:[]};BLOCKS.push(b);sub=null;}
 else if(it.t==='sub'){sub={key:it.key,title:it.title,inds:[]};b.subs.push(sub);}
 else{ if(!sub){sub={key:b.blk+'|',title:'عمومی',inds:[]};b.subs.push(sub);} sub.inds.push(it.id);} }
const storageKey=()=> 'offline.amar.'+ (document.getElementById('unit').value||'x');
let V={};
function loadV(){ try{ V=JSON.parse(localStorage.getItem(storageKey())||'{}'); }catch(e){V={};} }
function saveV(){ localStorage.setItem(storageKey(), JSON.stringify(V)); document.getElementById('status').textContent='ذخیره شد ('+Object.keys(V).length+' مقدار)'; }
const fa=n=>String(n??'').replace(/\\d/g,d=>'۰۱۲۳۴۵۶۷۸۹'[d]);
let blk = BLOCKS[0].blk;
function pills(){ const p=document.getElementById('pills'); p.innerHTML=''; for(const b of BLOCKS){ const nums=b.subs.flatMap(s=>s.inds).filter(i=>IND[i].kind==='num'); const done=nums.filter(i=>V[i]!==undefined&&V[i]!=='').length; const btn=document.createElement('button'); btn.className='pill'+(b.blk===blk?' on':''); btn.textContent=b.title.replace(/^بخش\\s*\\S+\\s*—\\s*/,'')+' ('+fa(done)+'/'+fa(nums.length)+')'; btn.onclick=()=>{blk=b.blk; pills(); body();}; p.appendChild(btn);} }
function body(){ const b=BLOCKS.find(x=>x.blk===blk); const el=document.getElementById('body'); el.innerHTML='<h2>'+b.title+'</h2>'; for(const sub of b.subs){ const nums=sub.inds.filter(i=>IND[i].kind==='num'); const d=document.createElement('details'); d.className='sub'; d.open=true; const sm=document.createElement('summary'); sm.textContent=sub.title+' — '+nums.filter(i=>V[i]!==undefined&&V[i]!=='').length+'/'+nums.length; d.appendChild(sm); for(const id of sub.inds){ const I=IND[id]; if(I.kind!=='num') continue; const row=document.createElement('div'); row.className='ind'; const t=document.createElement('div'); t.className='t'; t.textContent=I.title+' ('+id+')'; const inp=document.createElement('input'); inp.value=V[id]??''; inp.inputMode='decimal'; inp.addEventListener('input',()=>{V[id]=inp.value;}); row.appendChild(t); row.appendChild(inp); d.appendChild(row);} el.appendChild(d);} }
document.getElementById('saveAll').onclick=saveV;
document.getElementById('unit').addEventListener('change',()=>{loadV();pills();body();});
document.getElementById('period').addEventListener('change',()=>{});
document.getElementById('exportCsv').onclick=()=>{
  const rows=[['کد شاخص','عنوان',document.getElementById('unit').value]]; 
  for(const it of CAT.indicators){ if(it.kind!=='num') continue; rows.push([it.id, IND[it.id].title, V[it.id]??'']); }
  const csv=rows.map(r=>r.map(x=>'"'+String(x).replace(/"/g,'""')+'"').join(',')).join('\\n');
  const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'})); a.download='amar-offline.csv'; a.click();
};
document.getElementById('exportJson').onclick=()=>{
  const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([JSON.stringify({unit:document.getElementById('unit').value,period:document.getElementById('period').value,values:V},null,2)],{type:'application/json'})); a.download='amar-offline.json'; a.click();
};
document.getElementById('importBtn').onclick=()=>{
  const f=document.getElementById('imp').files[0]; if(!f) return;
  const r=new FileReader(); r.onload=()=>{
    try{ const j=JSON.parse(r.result); if(j.values){ V=j.values; saveV(); pills(); body(); alert('وارد شد'); } }
    catch(e){ alert('خطا در خواندن فایل'); }
  }; r.readAsText(f);
};
loadV(); pills(); body();
</script>
</body>
</html>`;
fs.writeFileSync(path.join(__dirname, '..', 'public', 'offline-entry.html'), html);
console.log('written', html.length, 'bytes');
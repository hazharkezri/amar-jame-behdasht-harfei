# تست استقرار روی همین سیستم (شبیه‌سازی سرور داخل شبکه‌ی دانشگاه)
# اجرا:  powershell -ExecutionPolicy Bypass -File deploy\test-local.ps1
# چیزی را حذف یا تغییر نمی‌دهد؛ فقط تست می‌کند و گزارش می‌دهد.

$ErrorActionPreference = 'Stop'
# خروجی فارسی درجستجوی کنسول ویندوز
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; chcp 65001 | Out-Null } catch { }
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$pass = 0; $fail = 0
function OK($m)   { Write-Host "  [درست]   $m" -ForegroundColor Green;    $script:pass++ }
function BAD($m)  { Write-Host "  [خطا]    $m" -ForegroundColor Red;      $script:fail++ }
function INFO($m) { Write-Host "  [info]   $m" -ForegroundColor DarkGray }

Write-Host ""
Write-Host "=== ۱) پیش‌نیازها ===" -ForegroundColor Cyan
$node = (node -v)
$v = [int](($node -replace '[^0-9]','').Substring(0,2))
if ($v -ge 22) { OK "Node $node (حداقل ۲۲ لازم است)" } else { BAD "Node $node خیلی قدیمی است" }

Write-Host ""
Write-Host "=== ۲) تست کامل منطق (smoke) ===" -ForegroundColor Cyan
try { $t = npm test 2>&1 | Out-String
  if ($t -match 'ALL SMOKE TESTS PASSED') { OK "همه تست‌ها پاس شدند" } else { BAD "تست‌ها رد شدند"; INFO $t }
} catch { BAD "اجرای npm test شکست خورد" }

Write-Host ""
Write-Host "=== ۳) بکاپ دیتابیس ===" -ForegroundColor Cyan
try { $b = node deploy/backup.js 2>&1 | Out-String
  $bk = Get-ChildItem (Join-Path $root 'data\backup') -Filter 'app-*.db' -ErrorAction SilentlyContinue
  if ($bk) { OK ("بکاپ ساخته شد: " + $bk[-1].Name + " (" + $bk[-1].Length + " بایت)") } else { BAD "فایل بکاپ ساخته نشد"; INFO $b }
} catch { BAD "اجرای بکاپ شکست خورد" }

Write-Host ""
Write-Host "=== ۴) اجرای سامانه مثل سرور داخل شبکه (HOST=0.0.0.0) ===" -ForegroundColor Cyan
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1

$env:APP_SECRET = 'local-test-' + ('0123456789abcdef' * 4)
$env:PORT = '3000'
$env:HOST = '0.0.0.0'
$env:COOKIE_SECURE = '0'
$env:TRUST_PROXY = '0'
# ایمنی: تست هرگز به دیتابیس واقعی دست نمی‌زند (APP_SECRET آزمایشی با کلید رمزگذاری واقعی فرق دارد)
$tmpDb = Join-Path $env:TEMP ("amar-testdb-" + [guid]::NewGuid().ToString('N') + '.db')
$env:DB_FILE = $tmpDb
Start-Process -FilePath node -ArgumentList '--no-warnings','server.js' -NoNewWindow -RedirectStandardOutput "$env:TEMP\amar-test.log" -RedirectStandardError "$env:TEMP\amar-test.err"
Start-Sleep -Seconds 3

function Try-Url($url, $mustContain) {
  try {
    $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 8
    if ($r.StatusCode -eq 200) {
      if ($mustContain -and ($r.Content -notlike "*$mustContain*")) { BAD "$url پاسخ ۲۰۰ داد ولی محتوای درست نیست"; return }
      OK "$url → ۲۰۰"
    } else { BAD "$url → کد $($r.StatusCode)" }
  } catch { BAD "$url → خطا: $($_.Exception.Message)" }
}

Try-Url 'http://127.0.0.1:3000/api/health' $null
Try-Url 'http://127.0.0.1:3000/' 'سامانه'

$lans = Get-NetIPAddress -AddressFamily IPv4 |
        Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.IPAddress -notlike '172.1[6-9].*' -and $_.IPAddress -notlike '172.2[0-9].*' -and $_.IPAddress -notlike '172.3[0-1].*' -and $_.IPAddress -notlike '100.*' -and $_.IPAddress -notlike '192.168.*' -and $_.IPAddress -notlike '10.*' } |
        Select-Object -ExpandProperty IPAddress
# آدرس‌های داخلی معمول شبکه‌ی دانشگاه (۱۹۲.۱۶۸ و ۱۰) اول آزموده می‌شوند
$prefer = @(Get-NetIPAddress -AddressFamily IPv4 |
            Where-Object { $_.IPAddress -like '192.168.*' -or $_.IPAddress -like '10.*' -or $_.IPAddress -like '172.1[6-9].*' -or $_.IPAddress -like '172.2[0-9].*' -or $_.IPAddress -like '172.3[0-1].*' } |
            Select-Object -ExpandProperty IPAddress)
$all = @($prefer) + @($lans) | Select-Object -Unique
if ($all) {
  foreach ($lan in $all) {
    INFO "آیپی شبکه: $lan"
    Try-Url "http://$lan`:3000/api/health" $null
    Try-Url "http://$lan`:3000/" 'سامانه'
  }
} else { INFO "آیپی LAN پیدا نشد (آفلاین؟) — تست شبکه رد شد" }

Write-Host ""
Write-Host "=== ۵) سردرگمی‌های شناخته‌شده ===" -ForegroundColor Cyan
try {
  $env:COOKIE_SECURE = '0'
  $h = Invoke-WebRequest -Uri 'http://127.0.0.1:3000/' -UseBasicParsing -TimeoutSec 8
  if ($h.Headers['Content-Security-Policy']) { OK "هدر CSP روی HTTP هم ارسال می‌شود" } else { BAD "هدر CSP نیست" }
  $sw = Invoke-WebRequest -Uri 'http://127.0.0.1:3000/sw.js' -UseBasicParsing -TimeoutSec 8
  if ($sw.StatusCode -eq 200) { OK "فایل Service Worker سرو می‌شود (ولی روی HTTP مرورگر آن را ثبت نمی‌کند — طبیعی است)" }
} catch { BAD "بررسی هدرها شکست خورد" }

Write-Host ""
Write-Host "=== ۶) توقف سرور تست ===" -ForegroundColor Cyan
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
OK "سرور تست متوقف شد"
if ($tmpDb -and (Test-Path $tmpDb)) { Remove-Item $tmpDb -Force -ErrorAction SilentlyContinue }
foreach ($side in @('-wal','-shm')) { if ($tmpDb -and (Test-Path ($tmpDb + $side))) { Remove-Item ($tmpDb + $side) -Force -ErrorAction SilentlyContinue } }
Remove-Item Env:\DB_FILE -ErrorAction SilentlyContinue
INFO "دیتابیس موقت تست حذف شد؛ دیتابیس واقعی دست‌نخورده ماند"

Write-Host ""
Write-Host "------------------------------------------------" -ForegroundColor Cyan
Write-Host "  نتیجه: $pass درست / $fail خطا" -ForegroundColor $(if ($fail -eq 0) { 'Green' } else { 'Yellow' })
if ($fail -eq 0) {
  Write-Host "  استقرار آماده است. برای اجرای واقعی:" -ForegroundColor Green
  Write-Host "    1. فایل .env را با APP_SECRET واقعی تنظیم کنید" -ForegroundColor White
  Write-Host "    2. راهنما: deploy\INSTALL-intranet-fa.md" -ForegroundColor White
} else {
  Write-Host "  قبل از استقرار، خطاهای بالا را برطرف کنید." -ForegroundColor Yellow
}
Write-Host "------------------------------------------------" -ForegroundColor Cyan
Write-Host ""

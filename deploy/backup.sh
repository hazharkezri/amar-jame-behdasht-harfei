#!/bin/sh
# پشتیبان‌گیری روزانه (cron: 0 2 * * * /path/deploy/backup.sh). نسخه‌ها را روی دیسک/سرور دیگر هم کپی کنید.
set -e
D="$(dirname "$0")/../data"; B="$D/backup"; mkdir -p "$B"
node --no-warnings -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('$D/app.db');d.exec(\"VACUUM INTO '$B/app-$(date +%F).db'\")"
find "$B" -name 'app-*.db' -mtime +30 -delete

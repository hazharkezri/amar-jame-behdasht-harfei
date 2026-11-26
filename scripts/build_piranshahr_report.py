#!/usr/bin/env python3
"""Build a polished Persian PDF performance report for Piranshahr OHS from imported OLAP data."""

from __future__ import annotations

import json
import math
import os
import re
import sys
from collections import defaultdict
from pathlib import Path

import arabic_reshaper
from bidi.algorithm import get_display
from reportlab.lib.colors import Color, HexColor
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
SNAPSHOT = DATA / "ohs-snapshot-1405.json"
SCHEMA_FILE = DATA / "ohs-schema.json"
NETWORK_FILE = DATA / "network-piranshahr.json"
EXPERTS_FILE = DATA / "experts-piranshahr.json"
OUT = ROOT / "reports" / "piranshahr-ohs-performance-1405.pdf"

PAGE_W, PAGE_H = 595.28, 841.89
MARGIN = 42
RIGHT = PAGE_W - MARGIN

DIGITS = str.maketrans("0123456789", "۰۱۲۳۴۵۶۷۸۹")

C_DARK = HexColor("#0B3D4A")
C_PRIMARY = HexColor("#0F6E7F")
C_TEAL = HexColor("#1B8C9B")
C_GREEN = HexColor("#2E9E7B")
C_AMBER = HexColor("#E6A23C")
C_RED = HexColor("#D9534F")
C_PURPLE = HexColor("#7E57C2")
C_TEXT = HexColor("#203040")
C_MUTED = HexColor("#6B7B8A")
C_BG = HexColor("#F4F7F9")
C_LINE = HexColor("#D8E1E6")
C_WHITE = HexColor("#FFFFFF")
C_LIGHT_TEAL = HexColor("#E6F3F5")
C_LIGHT_GREEN = HexColor("#E8F6F0")
C_LIGHT_AMBER = HexColor("#FDF3E3")
C_LIGHT_RED = HexColor("#FCECEA")


def pdigit(value) -> str:
    return str(value).translate(DIGITS)


def fa(value) -> str:
    text = pdigit(value if value is not None else "")
    return get_display(arabic_reshaper.reshape(text))


def fmt(value, digits: int = 1) -> str:
    if value is None or value == "":
        return "—"
    if isinstance(value, bool):
        return "بله" if value else "خیر"
    if isinstance(value, (int, float)):
        if isinstance(value, float) and math.isnan(value):
            return "—"
        if abs(value - round(value)) < 1e-9:
            return pdigit(f"{int(round(value)):,}")
        return pdigit(f"{value:,.{digits}f}")
    return pdigit(value)


def norm_name(name: str) -> str:
    s = str(name or "")
    for a, b in (("آ", "ا"), ("أ", "ا"), ("إ", "ا"), ("ي", "ی"), ("ئ", "ی"), ("ة", "ه"), ("ؤ", "و")):
        s = s.replace(a, b)
    return re.sub(r"\s+", "", s)


# کارشناسانی که طرح همکاریشان پایان یافته و از شهرستان خارج شده­اند؛
# از جداول و نمودارهای گزارش حذف می­شوند.
DEPARTED_EXPERTS = {
    norm_name(name)
    for name in (
        "سمیه عبدالله نژاد",
        "فائزه نسرين فر",
        "پروانه عيسي زاده",
        "آمنه محمداميني",
    )
}


def short_title(title: str) -> str:
    s = str(title or "")
    for old, new in (
        ("درصد شاغلین استفاده کننده از وسایل حفاظت فردی ", "وسایل حفاظت فردی "),
        ("درصد شاغلین در مواجهه با ", ""),
        ("درصد شاغلین دارای ", ""),
        ("درصد شاغلین ", ""),
        ("درصد کارگاههایی که ", ""),
        ("درصد کارگاه های دارای ", ""),
        ("درصد کارگاههای دارای ", ""),
        ("درصد کارگاه/امکنه ", ""),
        ("درصد کارگاهها و امکنه ", ""),
        ("درصد ", ""),
        ("تعداد ", ""),
    ):
        s = s.replace(old, new)
    return s.strip() or str(title or "")


def fit(text: str, font: str, size: float, max_width: float) -> str:
    shaped = fa(text)
    if pdfmetrics.stringWidth(shaped, font, size) <= max_width:
        return text
    out = ""
    for ch in text:
        if pdfmetrics.stringWidth(fa(out + ch + "…"), font, size) > max_width:
            break
        out += ch
    return out + "…"


def status(item: dict) -> tuple[str, Color, Color]:
    if item.get("Ytitle") != "درصد":
        return "count", C_PRIMARY, C_LIGHT_TEAL
    raw = item.get("total")
    if raw is None or raw == "":
        return "na", C_MUTED, C_BG
    try:
        v = float(raw)
    except (TypeError, ValueError):
        return "na", C_MUTED, C_BG
    if v < 0 or v > 100:
        return "check", C_PURPLE, HexColor("#F1ECFA")
    if v >= 80:
        return "good", C_GREEN, C_LIGHT_GREEN
    if v >= 50:
        return "warn", C_AMBER, C_LIGHT_AMBER
    return "bad", C_RED, C_LIGHT_RED


CATEGORY = {
    "1": "بهداشت مواد غذایی و اماکن عمومی",
    "2": "بهداشت محیط واحدهای بهداشتی و درمانی",
    "3": "بهداشت آب و فاضلاب",
    "4": "دخانیات",
    "5": "بهداشت حرفه ای (کارگاه ها)",
    "6": "بهداشت حرفه ای (شاغلین)",
    "7": "نیروی انسانی و تجهیزات",
}
ITYPE = {
    "0": "گزارش ها",
    "1": "شاخص های ورودی",
    "2": "شاخص های فرایندی",
    "3": "شاخص های خروجی",
    "4": "شاخص های نتیجه ای",
}

ACTION = {
    "547": "تکمیل گواهی عدم دخانیات در کارگاه­های فاقد گواهی و ثبت آن در چک­لیست.",
    "602": "بروزرسانی فهرست بازرسان و سهمیه پوشش هر مرکز.",
    "603": "اجرای بازرسی­های هدفمند در مراکز با پوشش کمتر از میانگین شهرستان.",
    "604": "صدور و پیگیری اخطارهای بهداشتی در کارگاه­های دارای تخلف.",
    "605": "تکمیل پرونده­های ارجاعی به مراجع قضایی و ثبت نتیجه اقدام.",
    "606": "تشکیل و ثبت کمیته حفاظت فنی و بهداشت کار در کارگاه­ها.",
    "607": "انجام اندازه­گیری عوامل زیان­آور و بارگذاری نتایج در سامانه.",
    "608": "تکمیل معاینات شغلی شاغلین فاقد معاینه معتبر.",
    "609": "پوشش معاینات شاغلین مرد و رصد موارد معوقه.",
    "610": "پوشش معاینات شاغلین زن و رصد موارد معوقه.",
    "611": "برگزاری دوره­های آموزش بهداشت حرفه ای و ثبت حضور شرکت­کنندگان.",
    "623": "تکمیل شناسایی و تایید مشاغل سخت و زیان­آور گروه الف.",
    "624": "تکمیل شناسایی شاغلین مشاغل سخت و زیان­آور گروه الف.",
    "625": "ثبت موارد رفع صفت سخت و زیان­آوری.",
    "626": "تکمیل شناسایی و تایید مشاغل سخت و زیان­آور گروه ب.",
    "627": "تکمیل شناسایی شاغلین مشاغل سخت و زیان­آور گروه ب.",
    "628": "شناسایی و ثبت کارگاه­های دارای عوامل شیمیایی زیان­آور.",
    "630": "انجام اندازه­گیری سیلیس و ثبت نتایج در پرونده شاغلین.",
    "631": "انجام اندازه­گیری سرب و ثبت نتایج در پرونده شاغلین.",
    "632": "انجام اندازه­گیری جیوه و ثبت نتایج در پرونده شاغلین.",
    "633": "انجام اندازه­گیری صدا و اجرای برنامه حفاظت شنوایی.",
    "634": "انجام اندازه­گیری ارتعاش و ثبت نتایج.",
    "635": "اندازه­گیری روشنایی و اصلاح نقاط عدم انطباق.",
    "636": "اندازه­گیری گرما و رطوبت و اصلاح شرایط محیطی.",
    "637": "اندازه­گیری سرما و تامین وسایل حفاظتی.",
    "638": "ثبت و اندازه­گیری پرتوهای یونیزان.",
    "639": "ثبت و اندازه­گیری پرتوهای غیریونیزان.",
    "640": "بررسی ایستگاه­های کار و اصلاح وضعیت بدنی شاغلین.",
    "641": "بررسی حمل دستی بار و اصلاح روش­های جابه­جایی.",
    "642": "بررسی ابزار دستی و تعویض ابزار نامناسب.",
    "643": "شناسایی عوامل بیولوژیکی و ثبت اقدامات کنترلی.",
    "644": "تکمیل اقدامات کنترل عوامل شیمیایی.",
    "645": "تکمیل اقدامات کنترل صدا.",
    "646": "تکمیل اقدامات کنترل ارتعاش.",
    "647": "تکمیل اقدامات اصلاحی روشنایی.",
    "648": "تکمیل اقدامات کنترل گرما و رطوبت.",
    "649": "تکمیل اقدامات کنترل سرما.",
    "650": "تکمیل اقدامات کنترل پرتو یونیزان.",
    "651": "تکمیل اقدامات کنترل پرتو غیریونیزان.",
    "652": "تکمیل اقدامات اصلاحی وضعیت بدنی.",
    "653": "تکمیل اقدامات اصلاحی حمل بار.",
    "654": "تکمیل اقدامات اصلاحی ابزار دستی.",
    "655": "تکمیل اقدامات کنترل عوامل بیولوژیکی.",
    "656": "تکمیل پرونده­های کارگاه سالم و رفع نقاط عدم انطباق.",
    "657": "ثبت مواجهه شاغلین با عوامل شیمیایی.",
    "661": "ثبت مواجهه شاغلین با صدا.",
    "662": "ثبت مواجهه شاغلین با ارتعاش.",
    "663": "ثبت مواجهه شاغلین با گرما.",
    "664": "ثبت مواجهه شاغلین با سرما.",
    "665": "ثبت مواجهه شاغلین با پرتو یونیزان.",
    "666": "ثبت مواجهه شاغلین با پرتو غیریونیزان.",
    "667": "ثبت مواجهه شاغلین با روشنایی نامناسب.",
    "668": "ثبت مواجهه شاغلین با وضعیت بدنی نامناسب.",
    "669": "ثبت مواجهه شاغلین با حمل دستی بار.",
    "670": "ثبت مواجهه شاغلین با ابزار دستی نامناسب.",
    "671": "ثبت مواجهه شاغلین با عوامل بیولوژیکی.",
    "672": "توزیع و ثبت وسایل حفاظت فردی شیمیایی.",
    "673": "توزیع و ثبت وسایل حفاظت فردی صدا.",
    "674": "توزیع و ثبت وسایل حفاظت فردی ارتعاش.",
    "675": "توزیع و ثبت وسایل حفاظت فردی گرما.",
    "676": "توزیع و ثبت وسایل حفاظت فردی سرما.",
    "677": "توزیع و ثبت وسایل حفاظت فردی پرتو یونیزان.",
    "678": "توزیع و ثبت وسایل حفاظت فردی پرتو غیریونیزان.",
    "679": "توزیع و ثبت وسایل حفاظت فردی عوامل بیولوژیکی.",
    "680": "تکمیل ایستگاه­های بهگر در کارگاه­ها.",
    "681": "تکمیل خانه­های بهداشت کارگری.",
    "682": "تکمیل مراکز بهداشت کار.",
    "683": "تکمیل تشکیلات بهداشت حرفه ای کارگاه­ها.",
    "684": "پایش شاغلین دارای ریسک بالای بیماری­های شغلی.",
    "703": "حفظ روند بازرسی­ها و توزیع متوازن آن بین بازرسان.",
    "713": "کاهش زمان پاسخ­دهی به بازرسی­های مجدد.",
    "714": "تکمیل بازرسی­های اولیه در مراکز کم­برخوردار.",
    "721": "پیگیری بازرسانی که پس از اعلام نواقص اقدام نکرده­اند.",
    "723": "پیگیری بازرسی­های مجدد خارج از مهلت.",
    "725": "بروزرسانی فهرست شاغلین تحت پوشش.",
    "754": "تداوم بازرسی­های تشدید در کارگاه­های پرخطر.",
    "906": "کاهش فاصله زمانی بازرسی واحدها به کمتر از ۳ ماه.",
    "908": "کاهش فاصله زمانی بازرسی واحدها به ۳ تا ۶ ماه.",
    "910": "کاهش فاصله زمانی بازرسی واحدها به ۶ تا ۱۲ ماه.",
    "912": "پیگیری واحدهایی که بیش از ۱۲ ماه بازرسی نشده­اند.",
    "914": "تعیین تکلیف واحدهای فاقد بازرسی.",
}


def load_data():
    snap = json.loads(SNAPSHOT.read_text(encoding="utf-8"))
    schema = json.loads(SCHEMA_FILE.read_text(encoding="utf-8"))
    network = json.loads(NETWORK_FILE.read_text(encoding="utf-8"))
    experts = json.loads(EXPERTS_FILE.read_text(encoding="utf-8"))
    items = snap["items"]
    by_id = {str(x["id"]): x for x in items}
    centers = {}
    for n in network:
        name = str(n.get("name", ""))
        label = re.sub(r"\s*\(.*$", "", name).strip() or name
        centers[str(n["id"])] = {
            "name": label,
            "full": name,
            "type": n.get("type", ""),
            "level": n.get("level"),
        }
    phones = {}
    for e in experts:
        phones[norm_name(e.get("full_name"))] = {
            "phone": e.get("phone", ""),
            "username": e.get("username", ""),
        }
    meta = {str(x["id"]): x for x in schema.get("data", [])}
    return items, by_id, centers, phones, meta, snap


def centre_rows(items, by_id, centers):
    base = by_id.get("703", {}).get("centers", [])
    rows = []
    for c in base:
        cid = str(c["id"])
        info = centers.get(cid, {"name": c.get("name", cid), "full": c.get("name", cid), "type": ""})
        vals = []
        detail = {}
        for item in items:
            if item.get("Ytitle") != "درصد":
                continue
            match = next((x for x in item.get("centers", []) if str(x["id"]) == cid), None)
            if not match or match.get("value") in (None, ""):
                continue
            try:
                v = float(match["value"])
            except (TypeError, ValueError):
                continue
            d = float(match.get("ref2") or 0)
            if 0 <= v <= 100 and d >= 5:
                vals.append(v)
                detail[str(item["id"])] = v
        inspections = 0
        try:
            inspections = float(c.get("value") or 0)
        except (TypeError, ValueError):
            pass
        rows.append({
            "id": cid,
            "name": info["name"],
            "type": info["type"],
            "inspections": inspections,
            "score": sum(vals) / len(vals) if vals else 0,
            "n_indicators": len(vals),
            "detail": detail,
        })
    rows.sort(key=lambda r: r["score"], reverse=True)
    for i, r in enumerate(rows, 1):
        r["rank"] = i
    return rows


def expert_rows(by_id, phones):
    keys = ["703", "714", "713", "754"]
    titles = {k: by_id.get(k, {}).get("title", "") for k in keys}
    agg = {}
    for k in keys:
        for row in by_id.get(k, {}).get("inspectors", []):
            iid = str(row.get("id", ""))
            if not iid:
                continue
            a = agg.setdefault(iid, {"id": iid, "name": row.get("name", ""), "values": {}})
            try:
                a["values"][k] = float(row.get("value") or 0)
            except (TypeError, ValueError):
                a["values"][k] = 0.0
    total_all = sum(a["values"].get("703", 0) for a in agg.values()) or 1
    out = []
    for a in agg.values():
        if norm_name(a["name"]) in DEPARTED_EXPERTS:
            continue
        contact = phones.get(norm_name(a["name"]), {})
        out.append({
            "id": a["id"],
            "name": a["name"],
            "total": a["values"].get("703", 0),
            "initial": a["values"].get("714", 0),
            "revisit": a["values"].get("713", 0),
            "intensive": a["values"].get("754", 0),
            "share": 100 * a["values"].get("703", 0) / total_all,
            "phone": contact.get("phone", "—"),
            "username": contact.get("username", "—"),
        })
    out.sort(key=lambda r: r["total"], reverse=True)
    for i, r in enumerate(out, 1):
        r["rank"] = i
    return out, titles


def analysis(items, by_id):
    pct = []
    count = []
    anomalies = []
    for it in items:
        if it.get("Ytitle") == "درصد":
            st, _, _ = status(it)
            raw = it.get("total")
            try:
                v = float(raw) if raw not in (None, "") else None
            except (TypeError, ValueError):
                v = None
            if v is not None and (v < 0 or v > 100):
                anomalies.append(it)
            pct.append(it)
        else:
            count.append(it)
    valid = []
    for it in pct:
        raw = it.get("total")
        try:
            v = float(raw) if raw not in (None, "") else None
        except (TypeError, ValueError):
            v = None
        if v is not None and 0 <= v <= 100:
            valid.append(it)
    strengths = sorted(
        [x for x in valid if float(x.get("ref2Count") or 0) >= 10],
        key=lambda x: float(x["total"]),
        reverse=True,
    )[:8]
    weaknesses = sorted(
        [x for x in valid if float(x.get("ref2Count") or 0) >= 10],
        key=lambda x: float(x["total"]),
    )[:10]
    priorities = []
    for it in valid:
        v = float(it["total"])
        d = float(it.get("ref2Count") or 0)
        n = float(it.get("ref1Count") or 0)
        if d < 10 or v >= 100:
            continue
        gap = max(0.0, d - n)
        score = gap + (100 - v) * 0.5
        pr = "۱" if gap >= 500 else ("۲" if gap >= 100 else "۳")
        priorities.append({
            "id": str(it["id"]),
            "title": short_title(it["title"]),
            "value": v,
            "gap": gap,
            "score": score,
            "priority": pr,
            "action": ACTION.get(str(it["id"]), "بازنگری ثبت شاخص و تکمیل پوشش موردنظر."),
        })
    priorities.sort(key=lambda x: x["score"], reverse=True)
    return pct, count, anomalies, strengths, weaknesses, priorities[:12]


class Report:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.c = canvas.Canvas(str(path), pagesize=(PAGE_W, PAGE_H))
        self.c.setTitle("گزارش عملکرد بهداشت حرفه ای پیرانشهر")
        self.c.setAuthor("سامانه آمار بهداشت حرفه ای")
        self.c.setSubject("شاخص های بهداشت حرفه ای شهرستان پیرانشهر - سال ۱۴۰۵")
        self.page = 0
        self.y = PAGE_H - 46
        self.dark = False

    def new_page(self, dark: bool = False):
        if self.page:
            self.footer()
            self.c.showPage()
        self.page += 1
        self.dark = dark
        self.c.setFillColor(C_DARK if dark else C_WHITE)
        self.c.rect(0, 0, PAGE_W, PAGE_H, stroke=0, fill=1)
        if not dark:
            self.c.setFillColor(C_LIGHT_TEAL)
            self.c.rect(0, PAGE_H - 10, PAGE_W, 10, stroke=0, fill=1)
        self.y = PAGE_H - 46

    def footer(self):
        line_color = HexColor("#2E7887") if getattr(self, "dark", False) else C_LINE
        text_color = HexColor("#A9D5DD") if getattr(self, "dark", False) else C_MUTED
        self.c.setStrokeColor(line_color)
        self.c.setLineWidth(0.5)
        self.c.line(MARGIN, 32, RIGHT, 32)
        self.c.setFont("Tahoma", 7.5)
        self.c.setFillColor(text_color)
        self.c.drawRightString(RIGHT, 20, fa("گزارش عملکرد بهداشت حرفه ای پیرانشهر — سال ۱۴۰۵"))
        self.c.drawString(MARGIN, 20, fa(f"صفحه {self.page}"))

    def ensure(self, need: float, dark: bool = False):
        if self.y - need < 48:
            self.new_page(dark)

    def text(self, s, right=None, y=None, size=10, font="Tahoma", color=C_TEXT, align="right"):
        right = RIGHT if right is None else right
        y = self.y if y is None else y
        self.c.setFont(font, size)
        self.c.setFillColor(color)
        shaped = fa(s)
        if align == "right":
            self.c.drawRightString(right, y, shaped)
        elif align == "left":
            self.c.drawString(right, y, shaped)
        else:
            self.c.drawCentredString(right, y, shaped)

    def para(self, text, width=None, size=9.5, leading=15, color=C_TEXT, font="Tahoma", right=None):
        width = PAGE_W - 2 * MARGIN if width is None else width
        right = RIGHT if right is None else right
        words = str(text).split()
        lines, cur = [], ""
        for w in words:
            trial = (cur + " " + w).strip()
            if pdfmetrics.stringWidth(fa(trial), font, size) <= width:
                cur = trial
            else:
                if cur:
                    lines.append(cur)
                cur = w
        if cur:
            lines.append(cur)
        for line in lines:
            self.ensure(leading + 4)
            self.text(line, right=right, size=size, font=font, color=color)
            self.y -= leading
        return lines

    def section(self, title, subtitle=None):
        self.ensure(70)
        self.y -= 8
        self.c.setFillColor(C_PRIMARY)
        self.c.roundRect(RIGHT - 4, self.y - 6, 4, 26, 2, stroke=0, fill=1)
        self.text(title, right=RIGHT - 14, size=16, font="Tahoma-Bold", color=C_DARK)
        self.y -= 22
        if subtitle:
            self.text(subtitle, size=9, color=C_MUTED)
            self.y -= 16
        self.y -= 4

    def card(self, x, y, w, h, fill=C_BG, border=None, radius=8):
        self.c.setFillColor(fill)
        self.c.setStrokeColor(border or fill)
        self.c.setLineWidth(0.6)
        self.c.roundRect(x, y, w, h, radius, stroke=1, fill=1)

    def kpi(self, number, label, sub, right, top, w=112, h=80, tone=C_PRIMARY):
        self.card(right - w, top - h, w, h, C_WHITE, C_LINE)
        self.c.setFillColor(tone)
        self.c.roundRect(right - w, top - 4, w, 4, 2, stroke=0, fill=1)
        self.text(number, right=right - 10, y=top - 28, size=18, font="Tahoma-Bold", color=tone)
        self.text(label, right=right - 10, y=top - 47, size=9, font="Tahoma-Bold", color=C_TEXT)
        self.text(sub, right=right - 10, y=top - 63, size=7.5, color=C_MUTED)

    def table(self, headers, rows, widths, row_h=18, head_h=22, font_size=8, status_col=None, right=None):
        right = RIGHT if right is None else right
        total_w = sum(widths)
        left = right - total_w
        header_y = self.y
        self.card(left, header_y - head_h, total_w, head_h, C_DARK, C_DARK, 4)
        x = right
        for h, w in zip(headers, widths):
            self.text(fit(str(h), "Tahoma-Bold", font_size, w - 8), right=x - 5, y=header_y - 15,
                      size=font_size, font="Tahoma-Bold", color=C_WHITE)
            x -= w
        y = header_y - head_h
        for i, row in enumerate(rows):
            if y - row_h < 46:
                self.new_page()
                header_y = self.y
                self.card(left, header_y - head_h, total_w, head_h, C_DARK, C_DARK, 4)
                x = right
                for h, w in zip(headers, widths):
                    self.text(fit(str(h), "Tahoma-Bold", font_size, w - 8), right=x - 5, y=header_y - 15,
                              size=font_size, font="Tahoma-Bold", color=C_WHITE)
                    x -= w
                y = header_y - head_h
            self.c.setFillColor(C_WHITE if i % 2 == 0 else C_BG)
            self.c.rect(left, y - row_h, total_w, row_h, stroke=0, fill=1)
            x = right
            for j, (cell, w) in enumerate(zip(row, widths)):
                col_color = C_TEXT
                if status_col is not None and j == status_col:
                    label, fg, _bg = cell if isinstance(cell, tuple) else (cell, C_TEXT, C_BG)
                    self.c.setFillColor(_bg)
                    self.c.roundRect(x - w + 3, y - row_h + 3, w - 6, row_h - 6, 3, stroke=0, fill=1)
                    col_color = fg
                    cell = label
                self.text(fit(str(cell), "Tahoma", font_size, w - 8), right=x - 5,
                          y=y - row_h + 6, size=font_size, color=col_color)
                x -= w
            self.c.setStrokeColor(C_LINE)
            self.c.setLineWidth(0.3)
            self.c.line(left, y - row_h, right, y - row_h)
            y -= row_h
        self.y = y - 10

    def hbar(self, title, rows, top=None, width=None, bar_h=11, gap=17, color=C_TEAL, max_value=None, note=None, digits=0):
        width = PAGE_W - 2 * MARGIN if width is None else width
        self.ensure(46 + len(rows) * gap + (22 if note else 0))
        top = self.y if top is None else top
        self.text(title, right=RIGHT, y=top, size=11, font="Tahoma-Bold", color=C_DARK)
        y = top - 24
        scale_max = max_value or max([float(r[1]) or 0 for r in rows] + [1])
        for label, value in rows:
            v = float(value or 0)
            sw = pdfmetrics.stringWidth(fa(label), "Tahoma", 8)
            label_w = min(sw + 8, 150)
            bar_w = max(20, width - label_w - 46)
            self.text(fit(str(label), "Tahoma", 8, label_w), right=RIGHT, y=y + 1, size=8, color=C_TEXT)
            self.c.setFillColor(C_BG)
            self.c.roundRect(RIGHT - label_w - bar_w, y - bar_h + 1, bar_w, bar_h, 2, stroke=0, fill=1)
            self.c.setFillColor(color)
            length = max(0.5, bar_w * min(1, v / scale_max))
            self.c.roundRect(RIGHT - label_w - length, y - bar_h + 1, length, bar_h, 2, stroke=0, fill=1)
            self.text(fmt(v, digits), right=RIGHT - label_w - bar_w - 4, y=y + 1, size=7.5, color=C_MUTED)
            y -= gap
        if note:
            self.text(note, right=RIGHT, y=y + 4, size=7.5, color=C_MUTED)
            y -= 14
        self.y = y - 6

    def line_chart(self, title, points, xlabels, top=None, width=None, height=150, color=C_PRIMARY):
        width = PAGE_W - 2 * MARGIN if width is None else width
        self.ensure(height + 70)
        top = self.y if top is None else top
        self.text(title, right=RIGHT, y=top, size=11, font="Tahoma-Bold", color=C_DARK)
        left = RIGHT - width
        base = top - height
        vals = [float(p or 0) for p in points]
        maxv = max(vals + [1]) * 1.15
        for g in range(5):
            gy = base + (height - 20) * g / 4
            self.c.setStrokeColor(C_LINE)
            self.c.setLineWidth(0.4)
            self.c.line(left, gy, RIGHT, gy)
            self.text(fmt(maxv * g / 4, 0), right=left - 4, y=gy - 3, size=6.5, color=C_MUTED)
        xs = [left + 12 + (width - 24) * i / max(1, len(vals) - 1) for i in range(len(vals))]
        ys = [base + 8 + (height - 28) * (v / maxv) for v in vals]
        self.c.setStrokeColor(color)
        self.c.setLineWidth(2)
        for i in range(len(xs) - 1):
            self.c.line(xs[i], ys[i], xs[i + 1], ys[i + 1])
        for x, y, v in zip(xs, ys, vals):
            self.c.setFillColor(color)
            self.c.circle(x, y, 2.6, stroke=0, fill=1)
            self.text(fmt(v, 1), right=x, y=y + 8, size=6.5, color=color, align="center")
        for x, lab in zip(xs, xlabels):
            self.text(lab, right=x, y=base - 10, size=7, color=C_MUTED, align="center")
        self.y = base - 28

    def cover(self, last_update, expert_count):
        self.new_page(dark=True)
        self.c.setFillColor(C_TEAL)
        self.c.rect(0, PAGE_H - 16, PAGE_W, 16, stroke=0, fill=1)
        self.c.setFillColor(C_PRIMARY)
        self.c.circle(90, 150, 150, stroke=0, fill=1)
        self.c.setFillColor(C_DARK)
        self.c.circle(500, 720, 110, stroke=0, fill=1)
        self.text("گزارش جامع عملکرد بهداشت حرفه ای", right=RIGHT - 20, y=PAGE_H - 130,
                  size=25, font="Tahoma-Bold", color=C_WHITE)
        self.text("شهرستان پیرانشهر", right=RIGHT - 20, y=PAGE_H - 170,
                  size=30, font="Tahoma-Bold", color=C_WHITE)
        self.text("دوره: ۱ فروردین ۱۴۰۵ تا آخرین دوره ثبت‌شده (مهر ۱۴۰۵)",
                  right=RIGHT - 20, y=PAGE_H - 215, size=12, color=HexColor("#CDE9EE"))
        self.text(f"آخرین بروزرسانی داده‌ها: {last_update}", right=RIGHT - 20,
                  y=PAGE_H - 238, size=10, color=HexColor("#A9D5DD"))
        self.text("مجموعه شاخص­ها، عملکرد مقایسه­ای مراکز، کارشناسان، نقاط قوت و ضعف و اولویت­ها",
                  right=RIGHT - 20, y=PAGE_H - 285, size=11, color=C_WHITE)
        self.card(MARGIN, 120, PAGE_W - 2 * MARGIN, 120, HexColor("#124E5B"), HexColor("#2E7887"))
        self.text("منبع داده", right=RIGHT - 30, y=210, size=11, font="Tahoma-Bold", color=C_WHITE)
        self.text("سامانه جامع آمار بهداشت حرفه‌ای — سطح شبکه بهداشت و درمان پیرانشهر",
                  right=RIGHT - 30, y=185, size=9.5, color=C_WHITE)
        self.text("استخراج از گزارش OLAP شاخص­ها به همراه جداول مراکز، دسته­بندی بهداشتی، زمان و بازرسان",
                  right=RIGHT - 30, y=165, size=9.5, color=C_WHITE)
        self.text(f"تعداد شاخص­های بررسی‌شده: ۹۲ شاخص | تعداد مراکز: ۹ مرکز | تعداد بازرسان دارای فعالیت: {fmt(expert_count, 0)} نفر",
                  right=RIGHT - 30, y=140, size=9.5, color=C_WHITE)
        self.text("تهیه‌شده توسط سامانه آمار بهداشت حرفه ای دانشگاه­های علوم پزشکی",
                  right=RIGHT - 20, y=60, size=9, color=HexColor("#A9D5DD"))


def build():
    items, by_id, centers, phones, meta, snap = load_data()
    centre_rank = centre_rows(items, by_id, centers)
    experts, expert_titles = expert_rows(by_id, phones)
    pct, count, anomalies, strengths, weaknesses, priorities = analysis(items, by_id)
    last_update = "۴ آذر ۱۴۰۵"
    last_iso = str(by_id.get("547", {}).get("date", ""))[:10]

    pdfmetrics.registerFont(TTFont("Tahoma", "C:/Windows/Fonts/tahoma.ttf"))
    pdfmetrics.registerFont(TTFont("Tahoma-Bold", "C:/Windows/Fonts/tahomabd.ttf"))
    pdfmetrics.registerFontFamily("Tahoma", normal="Tahoma", bold="Tahoma-Bold")

    rep = Report(OUT)
    rep.cover(last_update, len(experts))

    # Executive summary
    rep.new_page()
    rep.section("خلاصه اجرایی", "شاخص­های کلیدی شهرستان پیرانشهر در دوره مورد بررسی")
    rep.kpi(fmt(by_id["703"]["total"], 0), "بازرسی حرفه ای", "اولیه + مجدد + تشدید", RIGHT, rep.y, tone=C_PRIMARY)
    rep.kpi(fmt(by_id["714"]["total"], 0), "بازرسی اولیه", "از مجموع بازرسی­ها", RIGHT - 124, rep.y, tone=C_TEAL)
    rep.kpi(fmt(by_id["713"]["total"], 0), "بازرسی مجدد", "پیگیری نواقص", RIGHT - 248, rep.y, tone=C_AMBER)
    rep.kpi(fmt(by_id["725"]["total"], 0), "شاغل تحت پوشش", "فهرست بهروز شده", RIGHT - 372, rep.y, tone=C_GREEN)
    rep.y -= 96
    rep.kpi(fmt(by_id["906"]["total"], 0), "کارگاه بازرسی شده", "آخرین بازرسی < ۳ ماه", RIGHT, rep.y, tone=C_PRIMARY)
    rep.kpi(fmt(by_id["914"]["total"], 0), "کارگاه بازرسی نشده", "نیاز به تعیین تکلیف", RIGHT - 124, rep.y, tone=C_RED)
    rep.kpi(fmt(by_id["603"]["total"], 1) + "٪", "پوشش بازرسی کارگاه", f"{fmt(by_id['603']['ref1Count'],0)} از {fmt(by_id['603']['ref2Count'],0)}", RIGHT - 248, rep.y, tone=C_TEAL)
    rep.kpi(fmt(by_id["608"]["total"], 1) + "٪", "معاینه شاغلین", f"{fmt(by_id['608']['ref1Count'],0)} از {fmt(by_id['608']['ref2Count'],0)}", RIGHT - 372, rep.y, tone=C_GREEN)
    rep.y -= 100
    rep.section("یافته­های محوری")
    findings = [
        f"مجموع {fmt(by_id['703']['total'],0)} بازرسی حرفه ای ثبت شده است که {fmt(by_id['714']['total'],0)} مورد اولیه، {fmt(by_id['713']['total'],0)} مورد مجدد و {fmt(by_id['754']['total'],0)} مورد تشدید بوده است.",
        f"پوشش بازرسی کارگاه­ها {fmt(by_id['603']['total'],1)} درصد و پوشش معاینات شغلی {fmt(by_id['608']['total'],1)} درصد است؛ آموزش شاغلین با رقم {fmt(by_id['611']['total'],1)} درصد نیاز به بازنگری ثبت دارد.",
        f"{fmt(by_id['914']['total'],0)} کارگاه فاقد بازرسی و {fmt(by_id['612']['total'],1)} درصد از کارگاه­ها فاقد ساختمان و فضای مناسببوده­اند.",
        "بسیاری از شاخص­های مربوط به اندازه­گیری عوامل زیان­آور (صدا، ارتعاش، سیلیس، سرب، جیوه و پرتوها) صفر یا نزدیک به صفر ثبت شده است که نشان­دهنده کمبود ثبت نتایج اندازه­گیری است.",
        f"{len(anomalies)} شاخص دارای مقدار خارج از بازه ۰ تا ۱۰۰ یا مقدار ثبت­نشده است و باید در سامانه بازنگری شود.",
    ]
    for f in findings:
        rep.text("•", right=RIGHT - 2, size=10, color=C_PRIMARY)
        rep.para(f, width=PAGE_W - 2 * MARGIN - 18, size=9.5)
        rep.y -= 5
    rep.y -= 6
    rep.section("وضعیت کلی")
    good = sum(1 for x in pct if status(x)[0] == "good")
    warn = sum(1 for x in pct if status(x)[0] == "warn")
    bad = sum(1 for x in pct if status(x)[0] == "bad")
    chk = sum(1 for x in pct if status(x)[0] in ("check", "na"))
    widths = [110, 110, 110, 110]
    rep.table(
        ["وضعیت", "تعداد شاخص", "تعریف", "رنگ"],
        [
            [("مطلوب ≥ ۸۰٪", C_GREEN, C_LIGHT_GREEN), fmt(good,0), "پوشش یا انطباق مطلوب", ("سبز", C_GREEN, C_LIGHT_GREEN)],
            [("متوسط ۵۰–۷۹٪", C_AMBER, C_LIGHT_AMBER), fmt(warn,0), "نیاز به بهبود", ("زرد", C_AMBER, C_LIGHT_AMBER)],
            [("ضعیف < ۵۰٪", C_RED, C_LIGHT_RED), fmt(bad,0), "اولویت مداخله", ("قرمز", C_RED, C_LIGHT_RED)],
            [(" نیاز به بازنگری", C_PURPLE, HexColor("#F1ECFA")), fmt(chk,0), "خارج از بازه یا ثبت نشده", ("بنفش", C_PURPLE, HexColor("#F1ECFA"))],
        ],
        widths, row_h=20, status_col=0, font_size=8.5,
    )

    # Methodology
    rep.new_page()
    rep.section("روش کار و دامنه داده", "نحوه استخراج، تعریف بازه و محدودیت­ها")
    rep.para("داده­ها از خروجی OLAP شاخص­های بهداشت حرفه‌ای استخراج شد. سطح انتخابی، شبکه بهداشت و درمان شهرستان پیرانشهر با شناسه ۱۳۷۰۰۰۰۸۳۶ است و کلیه مراکز خدمات جامع سلامت تحت پوشش آن وارد مقایسه شدند.")
    rep.y -= 8
    rep.para("بازه درخواستی از ۱ فروردین ۱۴۰۵ تا امروز تعریف شد، اما آخرین دوره زمانی ثبت­شده در سامانه، مهر ۱۴۰۵ است. دوره­های فصلی، ششماهه و سالانه به­صورت تجمعی در گزارش لحاظ شده­اند. آخرین بروزرسانی ثبت‌شده در پاسخ سرور "
             f"{last_update} ({last_iso}) است.")
    rep.y -= 8
    rep.para("شاخص­های درصدی بر اساس صورت و مخرج شاخص محاسبه و در چهار گروه مطلوب، متوسط، ضعیف و نیاز به بازنگری طبقه­بندی شدند. شاخص­های تعدادی بدون رنگ­بندی درج شدند. مقادیر بیش از ۱۰۰ یا خالی به­عنوان خطای ثبت شناسایی و از فهرست نقاط قوت حذف شدند.")
    rep.y -= 12
    rep.section("محدودیت­ها و نکات تفسیری")
    notes = [
        "مقادیر تجمعی سالانه لزوماً برابر جمع مقادیر ماهانه نیستند؛ در برخی شاخص­ها مقدار سالانه تعداد واحدها یا افراد منحصربه­فرد و مقادیر ماهانه تعداد اقدامات است.",
        "برخی شاخص­ها مانند پوشش بازرسان، آموزش شاغلین و کارگاه سالم دارای مقادیر بالای ۱۰۰ درصد هستند که احتمالاً ناشی از تفاوت مخرج ثبت‌شده یا چندبارشماری است؛ این موارد نیاز به اصلاح دارند.",
        "شاخص­های صفر درصد لزوماً به معنای نبود خطر نیستند؛ گاهی به معنای عدم ثبت اندازه­گیری یا عدم بارگذاری نتایج در سامانه است.",
        "داده­های تماس کارشناسان از فهرست بهروز کارشناسان شهرستان پیرانشهر تکمیل شده است.",
    ]
    for n in notes:
        rep.text("•", right=RIGHT - 2, size=9.5, color=C_PRIMARY)
        rep.para(n, width=PAGE_W - 2 * MARGIN - 18, size=9)
        rep.y -= 4

    # County indicators tables
    groups = [
        ("شاخص­های نتیجه ای، ورودی و دخانیات", lambda x: str(x.get("category")) in ("4", "7") or str(x.get("indicatorType")) in ("1", "4")),
        ("شاخص­های فرایندی — کارگاه­ها (بخش اول)", lambda x: str(x.get("category")) == "5" and str(x.get("indicatorType")) == "2" and int(x["id"]) <= 622),
        ("شاخص­های فرایندی — کارگاه­ها (بخش دوم)", lambda x: str(x.get("category")) == "5" and str(x.get("indicatorType")) == "2" and 622 < int(x["id"]) <= 656),
        ("شاخص­های خروجی و_expanded کارگاه­ها", lambda x: str(x.get("category")) == "5" and str(x.get("indicatorType")) in ("3", "4")),
        ("شاخص­های فرایندی و خروجی — شاغلین", lambda x: str(x.get("category")) == "6"),
        ("شاخص­های تعدادی و حجم کار", lambda x: x.get("Ytitle") != "درصد"),
    ]
    for gtitle, predicate in groups:
        rep.new_page()
        subset = [x for x in items if predicate(x)]
        rep.section(gtitle, f"{len(subset)} شاخص — مقدار تجمعی تا مهر ۱۴۰۵")
        rows = []
        for it in subset:
            st, fg, bg = status(it)
            val = (fmt(it.get("total"), 1) + ("٪" if it.get("Ytitle") == "درصد" and it.get("total") not in (None, "") else "")) if st != "na" else "—"
            label = {
                "good": "مطلوب", "warn": "متوسط", "bad": "ضعیف", "check": "بازنگری", "na": "ثبت نشده", "count": "تعداد"
            }[st]
            rows.append([
                str(it["id"]),
                short_title(it["title"]),
                CATEGORY.get(str(it.get("category")), "—"),
                ITYPE.get(str(it.get("indicatorType")), "گزارش"),
                fmt(it.get("ref1Count"), 0),
                fmt(it.get("ref2Count"), 0),
                val,
                (label, fg, bg),
            ])
        rep.table(
            ["شناسه", "شاخص", "دسته موضوعی", "نوع", "صورت", "مخرج", "مقدار", "وضعیت"],
            rows,
            [34, 150, 82, 70, 42, 42, 55, 46],
            row_h=17, head_h=21, font_size=7.2, status_col=7,
        )

    # Monthly trends
    rep.new_page()
    rep.section("روند ماهانه شاخص­های کلیدی", "فروردین تا مهر ۱۴۰۵")
    months = ["فر", "ارد", "خرد", "تیر", "مرد", "شهر", "مهر"]
    ids = ["31", "32", "33", "34", "35", "36", "37"]
    def series(iid, field="value"):
        d = {t["id"]: t for t in by_id[iid]["timeline"]}
        if field == "value":
            return [d.get(t, {}).get("value") or 0 for t in ids]
        return [d.get(t, {}).get("n") or 0 for t in ids]
    rep.line_chart("درصد کارگاه­های بازرسی شده (ماهانه)", series("603"), months, color=C_TEAL)
    rep.line_chart("تعداد بازرسی­های حرفه ای (ماهانه)", series("703", "n"), months, color=C_PRIMARY)
    rep.line_chart("درصد شاغلین معاینه شده (ماهانه)", series("608"), months, color=C_GREEN)
    rep.para("توجه: مقدار تجمعی سالانه شاخص پوشش بازرسی ۸۴٫۰۷ درصد و معاینات ۹۸٫۴۳ درصد است که با جمع ساده مقادیر ماهانه متفاوت است.")
    rep.y -= 6

    # Center comparison
    rep.new_page()
    rep.section("عملکرد مقایسه­ای مراکز", "رتبه­بندی بر اساس میانگین شاخص­های معتبر درصدی")
    rep.hbar(
        "امتیاز ترکیبی مراکز (میانگین شاخص­های معتبر)",
        [(f"{r['rank']}. {r['name']}", r["score"]) for r in centre_rank],
        color=C_PRIMARY, max_value=100, digits=1,
        note="امتیاز ترکیبی تنها شامل شاخص­هایی است که مقدار آنان بین ۰ تا ۱۰۰ و مخرج آنان حداقل ۵ است.",
    )
    rep.hbar(
        "تعداد بازرسی­های ثبت شده به تفکیک مرکز",
        [(r["name"], r["inspections"]) for r in centre_rank],
        color=C_TEAL,
        note=f"مجموع بازرسی­ها: {fmt(by_id['703']['total'],0)} مورد.",
    )
    rep.section("جدول مقایسه­ای مراکز")
    key_ids = ["603", "608", "611", "606", "607", "612", "656", "547"]
    rows = []
    for r in sorted(centre_rank, key=lambda x: x["inspections"], reverse=True):
        cells = [str(r["rank"]), r["name"], fmt(r["inspections"], 0), fmt(r["score"], 1)]
        for kid in key_ids:
            v = r["detail"].get(kid)
            cells.append(fmt(v, 1) if v is not None else "—")
        rows.append(cells)
    rep.table(
        ["رتبه", "مرکز", "بازرسی", "امتیاز", "پوشش بازرسی", "معاینه", "آموزش", "کمیته", "اندازه­گیری", "ساختمان", "کارگاه سالم", "دخانیات"],
        rows,
        [28, 74, 40, 38, 52, 42, 42, 38, 46, 42, 48, 42],
        row_h=19, head_h=24, font_size=7.2,
    )

    # Experts
    rep.new_page()
    rep.section("عملکرد کارشناسان بهداشت حرفه ای", "تعداد بازرسی­ها به تفکیک کارشناس")
    rep.hbar(
        "مجموع بازرسی­ها توسط هر کارشناس",
        [(r["name"], r["total"]) for r in experts],
        color=C_PRIMARY,
        note=f"منبع: شاخص ۷۰۳ — مجموع {fmt(by_id['703']['total'],0)} بازرسی.",
    )
    rep.hbar(
        "بازرسی­های تشدید توسط هر کارشناس",
        [(r["name"], r["intensive"]) for r in experts if r["intensive"] > 0],
        color=C_AMBER,
        note=f"منبع: شاخص ۷۵۴ — مجموع {fmt(by_id['754']['total'],0)} بازرسی تشدید.",
    )
    rep.section("جدول کارشناسان و تماس")
    rows = []
    for r in experts:
        rows.append([
            str(r["rank"]),
            r["name"],
            fmt(r["total"], 0),
            fmt(r["initial"], 0),
            fmt(r["revisit"], 0),
            fmt(r["intensive"], 0),
            fmt(r["share"], 1) + "٪",
            r["phone"],
        ])
    rep.table(
        ["رتبه", "کارشناس", "کل", "اولیه", "مجدد", "تشدید", "سهم", "همراه"],
        rows,
        [30, 118, 42, 42, 42, 42, 46, 80],
        row_h=20, head_h=22, font_size=8,
    )


    # Strengths and weaknesses
    rep.new_page()
    rep.section("نقاط قوت", "شاخص­هایی با بالاترین پوشش معتبر")
    rows = []
    for it in strengths:
        kind, fg, bg = status(it)
        label = {"good": "مطلوب", "warn": "متوسط", "bad": "ضعیف", "check": "بازنگری", "na": "ثبت نشده", "count": "تعداد"}[kind]
        rows.append([
            short_title(it["title"]),
            fmt(it["total"], 1) + "٪",
            fmt(it["ref1Count"], 0),
            fmt(it["ref2Count"], 0),
            (label, fg, bg),
        ])
    rep.table(["شاخص", "مقدار", "صورت", "مخرج", "وضعیت"], rows, [224, 60, 60, 60, 60], row_h=19, status_col=4, font_size=8)
    rep.y -= 4
    rep.section("نقاط ضعف", "شاخص­هایی با کمترین پوشش و مخرج معتبر")
    rows = []
    for it in weaknesses:
        kind, fg, bg = status(it)
        label = {"good": "مطلوب", "warn": "متوسط", "bad": "ضعیف", "check": "بازنگری", "na": "ثبت نشده", "count": "تعداد"}[kind]
        rows.append([
            short_title(it["title"]),
            fmt(it["total"], 1) + "٪",
            fmt(it["ref1Count"], 0),
            fmt(it["ref2Count"], 0),
            (label, fg, bg),
        ])
    rep.table(["شاخص", "مقدار", "صورت", "مخرج", "وضعیت"], rows, [224, 60, 60, 60, 60], row_h=19, status_col=4, font_size=8)

    # Priorities
    rep.new_page()
    rep.section("اولویت­بندی اقدامات", "بر اساس شکاف پوشش و تعداد واحدها یا افراد تحت تأثیر")
    rep.para("امتیاز اولویت از ترکیب شکاف تعدادی (مخرج منهای صورت) و شکاف درصدی محاسبه شده است. اولویت ۱ مربوط به شکاف­های بالای ۵۰۰ مورد، اولویت ۲ به شکاف ۱۰۰ تا ۵۰۰ و اولویت ۳ به شکاف کمتر از ۱۰۰ است.")
    rep.y -= 8
    rows = []
    for p in priorities:
        rows.append([
            p["priority"],
            str(p["id"]),
            p["title"],
            fmt(p["value"], 1) + "٪",
            fmt(p["gap"], 0),
            p["action"],
        ])
    rep.table(
        ["اولویت", "شناسه", "شاخص", "مقدار", "شکاف", "اقدام پیشنهادی"],
        rows,
        [38, 34, 116, 42, 42, 190],
        row_h=31, head_h=22, font_size=7.4,
    )

    # Recommendations
    rep.new_page()
    rep.section("پیشنهادهای اجرایی", "برنامه ۹۰ روزه بهبود شاخص­ها")
    recs = [
        ("۱. پاک­سازی داده­ها", "بازنگری کلیه شاخص­های دارای مقدار بالای ۱۰۰ یا خالی و اصلاح مخرج شاخص در سامانه."),
        ("۲. تکمیل اندازه­گیری­ها", "انجام اندازه­گیری صدا، ارتعاش، عوامل شیمیایی و پرتوها در کارگاه­های شناسایی‌شده و بارگذاری نتایج."),
        ("۳. پوشش معاینات و آموزش", "تعیین تکلیف شاغلین فاقد معاینه و برگزاری دوره­های آموزشی با ثبت صحیح حضور."),
        ("۴. کاهش کارگاه­های فاقد بازرسی", f"تعیین تکلیف {fmt(by_id['914']['total'],0)} کارگاه بدون بازرسی و برنامه­ریزی بازرسی مجدد بر اساس فاصله زمانی."),
        ("۵. عدالت توزیع بازرسی", "توزیع متوازن بازرسی­ها بین کارشناسان با توجه به سهم فعلی و ظرفیت هر مرکز."),
        ("۶. تقویت کمیته­ها و تشکیلات", "تشکیل کمیته حفاظت فنی و بهداشت کار و تکمیل تشکیلات بهداشت حرفه ای در کارگاه­ها."),
        ("۷. پایش مستمر", "تهیه داشبورد ماهانه از شاخص­های کلیدی و مقایسه عملکرد مراکز در جلسات ماهانه شهرستان."),
    ]
    for title, body in recs:
        rep.ensure(48)
        rep.card(RIGHT - (PAGE_W - 2 * MARGIN), rep.y - 40, PAGE_W - 2 * MARGIN, 40, C_BG, C_LINE)
        rep.text(title, right=RIGHT - 12, y=rep.y - 14, size=10, font="Tahoma-Bold", color=C_PRIMARY)
        rep.text(body, right=RIGHT - 12, y=rep.y - 31, size=8.5, color=C_TEXT)
        rep.y -= 48
    rep.y -= 6
    rep.section("پیوست: منابع و شناسه­ها")
    rep.para("کلیه ارقام این گزارش مستقیماً از سرویس گزارش OLAP و جدول زمانی استخراج شده است. شناسه شبکه شهرستان ۱۳۷۰۰۰۰۸۳۶ و شناسه­های شاخص­ها در جدول­های مربوطه درج شده­اند. نسخه قابل استخراج داده در پرونده data/ohs-snapshot-1405.json نگهداری می­شود.")
    rep.para("برای بهروزرسانی گزارش، کافی است پرونده داده مذکور مجدداً تولید و اسکریپت scripts/build_piranshahr_report.py اجرا شود.")

    rep.footer()
    rep.c.save()
    print(OUT)
    print(f"pages={rep.page} indicators={len(items)} centers={len(centre_rank)} experts={len(experts)}")


if __name__ == "__main__":
    build()

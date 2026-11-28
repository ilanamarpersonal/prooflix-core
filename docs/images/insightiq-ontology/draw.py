"""Draws the images of docs/insightiq-ontology-design.md. Run: python3 docs/images/insightiq-ontology/draw.py docs/images/insightiq-ontology"""

import sys
from pathlib import Path
from xml.sax.saxutils import escape

OUT = Path(sys.argv[1])
OUT.mkdir(parents=True, exist_ok=True)

INK, MUTED, LINE, BG, CARD = "#0F172A", "#64748B", "#E2E8F0", "#F8FAFC", "#FFFFFF"
VIOLET, PINK, INDIGO = "#8B5CF6", "#DB2777", "#4F46E5"
OK, WARN, BAD, INFO = "#16A34A", "#D97706", "#DC2626", "#2563EB"
LAYER = {
    "bronze": ("#C98A5A", "#FBF1E9", "#8A5530"),
    "silver": ("#94A3B8", "#F1F5F9", "#475569"),
    "gold": ("#EAB308", "#FEF9C3", "#854D0E"),
}
LAYER_WORD = {"bronze": "raw", "silver": "cleaned", "gold": "curated"}


def t(x, y, s, size=13, fill=INK, weight=400, anchor="start", family=None, extra=""):
    fam = f' font-family="{family}"' if family else ""
    return (
        f'<text x="{x}" y="{y}" font-size="{size}" fill="{fill}" font-weight="{weight}" '
        f'text-anchor="{anchor}"{fam} {extra}>{escape(str(s))}</text>'
    )


def mono(x, y, s, size=12, fill=INK, weight=400, anchor="start"):
    return t(x, y, s, size, fill, weight, anchor, family="'JetBrains Mono',Menlo,Consolas,monospace")


def rect(x, y, w, h, fill=CARD, stroke=LINE, rx=10, sw=1, extra=""):
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}" {extra}/>'


def badge(x, y, layer, word=True):
    edge, fill, ink = LAYER[layer]
    label = f"{layer} · {LAYER_WORD[layer]}" if word else layer
    w = 26 + len(label) * 6.6
    return (
        f'<g><rect x="{x}" y="{y}" width="{w:.0f}" height="20" rx="10" fill="{fill}" stroke="{edge}"/>'
        f'<circle cx="{x + 10}" cy="{y + 10}" r="3.5" fill="{edge}"/>'
        + t(x + 18, y + 14, label, 11, ink, 600)
        + "</g>"
    ), w


def pill(x, y, label, fill, ink, stroke=None):
    w = 16 + len(label) * 6.3
    return (
        f'<rect x="{x}" y="{y}" width="{w:.0f}" height="20" rx="10" fill="{fill}" stroke="{stroke or fill}"/>'
        + t(x + w / 2, y + 14, label, 11, ink, 600, "middle")
    ), w


def check(x, y, kind, label, note=""):
    color = {"ok": OK, "warn": WARN, "bad": BAD, "info": INFO}[kind]
    if kind == "ok":
        icon = f'<circle cx="{x + 8}" cy="{y - 4}" r="8" fill="{color}"/><path d="M{x + 4} {y - 4}l3 3 5-6" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'
    elif kind == "warn":
        icon = f'<path d="M{x + 8} {y - 13}l8.5 15h-17z" fill="{color}"/>' + t(x + 8, y + 0.5, "!", 10, "#fff", 700, "middle")
    elif kind == "bad":
        icon = f'<rect x="{x}" y="{y - 12}" width="16" height="16" rx="4" fill="{color}"/>' + t(x + 8, y + 0.5, "×", 12, "#fff", 700, "middle")
    else:
        icon = f'<circle cx="{x + 8}" cy="{y - 4}" r="8" fill="{color}"/>' + t(x + 8, y + 0.5, "i", 11, "#fff", 700, "middle")
    out = icon + t(x + 24, y, label, 13, INK, 500)
    if note:
        out += t(x + 24 + len(label) * 7.1 + 8, y, note, 12, MUTED)
    return out


DEFS = f"""
<defs>
  <linearGradient id="iq" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="{VIOLET}"/><stop offset="1" stop-color="{PINK}"/></linearGradient>
  <linearGradient id="iqh" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="{VIOLET}"/><stop offset="1" stop-color="{PINK}"/></linearGradient>
  <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FAF5FF"/><stop offset="1" stop-color="#F8FAFC"/></linearGradient>
  <linearGradient id="lake" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0EA5E9"/><stop offset="1" stop-color="#1E3A8A"/></linearGradient>
  <linearGradient id="api" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6366F1"/><stop offset="1" stop-color="#312E81"/></linearGradient>
  <linearGradient id="slate" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#64748B"/><stop offset="1" stop-color="#1E293B"/></linearGradient>
  <filter id="sh" x="-10%" y="-10%" width="120%" height="130%"><feDropShadow dx="0" dy="3" stdDeviation="5" flood-color="#0F172A" flood-opacity="0.10"/></filter>
  <filter id="sh2" x="-10%" y="-10%" width="120%" height="130%"><feDropShadow dx="0" dy="10" stdDeviation="14" flood-color="#4C1D95" flood-opacity="0.16"/></filter>
  <marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#64748B"/></marker>
  <marker id="arv" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="{VIOLET}"/></marker>
</defs>
<style>text{{font-family:Inter,'Segoe UI',system-ui,-apple-system,Helvetica,Arial,sans-serif}}</style>
"""


def svg(name, w, h, body, bg="url(#sky)"):
    s = (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">'
        + DEFS
        + f'<rect width="{w}" height="{h}" fill="{bg}"/>'
        + body
        + "</svg>\n"
    )
    (OUT / name).write_text(s)


def iq_icon(x, y, size=28):
    k = size / 48
    return (
        f'<g transform="translate({x},{y}) scale({k})"><rect width="48" height="48" rx="12" fill="url(#iq)"/>'
        '<rect x="11" y="27" width="5.5" height="10" rx="1.6" fill="#fff" fill-opacity="0.55"/>'
        '<rect x="19.5" y="22" width="5.5" height="15" rx="1.6" fill="#fff" fill-opacity="0.75"/>'
        '<rect x="28" y="17" width="5.5" height="20" rx="1.6" fill="#fff"/>'
        '<path d="M11 22.5 19 16l6 3.5 9-8" stroke="#fff" stroke-width="2.4" fill="none" stroke-linecap="round"/>'
        "</g>"
    )


def heading(title, sub, y=46):
    return t(40, y, title, 22, INK, 700) + t(40, y + 24, sub, 13.5, MUTED)


# ---------------------------------------------------------------- app frame (mockups)
STEPS = ["Source", "Identity", "Properties", "Links", "Access", "Review & publish"]


def frame(w, h, path, active_tab, step=None, title=None):
    """A browser window with InsightIQ's top bar; returns the frame body and the content top."""
    out = [f'<g filter="url(#sh2)">{rect(24, 20, w - 48, h - 40, CARD, LINE, 14)}</g>']
    # title bar
    out.append(f'<path d="M24 34a14 14 0 0 1 14-14h{w - 76}a14 14 0 0 1 14 14v14H24z" fill="#F1F5F9"/>')
    for i, c in enumerate(["#F87171", "#FBBF24", "#34D399"]):
        out.append(f'<circle cx="{46 + i * 18}" cy="34" r="5.5" fill="{c}"/>')
    out.append(rect(w / 2 - 190, 25, 380, 18, CARD, LINE, 9))
    out.append(t(w / 2, 38, path, 11, MUTED, 500, "middle"))
    # product bar
    y = 48
    out.append(f'<line x1="24" y1="{y + 52}" x2="{w - 24}" y2="{y + 52}" stroke="{LINE}"/>')
    out.append(iq_icon(44, y + 12, 28))
    out.append(t(82, y + 31, "InsightIQ", 15, INK, 700))
    x = 190
    for group, tabs in (("MODEL", ["Object Model"]), ("EXPLORE", ["Objects", "Object sets"])):
        out.append(t(x, y + 31, group, 10, MUTED, 700, extra='letter-spacing="1"'))
        x += 62 if group == "MODEL" else 70
        for tab in tabs:
            tw = len(tab) * 7.6 + 22
            if tab == active_tab:
                out.append(rect(x - 4, y + 13, tw, 28, "#F3E8FF", "#F3E8FF", 8))
                out.append(t(x + tw / 2 - 4, y + 31, tab, 13, "#6D28D9", 600, "middle"))
            else:
                out.append(t(x + tw / 2 - 4, y + 31, tab, 13, "#334155", 500, "middle"))
            x += tw + 6
        x += 14
    out.append(rect(w - 330, y + 13, 210, 28, CARD, LINE, 8))
    out.append(t(w - 314, y + 31, "Search or run a command", 12, MUTED))
    out.append(t(w - 140, y + 31, "⌘K", 11, MUTED, 600, "end"))
    out.append(f'<circle cx="{w - 70}" cy="{y + 27}" r="14" fill="#E0E7FF"/>' + t(w - 70, y + 32, "DA", 11, INDIGO, 700, "middle"))
    top = y + 52
    if title:
        out.append(t(48, top + 34, title, 18, INK, 700))
        top += 46
    if step is not None:
        out.append(stepper(48, top + 14, w - 96, step))
        top += 64
    return "".join(out), top


def stepper(x, y, w, active):
    out = []
    n = len(STEPS)
    gap = w / n
    for i, name in enumerate(STEPS):
        cx = x + gap * i + 18
        done, now = i < active, i == active
        if i < n - 1:
            col = VIOLET if done else LINE
            lx0 = cx + 24 + len(name) * 7.6 + 12
            out.append(f'<line x1="{lx0}" y1="{y + 16}" x2="{cx + gap - 24}" y2="{y + 16}" stroke="{col}" stroke-width="2.5"/>')
        if done:
            out.append(f'<circle cx="{cx}" cy="{y + 16}" r="14" fill="{VIOLET}"/>')
            out.append(f'<path d="M{cx - 5} {y + 16}l3.5 3.5 6.5-7" stroke="#fff" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>')
        elif now:
            out.append(f'<circle cx="{cx}" cy="{y + 16}" r="16" fill="url(#iq)"/>')
            out.append(f'<circle cx="{cx}" cy="{y + 16}" r="20" fill="none" stroke="{VIOLET}" stroke-opacity="0.25" stroke-width="4"/>')
            out.append(t(cx, y + 21, i + 1, 13, "#fff", 700, "middle"))
        else:
            out.append(f'<circle cx="{cx}" cy="{y + 16}" r="14" fill="{CARD}" stroke="#CBD5E1" stroke-width="2"/>')
            out.append(t(cx, y + 21, i + 1, 12, MUTED, 600, "middle"))
        out.append(t(cx + 24, y + 21, name, 13, INK if (done or now) else MUTED, 700 if now else 500))
    return "".join(out)


def footer(w, h, next_label="Next", blocked=False):
    y = h - 84
    out = [f'<line x1="24" y1="{y}" x2="{w - 24}" y2="{y}" stroke="{LINE}"/>']
    out.append(rect(48, y + 16, 80, 34, CARD, "#CBD5E1", 8) + t(88, y + 38, "Back", 13, INK, 600, "middle"))
    out.append(t(150, y + 38, "Draft saved · 12:41", 12, MUTED))
    nw = max(110, len(next_label) * 8 + 40)
    sx = w - 72 - nw - 122
    out.append(rect(sx, y + 16, 110, 34, CARD, "#CBD5E1", 8) + t(sx + 55, y + 38, "Save draft", 13, INK, 600, "middle"))
    fill = "#CBD5E1" if blocked else "url(#iqh)"
    out.append(rect(w - 72 - nw + 0, y + 16, nw, 34, fill, "none", 8, 0) + t(w - 72 - nw / 2, y + 38, next_label + "  →", 13, "#fff", 700, "middle"))
    return "".join(out)


def field(x, y, w, label, value, mono_value=False, hint=None):
    out = t(x, y, label, 12, "#334155", 600)
    out += rect(x, y + 8, w, 34, CARD, "#CBD5E1", 8)
    out += (mono if mono_value else t)(x + 12, y + 30, value, 13, INK)
    if hint:
        out += t(x + w - 12, y + 30, hint, 12, MUTED, 400, "end")
    return out


def section(x, y, w, h, title, sub=None):
    out = rect(x, y, w, h, CARD, LINE, 12)
    out += t(x + 18, y + 28, title, 14, INK, 700)
    if sub:
        out += t(x + 18, y + 47, sub, 12, MUTED)
    return out


# ================================================================ 1. overview
def overview():
    W, H = 1240, 640
    b = [heading("The Object Model in Prooflix, end to end", "Tables from any medallion layer → modelled in InsightIQ → one Object API for people, AI Assist and tasks")]
    # Delta lake panel
    b.append(f'<g filter="url(#sh)">{rect(40, 110, 250, 420, CARD, LINE, 16)}</g>')
    b.append(f'<path d="M40 126a16 16 0 0 1 16-16h218a16 16 0 0 1 16 16v38H40z" fill="url(#lake)"/>')
    b.append(t(60, 143, "Delta Lake", 16, "#fff", 700) + t(60, 159, "Unity Catalog · storage of record", 11, "#E0F2FE"))
    tables = [("bronze", ["customers_raw", "payments_raw"]), ("silver", ["customers", "accounts"]), ("gold", ["customer_360", "transactions"])]
    for i, (layer, names) in enumerate(tables):
        y = 182 + i * 112
        edge, fill, ink = LAYER[layer]
        b.append(rect(58, y, 214, 96, fill, edge, 12))
        b.append(f'<rect x="58" y="{y}" width="8" height="96" rx="4" fill="{edge}"/>')
        b.append(t(78, y + 24, layer.capitalize(), 14, ink, 700) + t(262, y + 24, LAYER_WORD[layer], 11, ink, 500, "end"))
        for j, n in enumerate(names):
            b.append(f'<g transform="translate(80,{y + 38 + j * 26})"><rect width="16" height="14" rx="3" fill="#fff" stroke="{edge}"/><path d="M0 5h16M5 5v9" stroke="{edge}"/></g>')
            b.append(mono(104, y + 50 + j * 26, n, 12, INK))
    b.append(t(165, 550, "any layer can back an object type", 12, MUTED, 600, "middle"))
    # model panel
    b.append(f'<g filter="url(#sh)">{rect(350, 110, 330, 220, CARD, LINE, 16)}</g>')
    b.append(f'<path d="M350 126a16 16 0 0 1 16-16h298a16 16 0 0 1 16 16v38H350z" fill="url(#iq)"/>')
    b.append(t(370, 143, "Model · Object Model tab", 16, "#fff", 700) + t(370, 159, "data owners build with a guided wizard", 11, "#FCE7F3"))
    for i, name in enumerate(["Source", "Identity", "Props", "Links", "Access", "Publish"]):
        cx = 380 + i * 54
        if i < 5:
            b.append(f'<line x1="{cx + 12}" y1="200" x2="{cx + 42}" y2="200" stroke="{VIOLET}" stroke-width="2"/>')
        b.append(f'<circle cx="{cx}" cy="200" r="13" fill="url(#iq)"/>' + t(cx, 205, i + 1, 12, "#fff", 700, "middle"))
        b.append(t(cx, 232, name, 10.5, "#334155", 600, "middle"))
    b.append(check(372, 270, "ok", "checks run on real samples"))
    b.append(check(372, 300, "warn", "blocks or warns before publish"))
    # yaml panel
    b.append(f'<g filter="url(#sh)">{rect(350, 380, 330, 150, "#0F172A", "#0F172A", 16)}</g>')
    b.append(t(370, 408, "ontology/customer.yaml", 13, "#E2E8F0", 700))
    b.append(t(660, 408, "in the workspace (git)", 11, "#94A3B8", 500, "end"))
    code = [("apiName:", " Customer"), ("source:", " bronze.customers_raw"), ("  rows:", " latest per cst_id"), ("primaryKey:", " cst_id"), ("links:", " accounts → Account")]
    for i, (k, v) in enumerate(code):
        b.append(f'<text x="370" y="{436 + i * 18}" font-size="12" font-family="Menlo,Consolas,monospace"><tspan fill="#C4B5FD">{escape(k)}</tspan><tspan fill="#E2E8F0">{escape(v)}</tspan></text>')
    b.append(f'<path d="M515 330V374" stroke="{VIOLET}" stroke-width="2.5" marker-end="url(#arv)"/>')
    b.append(rect(527, 342, 64, 22, "#F3E8FF", "#F3E8FF", 11) + t(559, 357, "Publish", 11, "#6D28D9", 700, "middle"))
    # api panel
    b.append(f'<g filter="url(#sh)">{rect(740, 110, 240, 420, CARD, LINE, 16)}</g>')
    b.append(f'<path d="M740 126a16 16 0 0 1 16-16h208a16 16 0 0 1 16 16v38H740z" fill="url(#api)"/>')
    b.append(t(760, 143, "Object API", 16, "#fff", 700) + t(760, 159, "/api/ontology · the one way in", 11, "#E0E7FF"))
    items = [("Object views", "row rules + casts, per type"), ("Permissions", "per type, property, action"), ("Masking", "sensitive properties"), ("Search & links", "objects, search around"), ("Object sets", "saved, shareable"), ("Audit", "actions and sensitive reads")]
    for i, (a, s) in enumerate(items):
        y = 184 + i * 56
        b.append(rect(758, y, 204, 46, "#EEF2FF", "#E0E7FF", 10))
        b.append(t(772, y + 20, a, 13, "#312E81", 700) + t(772, y + 36, s, 11, "#4338CA"))
    # consumers
    cons = [("Objects & object sets", "people search, open, explore", "#0D9488", "#CCFBF1"), ("AI Assist tools", "search_objects, list_links …", VIOLET, "#F3E8FF"), ("Python tasks & apps", "ctx.ontology, typed clients", "#2563EB", "#DBEAFE")]
    for i, (a, s, c, f) in enumerate(cons):
        y = 132 + i * 136
        b.append(f'<g filter="url(#sh)">{rect(1040, y, 170, 108, CARD, LINE, 14)}</g>')
        b.append(f'<circle cx="1068" cy="{y + 32}" r="16" fill="{f}"/><circle cx="1068" cy="{y + 32}" r="6" fill="{c}"/>')
        b.append(t(1056, y + 70, a, 13, INK, 700) + t(1056, y + 88, s, 10.5, MUTED))
        b.append(f'<path d="M980 {y + 54}H1034" stroke="#64748B" stroke-width="2" marker-end="url(#ar)"/>')
    # arrows
    b.append(f'<path d="M290 236H344" stroke="#64748B" stroke-width="2" marker-end="url(#ar)"/>' + t(317, 228, "samples", 10.5, MUTED, 600, "middle"))
    b.append(f'<path d="M680 455H734" stroke="#64748B" stroke-width="2" marker-end="url(#ar)"/>' + t(707, 474, "definitions", 10.5, MUTED, 600, "middle"))
    b.append(f'<path d="M165 562V590H860V536" stroke="#0EA5E9" stroke-width="2.5" fill="none" stroke-dasharray="7 5" marker-end="url(#ar)"/>')
    b.append(rect(392, 578, 336, 24, BG, "#BAE6FD", 12) + t(560, 594, "data, read-only: DuckDB over Delta, through the object views", 11.5, "#0369A1", 600, "middle"))
    svg("overview.svg", W, H, "".join(b))


# ================================================================ 2. layers
def layers():
    W, H = 1240, 650
    b = [heading("Any layer can back an object type", "Row rules turn a table's rows into one clean object per key: bronze needs the most, gold usually none")]
    cols = ["cst_id", "full_nm", "_op", "_ingested_at"]
    xs = [0, 76, 190, 268]
    rows = {
        "bronze": [("10442", "Dana Cohen", "U", "09:12", "keep"), ("10442", "Dana Coen", "I", "08:01", "older"), ("10519", "Avi Levi", "I", "07:55", "keep"), ("10600", "Noa Bar", "D", "07:40", "deleted")],
        "silver": [("10442", "Dana Cohen", "true", "2026-11-28", "keep"), ("10442", "Dana Coen", "false", "2026-11-27", "older"), ("10519", "Avi Levi", "true", "2026-11-28", "keep")],
        "gold": [("10442", "Dana Cohen", "", "", "keep"), ("10519", "Avi Levi", "", "", "keep")],
    }
    head = {"bronze": cols, "silver": ["cst_id", "full_nm", "is_current", "valid_from"], "gold": ["customer_id", "full_name", "", ""]}
    rules = {
        "bronze": [("filter", "_op <> 'D'"), ("latest per key", "by _ingested_at ↓"), ("cast", "bal_amt → decimal")],
        "silver": [("filter", "is_current"), ("latest per key", "optional")],
        "gold": [("no rules needed", "one row per key")],
    }
    for i, layer in enumerate(["bronze", "silver", "gold"]):
        y0 = 112 + i * 172
        edge, fill, ink = LAYER[layer]
        b.append(f'<g filter="url(#sh)">{rect(40, y0, 1160, 152, CARD, LINE, 16)}</g>')
        b.append(f'<path d="M40 {y0 + 16}a16 16 0 0 1 16-16h6v152h-6a16 16 0 0 1-16-16z" fill="{edge}"/>')
        bd, _ = badge(70, y0 + 16, layer)
        b.append(bd)
        tbl = {"bronze": "tenant1.bronze.customers_raw", "silver": "tenant1.silver.customers", "gold": "tenant1.gold.customer_360"}[layer]
        b.append(mono(200, y0 + 31, tbl, 12, MUTED))
        # mini table
        tx, ty = 70, y0 + 46
        b.append(rect(tx, ty, 370, 22 + 20 * len(rows[layer]), BG, LINE, 8))
        for c, cx in zip(head[layer], xs):
            if c:
                b.append(mono(tx + 12 + cx, ty + 15, c, 11, MUTED, 700))
        for r, row in enumerate(rows[layer]):
            ry = ty + 22 + r * 20
            state = row[4]
            if state != "keep":
                color = "#FEE2E2" if state == "deleted" else "#F1F5F9"
                b.append(f'<rect x="{tx + 2}" y="{ry + 1}" width="366" height="18" fill="{color}"/>')
            col = INK if state == "keep" else "#94A3B8"
            for v, cx in zip(row[:4], xs):
                if v:
                    b.append(mono(tx + 12 + cx, ry + 14, v, 11, col))
            if state != "keep":
                b.append(f'<line x1="{tx + 10}" y1="{ry + 10}" x2="{tx + 360}" y2="{ry + 10}" stroke="#94A3B8" stroke-width="1"/>')
                b.append(t(tx + 380, ry + 14, state, 10.5, BAD if state == "deleted" else MUTED, 600))
        # arrow + rules
        b.append(f'<path d="M478 {y0 + 82}H548" stroke="{VIOLET}" stroke-width="2.5" marker-end="url(#arv)"/>')
        rx, ry = 560, y0 + 26
        b.append(rect(rx, ry, 260, 108, "#FAF5FF", "#E9D5FF", 12))
        b.append(t(rx + 16, ry + 22, "Row rules", 13, "#6D28D9", 700))
        for k, (a, v) in enumerate(rules[layer]):
            yy = ry + 46 + k * 22
            b.append(f'<circle cx="{rx + 21}" cy="{yy - 4}" r="3" fill="{VIOLET}"/>')
            b.append(t(rx + 32, yy, a, 12, INK, 600))
            b.append(mono(rx + 44 + len(a) * 6.6, yy, v, 11.5, "#6D28D9"))
        b.append(f'<path d="M832 {y0 + 82}H902" stroke="{VIOLET}" stroke-width="2.5" marker-end="url(#arv)"/>')
        # objects
        objs = [("Dana Cohen", "10442"), ("Avi Levi", "10519")]
        for k, (name, pk) in enumerate(objs):
            ox, oy = 916 + k * 138, y0 + 38
            b.append(rect(ox, oy, 126, 88, CARD, "#DDD6FE", 12))
            b.append(f'<circle cx="{ox + 22}" cy="{oy + 24}" r="12" fill="url(#iq)"/>' + t(ox + 22, oy + 28, name[0], 11, "#fff", 700, "middle"))
            b.append(t(ox + 40, oy + 22, "Customer", 10, MUTED, 600) + mono(ox + 40, oy + 35, pk, 10.5, MUTED))
            b.append(t(ox + 14, oy + 62, name, 13, INK, 700))
            b.append(f'<rect x="{ox + 14}" y="{oy + 70}" width="{30}" height="6" rx="3" fill="{edge}"/>')
        b.append(t(1192, y0 + 144, "one object per key", 11, MUTED, 600, "end"))
    svg("layers.svg", W, H, "".join(b))


# ================================================================ 3. wizard steps
def wizard_steps():
    W, H = 1240, 470
    b = [heading("The wizard: six steps, each checked against the data", "A red check blocks Next, an amber one is a risk the user can accept, a blue one is information")]
    data = [
        ("Source", "any Delta table, any layer", [("ok", "In Unity Catalog"), ("ok", "Is a Delta table"), ("info", "Layer: bronze")]),
        ("Identity", "key, title, row rules", [("bad", "Key never empty"), ("bad", "Unique after rules"), ("warn", "No ties in latest")]),
        ("Properties", "names, types, casts", [("warn", "Failed casts"), ("warn", "Personal columns"), ("warn", "Descriptions")]),
        ("Links", "names, join, cardinality", [("bad", "Join types match"), ("warn", "Match rate ≥ 95%"), ("bad", "Cardinality")]),
        ("Access", "who sees what", [("info", "Type visibility"), ("info", "Masked properties"), ("ok", "View as user")]),
        ("Review & publish", "diff, full checks", [("bad", "All, whole table"), ("warn", "Saved sets intact"), ("warn", "View speed")]),
    ]
    cw, gap, y0 = 180, 16, 120
    for i, (name, sub, checks) in enumerate(data):
        x = 40 + i * (cw + gap)
        if i < 5:
            b.append(f'<path d="M{x + cw + 1} {y0 + 44}H{x + cw + gap - 1}" stroke="{VIOLET}" stroke-width="2.5" marker-end="url(#arv)"/>')
        b.append(f'<g filter="url(#sh)">{rect(x, y0, cw, 270, CARD, LINE, 16)}</g>')
        b.append(f'<path d="M{x} {y0 + 16}a16 16 0 0 1 16-16h{cw - 32}a16 16 0 0 1 16 16v72H{x}z" fill="url(#iq)" opacity="{0.55 + i * 0.09:.2f}"/>')
        b.append(f'<circle cx="{x + 30}" cy="{y0 + 32}" r="15" fill="#fff"/>' + t(x + 30, y0 + 37, i + 1, 14, "#7C3AED", 800, "middle"))
        b.append(t(x + 16, y0 + 70, name, 15, "#fff", 700))
        b.append(t(x + 16, y0 + 112, sub, 11.5, MUTED, 500))
        b.append(f'<line x1="{x + 16}" y1="{y0 + 126}" x2="{x + cw - 16}" y2="{y0 + 126}" stroke="{LINE}"/>')
        for k, (kind, label) in enumerate(checks):
            b.append(check(x + 16, y0 + 158 + k * 34, kind, label).replace('font-size="13"', 'font-size="12"'))
        b.append(t(x + 16, y0 + 256, "draft saved", 10.5, "#A78BFA", 600))
    # legend
    ly = 425
    b.append(check(40, ly, "bad", "blocks Next") + check(180, ly, "warn", "warning, can be accepted") + check(400, ly, "info", "information") + check(540, ly, "ok", "passes"))
    b.append(t(1200, ly, "bronze and silver tables get the same steps; row rules and casts matter most there", 12, MUTED, 500, "end"))
    svg("wizard-steps.svg", W, H, "".join(b))


# ================================================================ 4. model home
def model_home():
    W, H = 1240, 720
    f, top = frame(W, H, "prooflix / insightiq / ontology", "Object Model", title="Object Model")
    b = [f]
    # toolbar
    b.append(rect(196, top - 36, 132, 30, "#F1F5F9", "#F1F5F9", 8))
    b.append(rect(199, top - 33, 62, 24, CARD, LINE, 6) + t(230, top - 16, "Graph", 12, INK, 600, "middle") + t(294, top - 16, "List", 12, MUTED, 500, "middle"))
    b.append(rect(860, top - 40, 160, 34, CARD, "#CBD5E1", 8) + t(876, top - 18, "Find a type…", 12, MUTED))
    b.append(rect(1030, top - 40, 160, 34, "url(#iqh)", "none", 8, 0) + t(1110, top - 18, "+  New object type", 13, "#fff", 700, "middle"))
    # canvas
    cx0, cy0, cw, ch = 48, top + 10, 820, H - top - 50
    b.append(rect(cx0, cy0, cw, ch, BG, LINE, 12))
    for gx in range(cx0 + 20, cx0 + cw, 24):
        for gy in range(cy0 + 20, cy0 + ch, 24):
            b.append(f'<circle cx="{gx}" cy="{gy}" r="1" fill="#CBD5E1"/>')
    nodes = {
        "Customer": (110, cy0 + 60, "bronze", "412,087", True, False),
        "Account": (470, cy0 + 40, "silver", "655,310", False, False),
        "Transaction": (520, cy0 + 300, "gold", "48.2M", False, False),
        "Payment": (120, cy0 + 330, "bronze", "18.7M", False, True),
        "Branch": (650, cy0 + 170, "gold", "142", False, False),
    }
    NW, NH = 196, 92

    def mid(n, side):
        x, y = nodes[n][0], nodes[n][1]
        return {"r": (x + NW, y + NH / 2), "l": (x, y + NH / 2), "b": (x + NW / 2, y + NH), "t": (x + NW / 2, y)}[side]

    edges = [("Customer", "r", "Account", "l", "owns"), ("Account", "b", "Transaction", "t", "has"), ("Account", "r", "Branch", "t", "held at"), ("Payment", "r", "Transaction", "l", "settles"), ("Customer", "b", "Payment", "t", "pays")]
    for a, sa, z, sz, label in edges:
        (x1, y1), (x2, y2) = mid(a, sa), mid(z, sz)
        dash = ' stroke-dasharray="6 5"' if "Payment" in (a, z) else ""
        if sa in "rl" and sz in "rl":
            d = f"M{x1} {y1}C{(x1 + x2) / 2} {y1} {(x1 + x2) / 2} {y2} {x2 - 6} {y2}"
        elif sa in "tb" and sz in "tb":
            d = f"M{x1} {y1}C{x1} {(y1 + y2) / 2} {x2} {(y1 + y2) / 2} {x2} {y2 - 6}"
        else:
            d = f"M{x1} {y1}C{x2} {y1} {x2} {y1} {x2} {y2 - 6}"
        b.append(f'<path d="{d}" stroke="#A78BFA" stroke-width="2" fill="none"{dash} marker-end="url(#arv)"/>')
        lx, ly = (x1 + x2) / 2, (y1 + y2) / 2
        lw = len(label) * 6.6 + 16
        b.append(rect(lx - lw / 2, ly - 11, lw, 22, CARD, "#DDD6FE", 11) + t(lx, ly + 4, label, 11, "#6D28D9", 600, "middle"))
    for name, (x, y, layer, count, sel, draft) in nodes.items():
        stroke = VIOLET if sel else ("#CBD5E1" if not draft else "#A1A1AA")
        extra = ' stroke-dasharray="6 4"' if draft else ""
        b.append(f'<g filter="url(#sh)"><rect x="{x}" y="{y}" width="{NW}" height="{NH}" rx="14" fill="{CARD}" stroke="{stroke}" stroke-width="{2.5 if sel else 1.5}"{extra}/></g>')
        if sel:
            b.append(f'<rect x="{x - 5}" y="{y - 5}" width="{NW + 10}" height="{NH + 10}" rx="18" fill="none" stroke="{VIOLET}" stroke-opacity="0.2" stroke-width="5"/>')
        b.append(f'<rect x="{x + 14}" y="{y + 14}" width="30" height="30" rx="9" fill="url(#iq)" opacity="{0.5 if draft else 1}"/>')
        b.append(t(x + 29, y + 34, name[0], 14, "#fff", 700, "middle"))
        b.append(t(x + 54, y + 28, name, 14, INK, 700) + t(x + 54, y + 44, f"{count} objects", 11, MUTED))
        bd, _ = badge(x + 14, y + 58, layer, word=False)
        b.append(bd)
        st, sw = pill(x + NW - 72, y + 58, "draft" if draft else "v4" if sel else "published", "#F4F4F5" if draft else "#DCFCE7", "#52525B" if draft else "#166534")
        b.append(st.replace(f'x="{x + NW - 72}"', f'x="{x + NW - 14 - sw:.0f}"', 1).replace(f'x="{x + NW - 72 + sw / 2}"', f'x="{x + NW - 14 - sw / 2}"'))
    # side panel
    px, py, pw = 888, top + 10, 304
    b.append(rect(px, py, pw, H - top - 50, CARD, LINE, 12))
    b.append(f'<rect x="{px + 18}" y="{py + 18}" width="40" height="40" rx="11" fill="url(#iq)"/>' + t(px + 38, py + 44, "C", 17, "#fff", 700, "middle"))
    b.append(t(px + 70, py + 36, "Customer", 17, INK, 700) + t(px + 70, py + 54, "A person or company holding accounts", 11, MUTED))
    rows = [("Source", "bronze.customers_raw"), ("Row rules", "filter, latest per cst_id"), ("Objects", "412,087"), ("Properties", "5 (1 sensitive)"), ("Links", "owns Account, pays Payment"), ("Access", "analysts, admins"), ("Published", "v4 · today 12:44 by dana")]
    for i, (k, v) in enumerate(rows):
        y = py + 96 + i * 36
        b.append(t(px + 18, y, k, 12, MUTED, 600) + t(px + 110, y, v, 12, INK, 500))
        b.append(f'<line x1="{px + 18}" y1="{y + 14}" x2="{px + pw - 18}" y2="{y + 14}" stroke="#F1F5F9"/>')
    bd, _ = badge(px + 18, py + 360, "bronze")
    b.append(bd + t(px + 128, py + 374, "raw data: access restricted", 11, "#8A5530", 500))
    b.append(rect(px + 18, py + 400, pw - 36, 36, "url(#iqh)", "none", 8, 0) + t(px + pw / 2, py + 423, "Edit in the wizard", 13, "#fff", 700, "middle"))
    b.append(rect(px + 18, py + 444, pw - 36, 36, CARD, "#CBD5E1", 8) + t(px + pw / 2, py + 467, "Open in Objects", 13, INK, 600, "middle"))
    svg("model-home.svg", W, H, "".join(b), bg=BG)


# ================================================================ 5. step 1 source
def step1():
    W, H = 1240, 840
    f, top = frame(W, H, "prooflix / insightiq / ontology / new", "Object Model", step=0)
    b = [f]
    lx, lw = 48, 700
    b.append(t(lx, top + 22, "Choose the table behind this object type", 16, INK, 700))
    b.append(t(lx, top + 42, "Any Delta table in Unity Catalog: bronze, silver or gold", 12.5, MUTED))
    b.append(rect(lx, top + 58, 360, 34, CARD, "#CBD5E1", 8) + t(lx + 34, top + 80, "customers", 13, INK))
    b.append(f'<circle cx="{lx + 18}" cy="{top + 74}" r="6" fill="none" stroke="{MUTED}" stroke-width="1.8"/><path d="M{lx + 22} {top + 79}l4 4" stroke="{MUTED}" stroke-width="1.8"/>')
    seg_x = lx + 376
    b.append(rect(seg_x, top + 58, 324, 34, "#F1F5F9", "#F1F5F9", 8))
    for i, s in enumerate(["All layers", "bronze", "silver", "gold"]):
        sx = seg_x + 4 + i * 80
        if i == 0:
            b.append(rect(sx, top + 62, 76, 26, CARD, LINE, 6))
        b.append(t(sx + 38, top + 80, s, 12, INK if i == 0 else MUTED, 600 if i == 0 else 500, "middle"))
    tables = [
        ("bronze", "tenant1.bronze.customers_raw", "1,240,512 rows", "updated 4 min ago", True),
        ("bronze", "tenant1.bronze.customer_events", "9,804,221 rows", "updated 1 min ago", False),
        ("silver", "tenant1.silver.customers", "412,090 rows", "updated 1 h ago", False),
        ("gold", "tenant1.gold.customer_360", "410,877 rows", "updated 6 h ago", False),
    ]
    for i, (layer, name, rows, upd, sel) in enumerate(tables):
        y = top + 108 + i * 58
        b.append(rect(lx, y, lw, 50, "#FAF5FF" if sel else CARD, VIOLET if sel else LINE, 10, 2 if sel else 1))
        b.append(f'<circle cx="{lx + 22}" cy="{y + 25}" r="8" fill="{CARD}" stroke="{VIOLET if sel else "#CBD5E1"}" stroke-width="2"/>')
        if sel:
            b.append(f'<circle cx="{lx + 22}" cy="{y + 25}" r="4" fill="{VIOLET}"/>')
        bd, bw = badge(lx + 42, y + 15, layer, word=False)
        b.append(bd)
        b.append(mono(lx + 54 + bw, y + 30, name, 13, INK, 600))
        b.append(t(lx + lw - 150, y + 30, rows, 12, "#334155", 500, "end") + t(lx + lw - 16, y + 30, upd, 12, MUTED, 400, "end"))
    y = top + 344
    b.append(rect(lx, y, lw, 40, CARD, "#CBD5E1", 10, 1, 'stroke-dasharray="5 4"'))
    b.append(t(lx + 18, y + 25, "✦  Start from the semantic model instead", 13, "#6D28D9", 600) + t(lx + lw - 16, y + 25, "3 entities found", 12, MUTED, 400, "end"))
    # note
    y = top + 400
    b.append(rect(lx, y, lw, 74, "#FBF1E9", "#E8C3A3", 10))
    bd, _ = badge(lx + 16, y + 14, "bronze")
    b.append(bd)
    b.append(t(lx + 130, y + 28, "Raw data: what the next steps will offer", 13, "#8A5530", 700))
    b.append(t(lx + 16, y + 54, "Rows may repeat per key → step 2 offers row rules.  Text columns → step 3 offers casts.  Access starts restricted.", 12, "#8A5530"))
    # checks
    y = top + 500
    b.append(t(lx, y, "CHECKS", 11, MUTED, 700, extra='letter-spacing="1"'))
    b.append(check(lx, y + 28, "ok", "In Unity Catalog, and you may read it"))
    b.append(check(lx + 340, y + 28, "ok", "Delta table, 214 versions"))
    b.append(check(lx, y + 56, "info", "Layer: bronze", "(from the schema name)"))
    b.append(check(lx + 340, y + 56, "ok", "No other type uses this table"))
    # preview
    px, pw = 776, 416
    b.append(section(px, top + 10, pw, 560, "Preview", "customers_raw · 9 columns · 20 sample rows"))
    cols = [("cst_id", "string"), ("full_nm", "string"), ("city_nm", "string"), ("bal_amt", "string"), ("id_number", "string"), ("phone", "string"), ("_op", "string"), ("_ingested_at", "timestamp"), ("_source_file", "string")]
    for i, (c, ty) in enumerate(cols):
        y = top + 86 + i * 28
        b.append(rect(px + 18, y - 17, pw - 36, 24, BG if i % 2 == 0 else CARD, "none", 6, 0))
        b.append(mono(px + 30, y, c, 12, INK, 600) + mono(px + pw - 30, y, ty, 11.5, "#7C3AED" if ty != "string" else MUTED, 400, "end"))
    y = top + 352
    b.append(t(px + 18, y, "SAMPLE ROWS", 11, MUTED, 700, extra='letter-spacing="1"'))
    sample = [("10442", "Dana Cohen", "Haifa", "18240.50", "U"), ("10442", "Dana Coen", "Haifa", "18240.50", "I"), ("10519", "Avi Levi", "Tel Aviv", "102500", "I"), ("10600", "Noa Bar", "Eilat", "-3120", "D"), ("10611", "Yael Mor", "Haifa", "7420.00", "I")]
    sx = [0, 56, 152, 232, 316]
    for j, hcol in enumerate(["cst_id", "full_nm", "city_nm", "bal_amt", "_op"]):
        b.append(mono(px + 24 + sx[j], y + 26, hcol, 10.5, MUTED, 700))
    for i, row in enumerate(sample):
        yy = y + 48 + i * 24
        dup = row[0] == "10442"
        if dup:
            b.append(rect(px + 18, yy - 16, pw - 36, 22, "#FBF1E9", "none", 4, 0))
        for j, v in enumerate(row):
            b.append(mono(px + 24 + sx[j], yy, v, 11, INK))
    b.append(t(px + 18, top + 552, "Highlighted: one key, two rows (handled in step 2)", 11, "#8A5530", 500))
    b.append(footer(W, H, "Next: Identity"))
    svg("step-1-source.svg", W, H, "".join(b), bg=BG)


# ================================================================ 6. step 2 identity
def step2():
    W, H = 1240, 860
    f, top = frame(W, H, "prooflix / insightiq / ontology / customer", "Object Model", step=1)
    b = [f]
    lx = 48
    b.append(field(lx, top + 20, 220, "Name", "Customer"))
    b.append(field(lx + 236, top + 20, 220, "Plural", "Customers"))
    b.append(field(lx + 472, top + 20, 228, "Icon", "user", hint="▾"))
    b.append(field(lx, top + 90, 340, "Primary key", "cst_id", True, "▾"))
    b.append(field(lx + 360, top + 90, 340, "Title property", "full_nm", True, "▾"))
    # row rules card
    y = top + 160
    b.append(rect(lx, y, 700, 168, "#FAF5FF", "#E9D5FF", 12))
    b.append(t(lx + 18, y + 28, "Row rules", 14, "#6D28D9", 700))
    bd, _ = badge(lx + 110, y + 14, "bronze")
    b.append(bd + t(lx + 682, y + 28, "the key repeats in this table, so rows need rules", 12, MUTED, 400, "end"))
    b.append(t(lx + 18, y + 60, "Filter", 12, "#334155", 600))
    b.append(rect(lx + 18, y + 68, 300, 34, CARD, "#CBD5E1", 8) + mono(lx + 30, y + 90, "_op <> 'D'", 13, INK))
    b.append(t(lx + 340, y + 60, "Latest row per key", 12, "#334155", 600))
    b.append(rect(lx + 340, y + 70, 40, 22, VIOLET, VIOLET, 11) + f'<circle cx="{lx + 369}" cy="{y + 81}" r="8" fill="#fff"/>')
    b.append(t(lx + 392, y + 86, "on", 12, "#6D28D9", 600))
    b.append(rect(lx + 430, y + 68, 160, 34, CARD, "#CBD5E1", 8) + mono(lx + 442, y + 90, "_ingested_at", 13, INK) + t(lx + 578, y + 90, "▾", 12, MUTED, 400, "end"))
    b.append(rect(lx + 600, y + 68, 82, 34, CARD, "#CBD5E1", 8) + t(lx + 641, y + 90, "newest ▾", 12, INK, 500, "middle"))
    b.append(t(lx + 18, y + 136, "Suggested ordering columns:", 12, MUTED))
    for i, s in enumerate(["_ingested_at", "_commit_version", "updated_at"]):
        p, w = pill(lx + 190 + i * 128, y + 122, s, "#EDE9FE", "#6D28D9")
        b.append(p)
    # numbers
    y = top + 346
    b.append(t(lx, y, "WHAT THE RULES DO", 11, MUTED, 700, extra='letter-spacing="1"'))
    cards = [("Rows", "1,240,512", "412,087", INK), ("Distinct keys", "412,087", "412,087", INK), ("Duplicate keys", "828,425", "0", OK), ("Empty keys", "0", "0", OK)]
    for i, (lab, before, after, col) in enumerate(cards):
        x = lx + i * 178
        b.append(rect(x, y + 12, 166, 92, CARD, LINE, 12))
        b.append(t(x + 14, y + 34, lab, 12, MUTED, 600))
        bcol = BAD if lab == "Duplicate keys" else MUTED
        b.append(t(x + 14, y + 58, before, 13, bcol, 500, extra='text-decoration="line-through"'))
        b.append(t(x + 14, y + 88, after, 22, col, 800))
        b.append(t(x + 152, y + 88, "after", 11, MUTED, 500, "end"))
    # checks
    y = top + 482
    b.append(t(lx, y, "CHECKS", 11, MUTED, 700, extra='letter-spacing="1"'))
    b.append(check(lx, y + 28, "ok", "Key never empty after the rules"))
    b.append(check(lx + 360, y + 28, "ok", "Key unique after the rules"))
    b.append(check(lx, y + 58, "warn", "3 keys tie on _ingested_at", "(view)"))
    b.append(check(lx + 360, y + 58, "ok", "Filter is valid for this table"))
    b.append(check(lx, y + 88, "ok", "API name Customer is free"))
    b.append(check(lx + 360, y + 88, "ok", "Title is not sensitive"))
    # preview object
    px, pw = 776, 416
    b.append(section(px, top + 10, pw, 590, "Preview object", "one sample, after the row rules"))
    oy = top + 70
    b.append(rect(px + 18, oy, pw - 36, 150, "url(#iq)", "none", 14, 0, 'opacity="0.10"'))
    b.append(f'<circle cx="{px + 58}" cy="{oy + 46}" r="26" fill="url(#iq)"/>' + t(px + 58, oy + 53, "DC", 16, "#fff", 700, "middle"))
    b.append(t(px + 98, oy + 42, "Dana Cohen", 20, INK, 800) + mono(px + 98, oy + 62, "Customer:10442", 12, MUTED))
    bd, _ = badge(px + 32, oy + 96, "bronze")
    b.append(bd)
    p, _ = pill(px + 150, oy + 96, "draft", "#F4F4F5", "#52525B")
    b.append(p)
    b.append(t(px + 32, oy + 136, "from the row ingested 09:12 (newest of 2)", 11.5, "#6D28D9", 500))
    props = [("cst_id", "10442"), ("full_nm", "Dana Cohen"), ("city_nm", "Haifa"), ("bal_amt", "18240.50"), ("id_number", "0•••••••4"), ("_op", "U"), ("_ingested_at", "2026-11-28 09:12")]
    for i, (k, v) in enumerate(props):
        y = oy + 186 + i * 30
        b.append(mono(px + 30, y, k, 12, MUTED) + t(px + pw - 30, y, v, 12.5, INK, 500, "end"))
        b.append(f'<line x1="{px + 30}" y1="{y + 11}" x2="{px + pw - 30}" y2="{y + 11}" stroke="#F1F5F9"/>')
    b.append(t(px + 30, oy + 410, "Names, types and casts come in step 3", 11.5, MUTED, 500))
    b.append(footer(W, H, "Next: Properties"))
    svg("step-2-identity.svg", W, H, "".join(b), bg=BG)


# ================================================================ 7. step 4 links
def step4():
    W, H = 1240, 830
    f, top = frame(W, H, "prooflix / insightiq / ontology / customer", "Object Model", step=3)
    b = [f]
    lx = 48
    b.append(t(lx, top + 22, "Links of Customer", 16, INK, 700) + t(lx + 700, top + 22, "+ Add link", 13, "#6D28D9", 700, "end"))
    # link form card
    y = top + 38
    b.append(rect(lx, y, 700, 196, CARD, VIOLET, 12, 1.5))
    b.append(field(lx + 18, y + 26, 200, "From", "Customer"))
    b.append(f'<path d="M{lx + 228} {y + 55}H{lx + 262}" stroke="{VIOLET}" stroke-width="2.5" marker-end="url(#arv)"/>')
    b.append(field(lx + 272, y + 26, 200, "To", "Account", hint="▾"))
    b.append(field(lx + 488, y + 26, 194, "Cardinality", "one to many", hint="▾"))
    b.append(field(lx + 18, y + 96, 200, "Name (Customer →)", "accounts", True))
    b.append(field(lx + 272, y + 96, 200, "Reverse (← Account)", "owner", True))
    b.append(field(lx + 488, y + 96, 194, "Stored as", "column on Account", hint="▾"))
    b.append(mono(lx + 18, y + 176, "Account.owner_ref = Customer.cst_id", 12.5, "#6D28D9", 600))
    p, _ = pill(lx + 330, y + 162, "suggested: semantic model join", "#EDE9FE", "#6D28D9")
    b.append(p)
    # results
    y = top + 254
    b.append(t(lx, y, "WHAT THE JOIN FOUND", 11, MUTED, 700, extra='letter-spacing="1"'))
    # donut
    cx, cy, r = lx + 80, y + 96, 58
    import math

    frac = 0.982
    b.append(f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="none" stroke="#F1F5F9" stroke-width="16"/>')
    circ = 2 * math.pi * r
    b.append(f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="none" stroke="url(#iq)" stroke-width="16" stroke-linecap="round" stroke-dasharray="{circ * frac:.1f} {circ:.1f}" transform="rotate(-90 {cx} {cy})"/>')
    b.append(t(cx, cy + 4, "98.2%", 22, INK, 800, "middle") + t(cx, cy + 22, "match rate", 11, MUTED, 500, "middle"))
    stats = [("Accounts with an owner", "643,506 of 655,310"), ("Accounts without", "11,804  (view 20)"), ("Cardinality found", "one to many · max 9 per customer"), ("Customers with no account", "1,920")]
    for i, (k, v) in enumerate(stats):
        yy = y + 40 + i * 34
        b.append(t(lx + 170, yy, k, 12.5, MUTED, 500) + t(lx + 700, yy, v, 13, INK, 600, "end"))
        b.append(f'<line x1="{lx + 170}" y1="{yy + 12}" x2="{lx + 700}" y2="{yy + 12}" stroke="#F1F5F9"/>')
    y = top + 448
    b.append(t(lx, y, "CHECKS", 11, MUTED, 700, extra='letter-spacing="1"'))
    b.append(check(lx, y + 28, "ok", "Join columns exist, types match"))
    b.append(check(lx + 360, y + 28, "ok", "Match rate 98.2% ≥ 95%"))
    b.append(check(lx, y + 58, "ok", "Cardinality as declared"))
    b.append(check(lx + 360, y + 58, "info", "Mixed layers: bronze → silver"))
    # preview mini graph
    px, pw = 776, 416
    b.append(section(px, top + 10, pw, 560, "Preview link", "Dana Cohen → accounts"))
    ccx, ccy = px + 110, top + 230
    accs = [("2201-778", "Checking", "18,240 ₪", ccy - 110), ("2201-913", "Savings", "102,500 ₪", ccy), ("2207-055", "Credit", "−3,120 ₪", ccy + 110)]
    for num, kind, bal, ay in accs:
        b.append(f'<path d="M{ccx + 40} {ccy}C{ccx + 110} {ccy} {ccx + 110} {ay} {px + 220} {ay}" stroke="#A78BFA" stroke-width="2" fill="none" marker-end="url(#arv)"/>')
        b.append(f'<g filter="url(#sh)">{rect(px + 226, ay - 32, 172, 64, CARD, LINE, 12)}</g>')
        b.append(f'<rect x="{px + 238}" y="{ay - 20}" width="26" height="26" rx="8" fill="#E0E7FF"/>' + t(px + 251, ay - 2, "A", 12, INDIGO, 700, "middle"))
        b.append(mono(px + 274, ay - 8, num, 12, INK, 700) + t(px + 274, ay + 8, kind, 11, MUTED))
        b.append(t(px + 386, ay + 24, bal, 11.5, INK, 600, "end"))
        bd, _ = badge(px + 238, ay + 12, "silver", word=False)
    b.append(f'<circle cx="{ccx}" cy="{ccy}" r="40" fill="url(#iq)"/>' + t(ccx, ccy + 6, "DC", 18, "#fff", 800, "middle"))
    b.append(t(ccx, ccy + 62, "Dana Cohen", 13, INK, 700, "middle"))
    bd, bw = badge(ccx - 34, ccy + 72, "bronze", word=False)
    b.append(bd)
    lab_w = 64
    b.append(rect(ccx + 62, ccy - 52, lab_w, 22, CARD, "#DDD6FE", 11) + t(ccx + 62 + lab_w / 2, ccy - 37, "accounts", 11, "#6D28D9", 600, "middle"))
    b.append(rect(px + 18, top + 470, pw - 36, 80, BG, LINE, 10))
    b.append(t(px + 34, top + 496, "In Explore, the object page will show:", 12, MUTED, 500))
    b.append(t(px + 34, top + 520, "Customer → accounts (3)", 13, INK, 600) + t(px + pw - 34, top + 520, "Account → owner (1)", 13, INK, 600, "end"))
    b.append(footer(W, H, "Next: Access"))
    svg("step-4-links.svg", W, H, "".join(b), bg=BG)


# ================================================================ 8. step 6 publish
def step6():
    W, H = 1240, 780
    f, top = frame(W, H, "prooflix / insightiq / ontology / customer", "Object Model", step=5)
    b = [f]
    lx = 48
    b.append(section(lx, top + 10, 400, 420, "Changes", "against published version 3"))
    diff = [("+", "Customer", "new object type", OK), ("+", "5 properties", "1 sensitive: nationalId", OK), ("+", "Row rules", "filter, latest per cst_id", OK), ("+", "Link accounts → Account", "one to many", OK), ("~", "Account.title", "account_no → displayName", WARN), ("−", "Account.legacyCode", "used by 1 saved set", BAD)]
    for i, (sign, a, s, c) in enumerate(diff):
        y = top + 78 + i * 56
        bg = {OK: "#F0FDF4", WARN: "#FFFBEB", BAD: "#FEF2F2"}[c]
        b.append(rect(lx + 18, y, 364, 46, bg, "none", 10, 0))
        b.append(f'<circle cx="{lx + 40}" cy="{y + 23}" r="11" fill="{c}"/>' + t(lx + 40, y + 28, sign, 14, "#fff", 800, "middle"))
        b.append(t(lx + 62, y + 20, a, 13, INK, 700) + t(lx + 62, y + 37, s, 11.5, MUTED))
    # full checks
    cx, cw = lx + 420, 400
    b.append(section(cx, top + 10, cw, 420, "Full checks", "on the whole table · background job"))
    b.append(rect(cx + 18, top + 70, cw - 36, 10, "#F1F5F9", "none", 5, 0) + rect(cx + 18, top + 70, cw - 36, 10, "url(#iqh)", "none", 5, 0))
    b.append(t(cx + 18, top + 100, "Done in 41 s", 12, MUTED, 500) + t(cx + cw - 18, top + 100, "100%", 12, INK, 700, "end"))
    rows = [("ok", "Key unique", "412,087 objects"), ("ok", "Key never empty", ""), ("warn", "Cast bal_amt", "0.3% failed (1,236)"), ("ok", "Link accounts", "98.2% match"), ("warn", "Saved set uses legacyCode", "“Old branches”"), ("ok", "Object view speed", "1.4 s"), ("ok", "Access saved", "analysts, admins")]
    for i, (k, a, s) in enumerate(rows):
        y = top + 140 + i * 40
        b.append(check(cx + 18, y, k, a))
        b.append(t(cx + cw - 18, y, s, 12, MUTED, 500, "end"))
    # publish card
    px, pw = lx + 840, 304
    b.append(f'<g filter="url(#sh2)">{rect(px, top + 10, pw, 420, CARD, "#DDD6FE", 16, 1.5)}</g>')
    b.append(f'<path d="M{px} {top + 26}a16 16 0 0 1 16-16h{pw - 32}a16 16 0 0 1 16 16v84H{px}z" fill="url(#iq)"/>')
    b.append(t(px + 20, top + 50, "Ready to publish", 17, "#fff", 800) + t(px + 20, top + 72, "2 warnings accepted", 12, "#FCE7F3", 500))
    b.append(t(px + 20, top + 140, "Version", 12, MUTED, 600))
    b.append(t(px + 20, top + 172, "3", 26, "#94A3B8", 700) + t(px + 52, top + 170, "→", 20, MUTED, 600) + t(px + 82, top + 172, "4", 26, INK, 800))
    b.append(t(px + 20, top + 214, "Writes", 12, MUTED, 600))
    b.append(mono(px + 20, top + 236, "ontology/customer.yaml", 12.5, INK, 600))
    b.append(mono(px + 20, top + 256, "ontology/account.yaml", 12.5, INK, 600))
    b.append(t(px + 20, top + 292, "Then", 12, MUTED, 600))
    b.append(t(px + 20, top + 314, "Objects and AI Assist see v4", 12.5, INK, 500))
    b.append(t(px + 20, top + 334, "Indexing starts (phase C)", 12.5, MUTED, 500))
    b.append(rect(px + 20, top + 360, pw - 40, 46, "url(#iqh)", "none", 10, 0) + t(px + pw / 2, top + 389, "Publish version 4", 15, "#fff", 800, "middle"))
    b.append(t(lx, top + 466, "A removed property that a saved object set uses is listed before publishing; the set owner is told after.", 12.5, MUTED, 500))
    b.append(footer(W, H, "Publish version 4"))
    svg("step-6-publish.svg", W, H, "".join(b), bg=BG)


# ================================================================ 9. explore
def explore():
    W, H = 1240, 680
    f, top = frame(W, H, "prooflix / insightiq / objects / customer / 10442", "Objects")
    b = [f]
    lx = 48
    # breadcrumb + header
    b.append(t(lx, top + 30, "Objects  ›  Customers  ›", 12.5, MUTED, 500))
    b.append(f'<circle cx="{lx + 34}" cy="{top + 82}" r="32" fill="url(#iq)"/>' + t(lx + 34, top + 90, "DC", 20, "#fff", 800, "middle"))
    b.append(t(lx + 82, top + 78, "Dana Cohen", 24, INK, 800) + mono(lx + 82, top + 100, "Customer:10442", 12.5, MUTED))
    bd, bw = badge(lx + 210, top + 89, "bronze")
    b.append(bd)
    p, _ = pill(lx + 220 + bw, top + 89, "v4", "#DCFCE7", "#166534")
    b.append(p)
    kp = [("City", "Haifa"), ("Balance", "18,240.50 ₪"), ("National ID", "0•••••••4"), ("Accounts", "3")]
    for i, (k, v) in enumerate(kp):
        x = lx + 470 + i * 160
        b.append(t(x, top + 70, k, 11.5, MUTED, 600) + t(x, top + 94, v, 15, INK, 700))
    b.append(rect(lx + 1040, top + 64, 104, 34, CARD, "#CBD5E1", 8) + t(lx + 1092, top + 86, "Actions ▾", 13, INK, 600, "middle"))
    # tabs
    ty = top + 136
    b.append(f'<line x1="{lx}" y1="{ty + 14}" x2="{W - 48}" y2="{ty + 14}" stroke="{LINE}"/>')
    x = lx
    for tab in ["Properties", "Links (3)", "History", "Actions"]:
        w = len(tab) * 7.8 + 24
        on = tab.startswith("Links")
        b.append(t(x + w / 2, ty + 2, tab, 13.5, "#6D28D9" if on else MUTED, 700 if on else 500, "middle"))
        if on:
            b.append(f'<rect x="{x}" y="{ty + 12}" width="{w}" height="3" rx="1.5" fill="url(#iqh)"/>')
        x += w + 12
    # links table
    y0 = ty + 36
    b.append(section(lx, y0, 560, 330, "accounts → Account", "silver · cleaned · 3 linked objects"))
    hdr = ["Account", "Type", "Balance", "Opened"]
    hx = [0, 150, 270, 400]
    for h, xx in zip(hdr, hx):
        b.append(t(lx + 22 + xx, y0 + 80, h, 11.5, MUTED, 700))
    rows = [("2201-778", "Checking", "18,240 ₪", "2014-03-02"), ("2201-913", "Savings", "102,500 ₪", "2018-07-19"), ("2207-055", "Credit", "−3,120 ₪", "2023-01-11")]
    for i, r in enumerate(rows):
        yy = y0 + 110 + i * 44
        b.append(rect(lx + 14, yy - 24, 532, 38, BG if i % 2 == 0 else CARD, "none", 8, 0))
        b.append(mono(lx + 22, yy, r[0], 12.5, "#6D28D9", 700) + t(lx + 172, yy, r[1], 12.5, INK) + t(lx + 292, yy, r[2], 12.5, INK if not r[2].startswith("−") else BAD, 600) + t(lx + 422, yy, r[3], 12.5, MUTED))
    b.append(t(lx + 22, y0 + 270, "payments → Payment (draft, not published yet)", 12, MUTED, 500))
    b.append(t(lx + 22, y0 + 300, "Open these 3 as an object set  →", 12.5, "#6D28D9", 700))
    # graph
    gx, gw = lx + 580, 270
    b.append(section(gx, y0, gw, 330, "Graph", "expand one hop at a time"))
    ccx, ccy = gx + 70, y0 + 190
    pts = [(gx + 190, y0 + 100), (gx + 200, y0 + 190), (gx + 190, y0 + 280)]
    for (ax, ay) in pts:
        b.append(f'<line x1="{ccx}" y1="{ccy}" x2="{ax}" y2="{ay}" stroke="#C4B5FD" stroke-width="2"/>')
    for k, (ax, ay) in enumerate(pts):
        b.append(f'<circle cx="{ax}" cy="{ay}" r="18" fill="#E0E7FF" stroke="#fff" stroke-width="3"/>' + t(ax, ay + 4, "A", 12, INDIGO, 700, "middle"))
        if k == 1:
            for dx, dy in ((48, -26), (54, 0), (48, 26)):
                b.append(f'<line x1="{ax + 16}" y1="{ay}" x2="{ax + dx - 8}" y2="{ay + dy}" stroke="#E2E8F0" stroke-width="1.5"/><circle cx="{ax + dx}" cy="{ay + dy}" r="7" fill="#FEF9C3" stroke="#EAB308"/>')
    b.append(f'<circle cx="{ccx}" cy="{ccy}" r="28" fill="url(#iq)" stroke="#fff" stroke-width="3"/>' + t(ccx, ccy + 5, "DC", 14, "#fff", 800, "middle"))
    b.append(t(gx + 18, y0 + 314, "● transactions (gold), 214 more", 11, "#854D0E", 500))
    # AI assist card
    ax0, aw = lx + 870, 274
    b.append(f'<g filter="url(#sh2)">{rect(ax0, y0, aw, 330, CARD, "#DDD6FE", 14, 1.5)}</g>')
    b.append(f'<circle cx="{ax0 + 26}" cy="{y0 + 28}" r="12" fill="url(#iq)"/>' + t(ax0 + 26, y0 + 32, "✦", 11, "#fff", 700, "middle"))
    b.append(t(ax0 + 46, y0 + 33, "AI Assist", 14, INK, 700))
    b.append(rect(ax0 + 40, y0 + 52, aw - 56, 56, "#F1F5F9", "none", 12, 0))
    b.append(t(ax0 + 54, y0 + 74, "Which of Dana's accounts had", 12, INK) + t(ax0 + 54, y0 + 92, "transactions over 10,000 ₪?", 12, INK))
    tools = ["list_links(Customer:10442, accounts)", "search_objects(Transaction, …)"]
    for i, tl in enumerate(tools):
        b.append(rect(ax0 + 16, y0 + 122 + i * 30, aw - 32, 24, "#FAF5FF", "#E9D5FF", 6) + mono(ax0 + 26, y0 + 138 + i * 30, tl, 10, "#6D28D9"))
    b.append(t(ax0 + 16, y0 + 210, "Two accounts:", 12.5, INK, 600))
    for i, (num, n) in enumerate([("2201-913", "4 transactions"), ("2201-778", "1 transaction")]):
        b.append(rect(ax0 + 16, y0 + 222 + i * 34, aw - 32, 28, CARD, LINE, 8) + mono(ax0 + 28, y0 + 241 + i * 34, num, 11.5, "#6D28D9", 700) + t(ax0 + aw - 28, y0 + 241 + i * 34, n, 11.5, MUTED, 500, "end"))
    b.append(t(ax0 + 16, y0 + 314, "as you: same permissions and masking", 10.5, MUTED, 500))
    svg("explore-object.svg", W, H, "".join(b), bg=BG)


for fn in (overview, layers, wizard_steps, model_home, step1, step2, step4, step6, explore):
    fn()
print("ok", sorted(p.name for p in OUT.iterdir()))

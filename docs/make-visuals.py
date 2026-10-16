"""Generates Payback's README visuals: hero.svg (animated), pane.svg (sample data) and social.svg, the source of
social-preview.png (1280x640; render it with a browser and upload it under Settings, Social preview).
Usage: python docs/make-visuals.py docs
Plain SVG with system fonts and inline CSS only: GitHub serves README images through a sandbox that drops scripts,
external stylesheets and web fonts, so everything here is self-contained."""
import sys
from xml.sax.saxutils import escape as esc

OUT = sys.argv[1]
BG, PANEL, HAIR, MUTED, TEXT = '#0D1117', '#161B22', '#262B33', '#7D8590', '#E6EDF3'
GOLD, GREEN, AMBER, DARK = '#F2C46D', '#3DD68C', '#E3B341', '#0D1117'
KIND = dict(coding='#58A6FF', devops='#9DA5FF', research='#FFA657', documents='#56D4DD', questions='#C9D1D9', other='#7D8590')
MONO = "ui-monospace, SFMono-Regular, 'Cascadia Code', Menlo, Consolas, 'Liberation Mono', monospace"
SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"


def t(x, y, s, fill=TEXT, size=13, weight=400, anchor='start', font=MONO, extra=''):
    return f'<text x="{x}" y="{y}" fill="{fill}" font-size="{size}" font-weight="{weight}" text-anchor="{anchor}" font-family="{font}" {extra}>{esc(s)}</text>'


def rect(x, y, w, h, fill, rx=0, stroke=None, extra=''):
    s = f' stroke="{stroke}"' if stroke else ''
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}"{s} {extra}/>'


def chip(x, y, w, label, on=False, h=26):
    return rect(x, y, w, h, GOLD if on else HAIR, 6) + t(x + w / 2, y + 17.5, label, DARK if on else TEXT, 13, 700 if on else 400, 'middle')


def chart_bars(x0, base, slot, bar_w, max_h, values, labels, current, animate, label_y):
    top = max(values)
    out = []
    for i, (v, lab) in enumerate(zip(values, labels)):
        cx = x0 + slot * i + slot / 2
        h = max(3, v / top * max_h) if v else 3
        fill = GOLD if i == current else (TEXT if v else HAIR)
        cls = f' class="bar" style="animation-delay:{0.15 + i * 0.09:.2f}s"' if animate else ''
        out.append(f'<rect x="{cx - bar_w / 2:.1f}" y="{base - h:.1f}" width="{bar_w}" height="{h:.1f}" rx="4" fill="{fill}"{cls}/>')
        out.append(t(f'{cx:.1f}', label_y, lab, GOLD if i == current else MUTED, 12, 700 if i == current else 400, 'middle'))
    return ''.join(out)


# ------------------------------------------------------------------ hero

def hero(w=1200, h=420, animate=True):
    css = ''
    if animate:
        css = ('<style>'
               '.bar{transform-box:fill-box;transform-origin:50% 100%;animation:grow .9s cubic-bezier(.2,.8,.2,1) both}'
               '.rule{transform-box:fill-box;transform-origin:0 50%;animation:draw 1s cubic-bezier(.2,.8,.2,1) both}'
               '@keyframes grow{from{transform:scaleY(0)}to{transform:scaleY(1)}}'
               '@keyframes draw{from{transform:scaleX(0)}to{transform:scaleX(1)}}'
               '@media (prefers-reduced-motion:reduce){*{animation:none!important}}'
               '</style>')
    rise = lambda d: ''  # text never animates: a viewer that freezes the first frame must still show it
    p = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" role="img" aria-label="Payback: see what Claude did for you, and what it was worth">',
         '<title>Payback</title>', css,
         '<defs><radialGradient id="glow" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(160 40) rotate(40) scale(620 420)">'
         f'<stop stop-color="{GOLD}" stop-opacity=".16"/><stop offset="1" stop-color="{GOLD}" stop-opacity="0"/></radialGradient></defs>',
         rect(0.5, 0.5, w - 1, h - 1, BG, 20, HAIR), rect(0.5, 0.5, w - 1, h - 1, 'url(#glow)', 20)]
    # Title block
    p.append(f'<g{rise(0)}>' + t(64, 148, 'PAYBACK', TEXT, 72, 800, font=SANS, extra='textLength="430" lengthAdjust="spacing"') + '</g>')
    p.append(rect(64, 172, 430, 4, GOLD, 2, extra='class="rule"' if animate else ''))
    p.append(rect(494, 173, 150, 2, HAIR))
    p.append(f'<g{rise(0.25)}>' + t(64, 228, 'See what Claude did for you', TEXT, 30, 600, font=SANS)
             + t(64, 266, 'and what it was worth.', GOLD, 30, 600, font=SANS)
             + t(64, 304, 'tasks · lines · commits · tests · tokens', MUTED, 15) + '</g>')
    p.append(f'<g{rise(0.45)}>' + chip(64, 332, 96, '/payback', True, 30).replace('y="349.5"', 'y="351.5"')
             + chip(172, 332, 150, 'Claude Code plugin', False, 30) + chip(334, 332, 88, 'GPL-3.0', False, 30) + '</g>')
    # Right: the summary card
    cx, cy, cw, ch = 704, 52, 432, 316
    p.append(rect(cx, cy, cw, ch, PANEL, 16, HAIR))
    p.append(f'<g{rise(0.3)}>' + t(cx + 28, cy + 40, 'HOURS SAVED THIS WEEK', MUTED, 12, 700)
             + t(cx + 28, cy + 96, '38.4', TEXT, 58, 800, font=SANS) + t(cx + 168, cy + 96, 'h', MUTED, 28, 600, font=SANS)
             + t(cx + cw - 28, cy + 40, 'estimate', MUTED, 12, 400, 'end')
             + t(cx + cw - 28, cy + 96, '73 tasks', GREEN, 18, 700, 'end') + '</g>')
    p.append(chart_bars(cx + 28, cy + 262, 53.7, 34, 120, [3, 1, 14, 17, 12, 16, 10], ['Sa', 'Su', 'Mo', 'Tu', 'We', 'Th', 'Fr'], 6, animate, cy + 292))
    p.append(rect(cx + 28, cy + 264, cw - 56, 1, HAIR))
    p.append('</svg>')
    return ''.join(p)


# ------------------------------------------------------------------ the pane, sample data

def pane():
    W, X0, X1 = 1000, 24, 976
    p, y = [], 0
    add = p.append
    # title, rule
    add(t(X0, 56, 'WEEK', TEXT, 20, 800, font=SANS, extra='letter-spacing="1"'))
    add(t(X1, 56, '10 Oct – 16 Oct 2026', MUTED, 14, 400, 'end'))
    add(rect(X0, 68, 66, 3, GOLD, 1.5) + rect(X0 + 66, 69, X1 - X0 - 66, 1, HAIR))
    # tabs
    add(chip(X0, 90, 64, 'Today') + chip(X0 + 72, 90, 60, 'Week', True) + chip(X0 + 140, 90, 64, 'Month') + chip(X0 + 212, 90, 56, 'Year'))
    add(chip(X1 - 72, 90, 32, '$') + chip(X1 - 32, 90, 32, '€', True))
    add(t(X0, 143, 'Started by', MUTED, 13) + chip(X0 + 92, 126, 44, 'All', True) + chip(X0 + 144, 126, 48, 'You') + chip(X0 + 200, 126, 48, 'SDK')
        + t(X0 + 264, 143, 'You 61 · SDK 12', MUTED, 13))
    # tiles
    tw = (X1 - X0 - 24) / 3
    for i, (lab, val, foot) in enumerate([('HOURS SAVED', '38.4 h', 'estimate'), ('TASKS DONE', '73', '7 active days'), ('WORTH IN EUROS', '1.920 €', 'estimate at 50 €/h')]):
        x = X0 + i * (tw + 12)
        add(rect(x, 164, tw, 108, BG, 12, HAIR) + t(x + 18, 190, lab, MUTED, 12) + t(x + 18, 236, val, TEXT, 40, 800, font=SANS) + t(x + 18, 260, foot, MUTED, 12))
    # chart
    def heading(y, title):
        return t(X0, y, title, MUTED, 12, 700) + rect(X0 + len(title) * 8 + 12, y - 4, X1 - X0 - len(title) * 8 - 12, 1, HAIR)
    add(heading(304, 'TASKS BY DAY'))
    add(chart_bars(X0, 408, (X1 - X0) / 7, 40, 80, [3, 1, 14, 17, 12, 16, 10], ['Sa', 'Su', 'Mo', 'Tu', 'We', 'Th', 'Fr'], 6, False, 430))
    add(t(X0, 462, 'Streak: 7 days in a row', GREEN, 13))
    # cards
    def card(x, y, w, h, title):
        return rect(x + .5, y + .5, w - 1, h - 1, BG, 12, HAIR) + t(x + 16, y + 28, title.upper(), MUTED, 12, 700)

    LW, RX = 420, X0 + 432
    RW = X1 - RX
    # time
    cy = 492
    add(card(X0, cy, LW, 214, 'Where the time went'))
    rows = [('Coding', 'coding', 31, '24.0'), ('DevOps & shell', 'devops', 14, '4.7'), ('Research', 'research', 11, '4.6'), ('Documents', 'documents', 7, '3.5'),
            ('Questions & planning', 'questions', 8, '1.3'), ('Other', 'other', 2, '0.3')]
    for i, (lab, k, n, hrs) in enumerate(rows):
        ry = cy + 56 + i * 26
        add(t(X0 + 16, ry, lab, TEXT, 13) + rect(X0 + 178, ry - 10, 88, 10, HAIR, 3) + rect(X0 + 178, ry - 10, max(4, n / 31 * 88), 10, KIND[k], 3)
            + t(X0 + LW - 16, ry, f'{n} tasks · {hrs} h', TEXT, 13, 400, 'end'))
    # models
    my = cy + 214 + 12
    add(card(X0, my, LW, 148, 'Models and tokens'))
    cols = [(208, 'Tasks'), (272, 'In'), (334, 'Out'), (LW - 16, 'Cached')]
    for cxp, lab in cols:
        add(t(X0 + cxp, my + 52, lab, MUTED, 12, 400, 'end'))
    for i, row in enumerate([('Opus 5.5', '54', '3.1M', '94k', '97%', TEXT), ('Sonnet 5.5', '19', '1.2M', '41k', '95%', TEXT), ('Haiku judge', '31', '22k', '0.1k', '-', MUTED)]):
        ry = my + 78 + i * 24
        add(t(X0 + 16, ry, row[0], row[5], 13))
        for (cxp, _), v in zip(cols, row[1:5]):
            add(t(X0 + cxp, ry, v, row[5], 13, 400, 'end'))
    # code
    add(card(RX, cy, RW, 278, 'Code'))
    kv = [('Lines', [('+4,820', GREEN), ('   −1,310  ·  38 files', MUTED)]),
          ('Languages', [('TypeScript 62% · Python 24% · CSS 9%', TEXT)]),
          ('Git', [('19 commits · 6 pushes · 2 merges', TEXT)]),
          ('GitHub', [('3 PRs opened · 2 merged · 4 issues closed', TEXT)]),
          ('Tests', [('22 runs · ', TEXT), ('95% pass', GREEN), (' · 4m 12s', MUTED)]),
          ('Results', [('1,284 passed', GREEN), ('   9 failed', AMBER)]),
          ('Builds', [('11 runs · ', TEXT), ('1 failed', AMBER)]),
          ('Task types', [('Feature 12 · Bugfix 9 · Refactor 5 · other 5', TEXT)]),
          ('Sizes', [('S 11 · M 15 · L 5', MUTED)])]
    for i, (lab, segs) in enumerate(kv):
        ry = cy + 56 + i * 24
        spans = ''.join(f'<tspan fill="{c}">{esc(s)}</tspan>' for s, c in segs)
        add(t(RX + 16, ry, lab, MUTED, 13) + f'<text x="{RX + 112}" y="{ry}" font-size="13" font-family="{MONO}" xml:space="preserve">{spans}</text>')
    H = my + 148 + 32
    add(t(X0, H - 8, 'Hours and money are estimates. /payback settings changes them.', MUTED, 12))
    H += 12
    head = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" '
            'aria-label="The Payback pane on the Week tab: 73 tasks, 38.4 hours saved, a chart of tasks per day, time per kind of task, models and tokens, and code, git and test statistics (sample data)">'
            '<title>Payback pane (sample data)</title>' + rect(0.5, 0.5, W - 1, H - 1, BG, 16, HAIR))
    return head + ''.join(p) + '</svg>'


# ------------------------------------------------------------------ social preview (1280x640), static

def social():
    inner = hero(animate=False).replace('width="1200" height="420"', 'width="1200" height="420" x="40" y="96"', 1)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 640" width="1280" height="640">'
            + rect(0, 0, 1280, 640, '#090C10') + inner
            + t(640, 590, 'github.com/michaelSelbertinger/payback', MUTED, 22, 400, 'middle') + '</svg>')


for name, svg in (('hero.svg', hero()), ('pane.svg', pane()), ('social.svg', social())):
    open(f'{OUT}/{name}', 'w', encoding='utf-8', newline='\n').write(svg)
    print(name, len(svg) // 1024, 'KB')

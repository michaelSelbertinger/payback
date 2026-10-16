"""Generates Payback's README visuals: hero.svg (animated) and social.svg, the source of
social-preview.png (1280x640; render it with a browser and upload it under Settings, Social preview).
Usage: python docs/make-visuals.py docs
(docs/pane.svg is drawn by docs/make-pane.cjs, from the mod's own drawing code.)
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
             + chip(172, 332, 136, 'Claude Code mod', False, 30) + chip(320, 332, 88, 'GPL-3.0', False, 30) + '</g>')
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


# ------------------------------------------------------------------ social preview (1280x640), static

def social():
    inner = hero(animate=False).replace('width="1200" height="420"', 'width="1200" height="420" x="40" y="96"', 1)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 640" width="1280" height="640">'
            + rect(0, 0, 1280, 640, '#090C10') + inner
            + t(640, 590, 'github.com/michaelSelbertinger/payback', MUTED, 22, 400, 'middle') + '</svg>')


for name, svg in (('hero.svg', hero()), ('social.svg', social())):
    open(f'{OUT}/{name}', 'w', encoding='utf-8', newline='\n').write(svg)
    print(name, len(svg) // 1024, 'KB')

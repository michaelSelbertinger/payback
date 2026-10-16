// The pane's body (tiles, chart, cards) drawn as one SVG, for wide desktop panes.
// Text rows in the desktop's type leave uneven gaps and cannot round a corner or print a big numeral cleanly;
// a picture lays out exactly as written. It carries its own dark background, so it reads in a light app theme too.
import type { Counter, Kind, Settings } from '../types'
import {
  DEV_KINDS, KINDS, KIND_LABEL, SIZES, fit, fmtCompact, fmtDuration, fmtHours, fmtInt, fmtMoney, minutesSaved, modelName, taskCount,
} from './stats'
import type { View } from './stats'
import { C, KIND_COLOR } from './theme'

const MONO = "ui-monospace, SFMono-Regular, 'Cascadia Code', Menlo, Consolas, 'Liberation Mono', monospace"
const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"
/** Pixels one character takes at 13px, with room for whichever monospace font the machine falls back to. */
const CHAR = 8

/** Widest the picture is drawn; a wider pane leaves the rest empty rather than stretching the type. */
export const DASHBOARD_MAX = 1200
/** Pixels one pane column takes, as the desktop lays out its monospace type. */
const COLUMN_PX = 7.8
/** Narrowest picture that still lays out cleanly (tiles, the model table), about 62 pane columns. */
export const MIN_WIDTH = 484
const PAD = 28
const GAP = 14
const ROW = 24

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

type Style = { fill?: string; size?: number; weight?: number; anchor?: 'start' | 'middle' | 'end'; font?: string }
const text = (x: number, y: number, s: string, { fill = C.text, size = 13, weight = 400, anchor = 'start', font = MONO }: Style = {}) =>
  `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" fill="${fill}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}" font-family="${font}">${esc(s)}</text>`
const box = (x: number, y: number, w: number, h: number, fill: string, rx = 0, stroke?: string) =>
  `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="${rx}" fill="${fill}"${stroke ? ` stroke="${stroke}"` : ''}/>`

type Span = [text: string, color?: string]
/** Coloured parts of one line, laid out as one run of text. */
const spans = (x: number, y: number, parts: Span[], size = 13) =>
  `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="${size}" font-family="${MONO}" xml:space="preserve">${parts.map(([t, c]) => `<tspan fill="${c ?? C.text}">${esc(t)}</tspan>`).join('')}</text>`

/** Items joined with " · ", broken into lines no wider than `chars`. */
function wrapItems(items: string[], chars: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const item of items) {
    const next = line ? `${line} · ${item}` : item
    if (line && next.length > chars) {
      lines.push(line)
      line = item
    } else line = next
  }
  if (line) lines.push(line)
  return lines
}

const plural = (x: number, one: string, many = `${one}s`) => `${fmtInt(x)} ${x === 1 ? one : many}`

type Card = { h: number; svg: (x: number, y: number, w: number) => string }

/** A rounded card with a muted title and `lines` rows below it; `draw` paints them given the card's left edge, first baseline and width. */
function card(title: string, lines: number, draw: (x: number, y: number, w: number) => string): Card {
  const h = 52 + lines * ROW
  return {
    h,
    svg: (x, y, w) => box(x + 0.5, y + 0.5, w - 1, h - 1, C.dark, 12, C.hair) + text(x + 18, y + 31, title.toUpperCase(), { fill: C.muted, size: 12, weight: 700 }) + draw(x, y + 58, w),
  }
}

/** The body of the pane as an SVG document, and a description of it for a reader that cannot see it. */
export function dashboardSvg(v: View, s: Settings, columns = 160): { source: string; alt: string; width: number; height: number; body: string } {
  // Drawn at about the pane's own pixel width, so type keeps its size; two columns of cards once there is room for them.
  const W = Math.min(DASHBOARD_MAX, Math.max(MIN_WIDTH, Math.round(columns * COLUMN_PX)))
  const isTwo = W >= 1000
  const CW = W - 2 * PAD
  const d = v.total
  const n = (k: Counter) => d.n?.[k] ?? 0
  const out: string[] = []
  let y = PAD

  // Tiles
  const minutes = minutesSaved(d, s)
  const hours = fmtHours(minutes)
  const amount = (minutes / 60) * s.rate
  const tw = (CW - 2 * GAP) / 3
  const tiles: [string, string, string][] = [
    ['HOURS SAVED', `${hours} h`, 'estimate'],
    ['TASKS DONE', fmtInt(taskCount(d)), plural(v.activeDays, 'active day')],
    [s.currency === 'eur' ? 'WORTH IN EUROS' : "DOLLARS' WORTH", fmtMoney(amount, s.currency), `estimate at ${fmtMoney(s.rate, s.currency)}/h`],
  ]
  const rate = `at ${fmtMoney(s.rate, s.currency)}/h` // the shorter caption, when the full one will not fit a narrow tile
  const pad = tw > 260 ? 22 : 14
  tiles.forEach(([label, value, foot], i) => {
    const x = PAD + i * (tw + GAP)
    const room = tw - 2 * pad
    const size = Math.max(16, Math.min(44, Math.floor(room / (value.length * 0.6)))) // a long number shrinks rather than overflows
    out.push(box(x + 0.5, y + 0.5, tw - 1, 115, C.dark, 12, C.hair), text(x + pad, y + 32, fit(label, Math.floor(room / 7.3)), { fill: C.muted, size: 12, weight: 600 }))
    out.push(text(x + pad, y + 46 + size * 0.76, value, { size, weight: 800, font: SANS }), text(x + pad, y + 102, foot.length > Math.floor(room / 7.4) && i === 2 ? rate : fit(foot, Math.floor(room / 7.4)), { fill: C.muted, size: 12 }))
  })
  y += 116 + 30

  // Chart: a bar per day (or month), its count above it, its label below
  out.push(text(PAD, y, v.tab === 'year' ? 'TASKS BY MONTH' : 'TASKS BY DAY', { fill: C.muted, size: 12, weight: 700 }))
  const headW = (v.tab === 'year' ? 14 : 12) * 8 + 14
  out.push(box(PAD + headW, y - 4, CW - headW, 1, C.hair))
  const plotH = 112
  const base = y + 36 + plotH
  const buckets = v.chart
  const slot = CW / buckets.length
  const barW = Math.min(46, slot * 0.62)
  const top = Math.max(1, ...buckets.map(b => b.value))
  const every = buckets.length > 12 ? 5 : 1
  buckets.forEach((b, i) => {
    const cx = PAD + slot * i + slot / 2
    const h = b.isFuture ? 0 : b.value > 0 ? Math.max(4, (b.value / top) * plotH) : 2
    if (!b.isFuture) out.push(box(cx - barW / 2, base - h, barW, h, b.isCurrent ? C.gold : b.value > 0 ? C.text : C.hair, 4))
    if (!b.isFuture && b.value > 0 && slot >= 24) out.push(text(cx, base - h - 7, String(b.value), { fill: b.isCurrent ? C.gold : C.muted, size: 12, anchor: 'middle' }))
    if ((buckets.length - 1 - i) % every === 0) out.push(text(cx, base + 22, b.label, { fill: b.isCurrent ? C.gold : C.muted, size: 12, weight: b.isCurrent ? 700 : 400, anchor: 'middle' }))
  })
  y = base + 22 + 30
  out.push(text(PAD, y, v.summary, { fill: C.green }))
  y += 38

  // Cards
  const kindMinutes = (k: Kind) =>
    k === 'coding' ? SIZES.reduce((a, z) => a + (d.sizes?.[z] ?? 0) * s.sizes[z], 0) : (d.tasks?.[k] ?? 0) * s.minutes[k]
  const kinds = KINDS.filter(k => (d.tasks?.[k] ?? 0) > 0)
  const maxKind = Math.max(1, ...kinds.map(k => d.tasks?.[k] ?? 0))
  const timeCard = card('Where the time went', Math.max(1, kinds.length), (x, ry, w) => {
    if (kinds.length === 0) return text(x + 18, ry, 'No finished tasks in this stretch.', { fill: C.muted })
    const labelW = 188
    const numbers = 178
    const barLen = w - 36 - labelW - numbers
    return kinds
      .map((k, i) => {
        const count = d.tasks?.[k] ?? 0
        const at = ry + i * ROW + 2
        const bar = kinds.length > 1 && barLen >= 40 ? box(x + 18 + labelW, at - 10, barLen, 10, C.hair, 3) + box(x + 18 + labelW, at - 10, Math.max(4, (count / maxKind) * barLen), 10, KIND_COLOR[k], 3) : ''
        return text(x + 18, at, KIND_LABEL[k]) + bar + text(x + w - 18, at, `${plural(count, 'task')} · ${fmtHours(kindMinutes(k))} h`, { anchor: 'end' })
      })
      .join('')
  })

  const models = [...new Set([...Object.keys(d.models ?? {}), ...Object.keys(d.tokens ?? {})])].sort(
    (a, b) => (d.models?.[b] ?? 0) - (d.models?.[a] ?? 0) || (d.tokens?.[b]?.out ?? 0) - (d.tokens?.[a]?.out ?? 0),
  )
  const judge = n('judgeCalls') > 0
  const modelRows = models.length + (judge ? 1 : 0) + (judge && n('judgeFails') > 0 ? 1 : 0)
  const modelCard = card('Models and tokens', Math.max(1, modelRows + 1), (x, ry, w) => {
    if (modelRows === 0) return text(x + 18, ry, 'No model use in this stretch.', { fill: C.muted })
    const col = 80
    const cachedX = x + w - 18
    const outX = cachedX - col
    const inX = outX - col
    const tasksX = inX - col
    const nameChars = Math.floor((tasksX - 40 - (x + 18)) / CHAR)
    const head = [['Tasks', tasksX], ['In', inX], ['Out', outX], ['Cached', cachedX]] as const
    const parts: string[] = head.map(([label, px]) => text(px, ry, label, { fill: C.muted, size: 12, anchor: 'end' }))
    const rowAt = (i: number) => ry + 26 + i * ROW
    let i = 0
    for (const id of models) {
      const t = d.tokens?.[id] ?? {}
      const input = (t.in ?? 0) + (t.cacheRead ?? 0) + (t.cacheWrite ?? 0)
      const cached = input > 0 ? `${Math.round(((t.cacheRead ?? 0) / input) * 100)}%` : '-'
      parts.push(text(x + 18, rowAt(i), fit(modelName(id), nameChars)))
      for (const [val, px] of [[String(d.models?.[id] ?? 0), tasksX], [fmtCompact(input), inX], [fmtCompact(t.out ?? 0), outX], [cached, cachedX]] as const) parts.push(text(px, rowAt(i), val, { anchor: 'end' }))
      i++
    }
    if (judge) {
      const input = n('judgeIn') + n('judgeCacheRead') + n('judgeCacheWrite')
      parts.push(text(x + 18, rowAt(i), 'Haiku judge', { fill: C.muted }))
      for (const [val, px] of [[fmtInt(n('judgeCalls')), tasksX], [fmtCompact(input), inX], [fmtCompact(n('judgeOut')), outX], ['-', cachedX]] as const) parts.push(text(px, rowAt(i), val, { fill: C.muted, anchor: 'end' }))
      i++
      if (n('judgeFails') > 0) parts.push(text(x + 18, rowAt(i), `${plural(n('judgeFails'), 'judge call')} failed`, { fill: C.amber }))
    }
    return parts.join('')
  })

  // Code rows: a label, then the value (several lines when it is long)
  type Row = { label: string; lines?: Span[][]; items?: string[] }
  const rows: Row[] = []
  const list = (pairs: [number, string, string?][]) => pairs.filter(([x]) => x > 0).map(([x, one, many]) => plural(x, one, many))
  if (n('linesAdded') + n('linesRemoved') > 0 || n('files') > 0)
    rows.push({ label: 'Lines', lines: [[[`+${fmtInt(n('linesAdded'))}`, C.green], ['   '], [`−${fmtInt(n('linesRemoved'))}`, C.muted], [`   ·   ${plural(n('files'), 'file')}`, C.muted]]] })
  const langs = Object.entries(d.langs ?? {}).sort((a, b) => b[1] - a[1])
  const langTotal = langs.reduce((a, [, x]) => a + x, 0)
  const textRow = (label: string, items: string[]) => {
    if (items.length > 0) rows.push({ label, items })
  }
  textRow('Languages', langs.slice(0, 4).map(([l, x]) => `${l} ${Math.round((x / Math.max(1, langTotal)) * 100)}%`))
  textRow('Git', list([[n('commits'), 'commit'], [n('pushes'), 'push', 'pushes'], [n('merges'), 'merge'], [n('rebases'), 'rebase'], [n('branches'), 'branch', 'branches']]))
  textRow('GitHub', list([[n('prsOpened'), 'PR opened', 'PRs opened'], [n('prsMerged'), 'PR merged', 'PRs merged'], [n('issuesOpened'), 'issue opened', 'issues opened'], [n('issuesClosed'), 'issue closed', 'issues closed']]))
  if (n('testRuns') > 0) {
    const pass = Math.round(((n('testRuns') - n('testFails')) / n('testRuns')) * 100)
    rows.push({ label: 'Tests', lines: [[[`${plural(n('testRuns'), 'run')} · `], [`${pass}% pass`, pass >= 90 ? C.green : C.amber], [` · ${fmtDuration(n('testMs'))}`, C.muted]]] })
    if (n('testsPassed') + n('testsFailed') > 0)
      rows.push({ label: 'Results', lines: [[[`${fmtInt(n('testsPassed'))} passed`, C.green], ['   '], [`${fmtInt(n('testsFailed'))} failed`, n('testsFailed') > 0 ? C.amber : C.muted]]] })
  }
  if (n('builds') > 0) rows.push({ label: 'Builds', lines: [[[`${plural(n('builds'), 'run')} · `], [`${fmtInt(n('buildFails'))} failed`, n('buildFails') > 0 ? C.amber : C.muted]]] })
  if ((d.tasks?.coding ?? 0) > 0) {
    const types = DEV_KINDS.filter(k => (d.dev?.[k] ?? 0) > 0).sort((a, b) => (d.dev?.[b] ?? 0) - (d.dev?.[a] ?? 0))
    if (types.length > 0) textRow('Task types', types.map(k => `${k[0]!.toUpperCase()}${k.slice(1)} ${d.dev?.[k]}`))
    else rows.push({ label: 'Task types', lines: [[[s.judge ? 'not judged yet' : 'judge is off', C.muted]]] })
    rows.push({ label: 'Sizes', lines: [[[SIZES.map(z => `${z.toUpperCase()} ${d.sizes?.[z] ?? 0}`).join(' · '), C.muted]]] })
  }
  const hasCode = rows.length > 0 || (d.tasks?.coding ?? 0) > 0

  const LEFT = isTwo ? Math.round(CW * 0.472) : CW
  const RIGHT = isTwo ? CW - GAP - LEFT : CW
  const codeChars = Math.floor((RIGHT - 36 - 112) / CHAR)
  const laid = rows.map(r => ({ label: r.label, lines: r.items ? wrapItems(r.items, codeChars).map((t): Span[] => [[t]]) : (r.lines ?? []) }))
  const codeLines = laid.reduce((a, r) => a + r.lines.length, 0)
  const codeCard = card('Code', Math.max(1, codeLines), (x, ry, w) => {
    if (laid.length === 0) return text(x + 18, ry, 'No code work in this stretch.', { fill: C.muted })
    let line = 0
    return laid
      .map(r =>
        r.lines
          .map((parts, i) => {
            const at = ry + line++ * ROW
            return (i === 0 ? text(x + 18, at, r.label, { fill: C.muted }) : '') + spans(x + 130, at, parts)
          })
          .join(''),
      )
      .join('')
  })

  const colLeft = !isTwo ? [timeCard, ...(hasCode ? [codeCard] : []), modelCard] : hasCode ? [timeCard, modelCard] : [timeCard]
  const colRight = !isTwo ? [] : hasCode ? [codeCard] : [modelCard]
  const stack = (cards: Card[], x: number, w: number) => {
    let cy = y
    for (const c of cards) {
      out.push(c.svg(x, cy, w))
      cy += c.h + GAP
    }
    return cy - GAP
  }
  const bottom = Math.max(stack(colLeft, PAD, LEFT), colRight.length > 0 ? stack(colRight, PAD + LEFT + GAP, RIGHT) : 0)
  y = bottom + 30
  out.push(text(PAD, y, W < 600 ? 'All estimates. /payback settings changes them.' : 'Hours and money are estimates. /payback settings changes them.', { fill: C.muted, size: 12 }))
  const H = y + PAD - 6

  const alt =
    `Payback, ${v.title.toLowerCase()}: ${fmtInt(taskCount(d))} tasks, ${hours} hours saved, ${fmtMoney(amount, s.currency)} (estimates). ` +
    (kinds.length > 0 ? kinds.map(k => `${KIND_LABEL[k]} ${d.tasks?.[k]}`).join(', ') + '. ' : '') +
    v.summary
  const body = out.join('')
  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">` +
    box(0.5, 0.5, W - 1, H - 1, C.dark, 16, C.hair) +
    body +
    '</svg>'
  // `body` is the drawing without its frame, in the picture's own coordinates: docs/make-pane.cjs sets it under a header for the README.
  return { source, alt, width: W, height: H, body }
}

// Draws docs/pane.svg: the Month tab with invented sample data.
// The body is Payback's own drawing code (hooks/dashboard.ts), so the picture shows what the pane really draws;
// only the header above it (title, tabs, filter) is redrawn here, because in the app those are real buttons.
//
// Build the plugin's pure modules once, then run this with the build folder:
//   npx -p typescript tsc --outDir build --rootDir . --module commonjs --target es2022 --lib es2023 --skipLibCheck hooks/stats.ts hooks/dashboard.ts hooks/theme.ts
//   node docs/make-pane.cjs build docs
const fs = require('fs')
const path = require('path')

const [build, out] = process.argv.slice(2)
if (!build || !out) throw new Error('usage: node docs/make-pane.cjs <build folder> <output folder>')
const { dayKey, daysBack, view, withDefaults } = require(path.resolve(build, 'hooks/stats.js'))
const { dashboardSvg } = require(path.resolve(build, 'hooks/dashboard.js'))
const { C } = require(path.resolve(build, 'hooks/theme.js'))

// ---------------------------------------------------------------- sample data: a heavy month of use, a pinch of SDK work

let seed = 20261016
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const between = (a, b) => Math.floor(a + rand() * (b - a + 1))
const pick = table => {
  let r = rand() * table.reduce((a, [, w]) => a + w, 0)
  for (const [v, w] of table) if ((r -= w) < 0) return v
  return table[0][0]
}
const bump = (o, k, x = 1) => (o[k] = (o[k] ?? 0) + x)

const KINDS = [['coding', 55], ['devops', 17], ['questions', 11], ['research', 7], ['documents', 6], ['other', 3.5], ['images', 0.5]]
const MODELS = [['claude-opus-5-5', 55], ['claude-sonnet-5-5', 39], ['claude-haiku-5-5', 4], ['claude-opus-4-8', 2]]
const LANGS = [['TypeScript', 52], ['Python', 27], ['HTML', 8], ['CSS', 6], ['Config', 4], ['Markdown', 3]]
const SIZES = [['s', 55], ['m', 30], ['l', 15]]
const DEV = [['feature', 40], ['bugfix', 28], ['refactor', 16], ['tests', 9], ['docs', 7]]

function makeDay(count) {
  const day = { tasks: {}, models: {}, sizes: {}, dev: {}, langs: {}, n: {}, tokens: {} }
  for (let i = 0; i < count; i++) {
    const kind = pick(KINDS)
    const model = pick(MODELS)
    bump(day.tasks, kind)
    bump(day.models, model)
    const t = (day.tokens[model] ??= { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 })
    t.in += between(2000, 9000)
    t.out += between(6000, 26000)
    t.cacheRead += between(1_500_000, 5_500_000)
    t.cacheWrite += between(30_000, 90_000)
    if (kind !== 'coding') continue
    const size = pick(SIZES)
    bump(day.sizes, size)
    if (rand() < 0.1) bump(day.dev, pick(DEV))
    const lines = size === 's' ? between(8, 60) : size === 'm' ? between(60, 240) : between(240, 900)
    bump(day.n, 'linesAdded', lines)
    bump(day.n, 'linesRemoved', Math.round(lines * (0.08 + rand() * 0.18)))
    bump(day.n, 'files', between(1, size === 'l' ? 14 : 5))
    bump(day.langs, pick(LANGS), lines)
    if (rand() < 0.34) bump(day.n, 'commits')
    if (rand() < 0.06) bump(day.n, 'pushes')
    if (rand() < 0.025) bump(day.n, 'merges')
    if (rand() < 0.012) bump(day.n, 'branches')
    if (rand() < 0.03) bump(day.n, 'prsOpened')
    if (rand() < 0.02) bump(day.n, 'prsMerged')
    if (rand() < 0.015) bump(day.n, 'issuesClosed')
    if (rand() < 0.4) {
      bump(day.n, 'testRuns')
      bump(day.n, 'testMs', between(4000, 38000))
      bump(day.n, 'testsPassed', between(40, 130))
      if (rand() < 0.03) {
        bump(day.n, 'testFails')
        bump(day.n, 'testsFailed', between(1, 4))
      }
    }
    if (rand() < 0.16) {
      bump(day.n, 'builds')
      if (rand() < 0.025) bump(day.n, 'buildFails')
    }
  }
  return day
}

const now = new Date(2026, 9, 16, 16).getTime()
const days = {}
for (let i = 0; i < 30; i++) {
  const ms = daysBack(now, 29 - i)
  const weekend = [0, 6].includes(new Date(ms).getDay())
  const count = i === 29 ? 29 : weekend ? between(2, 12) : between(28, 86)
  days[dayKey(ms)] = makeDay(count)
  if (rand() < 0.4) {
    // Work an assistant or script did through the SDK, kept apart from the person's own
    const sdk = { tasks: {}, models: {} }
    for (let k = between(1, 6); k > 0; k--) {
      bump(sdk.tasks, pick([['documents', 4], ['research', 3], ['other', 3]]))
      bump(sdk.models, pick(MODELS))
    }
    days[dayKey(ms)].sdk = sdk
  }
}
days[dayKey(now)].n.judgeCalls = 41
days[dayKey(now)].n.judgeIn = 9800
days[dayKey(now)].n.judgeOut = 3100

// ---------------------------------------------------------------- the picture

const settings = withDefaults({ currency: 'eur' })
const v = view('month', now, days)
const { alt, width: W, height: bodyH, body } = dashboardSvg(v, settings, 160)
const sdkTasks = Object.values(v.total.sdk?.tasks ?? {}).reduce((a, b) => a + b, 0)
const allTasks = Object.values(v.total.tasks ?? {}).reduce((a, b) => a + b, 0) + sdkTasks
const fmt = n => n.toLocaleString('en-US')

const MONO = "ui-monospace, SFMono-Regular, 'Cascadia Code', Menlo, Consolas, 'Liberation Mono', monospace"
const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
const text = (x, y, s, fill, size = 13, weight = 400, anchor = 'start', font = MONO) =>
  `<text x="${x}" y="${y}" fill="${fill}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}" font-family="${font}">${esc(s)}</text>`
const rect = (x, y, w, h, fill, rx = 0, stroke = '') => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}"${stroke ? ` stroke="${stroke}"` : ''}/>`
const chip = (x, y, w, label, on = false) => rect(x, y, w, 26, on ? C.gold : C.hair, 6) + text(x + w / 2, y + 17.5, label, on ? C.dark : C.text, 13, on ? 700 : 400, 'middle')

const X0 = 28
const X1 = W - 28
const head = [
  text(X0, 56, v.title, C.text, 20, 800, 'start', SANS),
  text(X1, 56, v.dates, C.muted, 14, 400, 'end'),
  rect(X0, 68, 66, 3, C.gold, 1.5) + rect(X0 + 66, 69, X1 - X0 - 66, 1, C.hair),
  chip(X0, 92, 64, 'Today') + chip(X0 + 72, 92, 60, 'Week') + chip(X0 + 140, 92, 64, 'Month', true) + chip(X0 + 212, 92, 56, 'Year'),
  chip(X1 - 72, 92, 32, '$') + chip(X1 - 32, 92, 32, '€', true),
  text(X0, 145, 'Started by', C.muted) + chip(X0 + 92, 128, 44, 'All', true) + chip(X0 + 144, 128, 48, 'You') + chip(X0 + 200, 128, 48, 'SDK') + text(X0 + 264, 145, `You ${fmt(allTasks - sdkTasks)} · SDK ${fmt(sdkTasks)}`, C.muted),
].join('')
const HEAD = 150
const H = HEAD + bodyH
const label = esc(`The Payback pane on the Month tab, with sample data. ${alt}`)
const svg =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${label}">` +
  '<title>Payback pane (sample data)</title>' +
  rect(0.5, 0.5, W - 1, H - 1, C.dark, 16, C.hair) +
  head +
  `<g transform="translate(0 ${HEAD})">${body}</g>` +
  '</svg>'
fs.writeFileSync(path.join(out, 'pane.svg'), svg, 'utf8')
console.log(`pane.svg ${W}x${H}, ${Math.round(svg.length / 1024)} KB: ${fmt(allTasks)} tasks (${fmt(sdkTasks)} SDK), ${alt.slice(0, 120)}`)

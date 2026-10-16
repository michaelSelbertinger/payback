import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Counter, Currency, Day, DevKind, ImportView, Kind, Settings, Size, Source, Tab } from '../types'
import {
  DEV_KINDS, JUDGE_MODEL, JUDGE_SYSTEM, KINDS, KIND_LABEL, SIZES, TITLES,
  addDays, barCell, bigText, bySource, dayKey, isSummaryJob, isTempDir, daysBack, finishTask, fit, fmtCompact, fmtDuration, fmtMoney,
  fmtHours, fmtInt, isEmptyDay, judgePrompt, minutesSaved, modelName, newTask, parseJudge,
  shortDay, taskCount, tilesPerRow, toolDelta, view, withDefaults,
} from './stats'
import type { Task, View } from './stats'
import { createImporter } from './history'
import { dashboardSvg } from './dashboard'
import { C, KIND_COLOR } from './theme'
import type { ImportRange, ImportResult } from './history'

const PANE = 'payback'
const tab = atom({ plugin: 'payback', key: 'tab' } as const, 'today' as Tab)
const rev = atom({ plugin: 'payback', key: 'rev' } as const, 0)
const IDLE: ImportView = { phase: 'idle', fromDay: '', untilDay: '', done: 0, total: 0 }
const importView = atom({ plugin: 'payback', key: 'import' } as const, IDLE)
const sourceView = atom({ plugin: 'payback', key: 'source' } as const, 'all' as Source)

// Who started this session, read at its start: the SDK's work is stored apart, a harness test not at all.
let isFromSdk = false
let isTestSession = false

const TYPED_ORIGINS = new Set(['composer', 'sdk', 'bridge'])

type $ = EngineInterface

// ---------------------------------------------------------------- store

const yearKey = (day: string) => `days:${day.slice(0, 4)}`

async function loadSettings($: $): Promise<Settings> {
  return withDefaults(await $.store.get('settings'))
}

/** This year's days and last year's, so a week or a streak may reach back over January 1: live and imported added up. */
async function loadDays($: $, nowMs: number): Promise<Record<string, Day>> {
  const y = new Date(nowMs).getFullYear()
  const layers = await Promise.all([`days:${y - 1}`, `days:${y}`, `imported:${y - 1}`, `imported:${y}`].map(k => $.store.get(k)))
  const days: Record<string, Day> = {}
  for (const layer of layers) for (const [k, d] of Object.entries((layer ?? {}) as Record<string, Day>)) days[k] = addDays(days[k] ?? {}, d)
  return days
}

let chain: Promise<unknown> = Promise.resolve()
let hasStarted = false

/** Adds `delta` to the stored day, read fresh so another session's writes are kept. */
function record($: $, day: string, delta: Day): Promise<unknown> {
  if (isEmptyDay(delta) || isTestSession) return Promise.resolve()
  const stored: Day = isFromSdk ? { sdk: delta } : delta
  // ponytail: one key per year, read-modify-write; two sessions writing in the same millisecond can drop one delta.
  const run = chain.then(async () => {
    const year = ((await $.store.get(yearKey(day))) ?? {}) as Record<string, Day>
    year[day] = addDays(year[day] ?? {}, stored)
    await $.store.set(yearKey(day), year)
    if (!hasStarted) {
      hasStarted = true
      if ((await $.store.get('tracked-since-ms')) === undefined) await $.store.set('tracked-since-ms', await $.clock.now())
    }
    await update($, rev, n => n + 1)
  })
  chain = run.catch(() => {})
  return run
}

// ---------------------------------------------------------------- the task in flight

type LiveTask = Task & { turnId: string; text: string }

let typed: string | null = null
let cur: LiveTask | null = null
type Job = { day: string; size: Size; prompt: string }
// ponytail: the judge queue lives in the module; a reload drops jobs not yet sent, and those keep the lines-based size.
const queue: Job[] = []
let isJudging = false

async function drain($: $): Promise<void> {
  if (isJudging) return
  isJudging = true
  try {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const n: Partial<Record<Counter, number>> = { judgeCalls: 1 }
      const delta: Day = { n }
      try {
        const r = await $.model.complete({ model: JUDGE_MODEL, system: JUDGE_SYSTEM, prompt: job.prompt, maxTokens: 16, timeoutMs: 30_000 })
        n.judgeIn = r.usage.input_tokens
        n.judgeOut = r.usage.output_tokens
        n.judgeCacheRead = r.usage.cache_read_input_tokens
        n.judgeCacheWrite = r.usage.cache_creation_input_tokens
        const verdict = r.isAnswered ? parseJudge(r.text) : null
        if (verdict) {
          delta.dev = { [verdict.kind]: 1 }
          if (verdict.size !== job.size) delta.sizes = { [job.size]: -1, [verdict.size]: 1 }
        } else n.judgeFails = 1
      } catch {
        n.judgeFails = 1
      }
      await record($, job.day, delta)
    }
  } finally {
    isJudging = false
  }
}

// ---------------------------------------------------------------- history import
//
// Reads Claude Code's own transcripts into a layer of its own (`imported:YYYY`), which the pane adds to the
// live days. It reads only days before live tracking began, and an import replaces its whole range, so running
// it again never counts twice; undo deletes the layer. Nothing is saved until the person presses Import.

const ALL_HISTORY = '0000-01-01'
const STREAM_ABOVE = 4_000_000 // $.fs.read stops at 4 MiB; bigger transcripts are streamed through the shell
/** `cmd` reads these as commands (& | < > ^ % ! and quotes), not as part of a file name: a Windows path with one is skipped, never handed to it. */
const CMD_SAFE_PATH = /^[\p{L}\p{N} _.:\\/()[\]@+,'~-]+$/u

type Transcript = { path: string; size: number; isSubagent: boolean }

let scan: { isCancelled: boolean } | null = null
let scanned: { range: ImportRange; result: ImportResult } | null = null

const setImport = ($: $, next: ImportView) => update($, importView, () => next)

/** The moment the live tracker first saved anything: the import reads only what came before it. */
async function trackedSince($: $, nowMs: number): Promise<number> {
  const saved = await $.store.get('tracked-since-ms')
  return typeof saved === 'number' ? saved : nowMs
}

/** Every transcript, main sessions and their subagents', changed on or after `sinceMs`. */
async function listTranscripts($: $, sinceMs: number): Promise<{ files: Transcript[]; isWindows: boolean }> {
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  const config = await $.env.get('CLAUDE_CONFIG_DIR')
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  const base = config ?? (home ? `${home}/.claude` : undefined)
  if (!base) throw new Error('Could not find your home folder, so the transcripts could not be found.')
  const root = `${base}/projects`
  if (!(await $.fs.exists(root))) throw new Error(`There are no transcripts in ${root}.`)
  const files: Transcript[] = []
  const take = (path: string, e: { name: string; kind: string; size: number; mtimeMs: number }, isSubagent: boolean) => {
    if (e.kind === 'file' && e.name.endsWith('.jsonl') && e.mtimeMs >= sinceMs) files.push({ path, size: e.size, isSubagent })
  }
  for (const project of await $.fs.list(root)) {
    if (project.kind !== 'dir') continue
    const dir = `${root}/${project.name}`
    for (const e of await $.fs.list(dir).catch(() => [])) {
      if (e.kind !== 'dir') take(`${dir}/${e.name}`, e, false)
      else {
        const sub = `${dir}/${e.name}/subagents`
        for (const s of await $.fs.list(sub).catch(() => [])) take(`${sub}/${s.name}`, s, true)
      }
    }
  }
  return { files, isWindows }
}

/** The lines of one transcript: read whole when small, streamed through `type`/`cat` when large. */
async function* transcriptLines($: $, file: Transcript, isWindows: boolean): AsyncGenerator<string> {
  if (file.size <= STREAM_ABOVE) {
    yield* (await $.fs.read(file.path)).split('\n')
    return
  }
  if (isWindows && !CMD_SAFE_PATH.test(file.path)) throw new Error('its path has a character cmd would read as a command')
  const argv = isWindows ? ['cmd', '/c', 'type', file.path.replaceAll('/', '\\')] : ['cat', file.path]
  let buffer = ''
  for await (const chunk of $.process.spawn({ argv })) {
    if (chunk.stream !== 'stdout') continue
    buffer += chunk.text
    for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
      yield buffer.slice(0, i)
      buffer = buffer.slice(i + 1)
    }
  }
  if (buffer) yield buffer
}

async function runScan($: $, range: ImportRange): Promise<void> {
  const mine = { isCancelled: false }
  scan = mine
  scanned = null
  const base: ImportView = { ...IDLE, phase: 'scanning', fromDay: range.fromDay, untilDay: range.untilDay }
  try {
    await setImport($, base)
    const since = range.fromDay === ALL_HISTORY ? 0 : daysBack(dayMs(range.fromDay) ?? 0, 1)
    const { files, isWindows } = await listTranscripts($, since)
    const importer = createImporter(range)
    let skipped = 0
    let shownAt = 0
    for (const [i, file] of files.entries()) {
      if (mine.isCancelled) return
      const now = await $.clock.now()
      if (now - shownAt > 400) {
        shownAt = now
        await setImport($, { ...base, done: i, total: files.length })
      }
      const reader = importer.file(file.isSubagent)
      try {
        let n = 0
        for await (const text of transcriptLines($, file, isWindows)) {
          reader.line(text)
          if (++n % 5000 === 0 && mine.isCancelled) return
        }
        reader.end()
      } catch {
        skipped++ // unreadable or gone mid-read: left out and counted, the rest goes on
      }
    }
    const result = importer.result()
    const split = Object.values(result.days).reduce((a, d) => addDays(a, d), {} as Day)
    const total = bySource(split, 'all')
    const settings = await loadSettings($)
    scanned = { range, result }
    await setImport($, {
      ...base,
      phase: 'preview',
      done: files.length,
      total: files.length,
      preview: {
        tasks: taskCount(total),
        kinds: total.tasks ?? {},
        minutes: minutesSaved(total, settings),
        sessions: result.sessions,
        sdkSessions: result.sdkSessions,
        sdkTasks: taskCount(split.sdk ?? {}),
        testSessions: result.testSessions,
        skipped: skipped + result.badLines,
        activeDays: Object.values(result.days).filter(d => taskCount(bySource(d, 'all')) > 0).length,
      },
    })
  } catch (err) {
    if (!mine.isCancelled) await setImport($, { ...base, phase: 'error', message: err instanceof Error ? err.message : 'The history could not be read.' })
  } finally {
    if (scan === mine) scan = null
  }
}

/** Saves what the scan found, replacing the imported days of its range, so an import run twice counts once. */
async function applyImport($: $): Promise<void> {
  const shown = await read($, importView)
  if (!scanned) {
    await setImport($, { ...shown, phase: 'error', message: 'The scan was lost when the mod reloaded. Run /payback import again.' })
    return
  }
  const { range, result } = scanned
  const inRange = (day: string) => day >= range.fromDay && day < range.untilDay
  const years = new Set(Object.keys(result.days).map(d => d.slice(0, 4)))
  for (const key of await $.store.keys()) if (key.startsWith('imported:')) years.add(key.slice(9))
  for (const year of years) {
    const key = `imported:${year}`
    const kept = Object.entries(((await $.store.get(key)) ?? {}) as Record<string, Day>).filter(([d]) => !inRange(d))
    const merged = Object.fromEntries([...kept, ...Object.entries(result.days).filter(([d]) => d.startsWith(year))])
    if (Object.keys(merged).length > 0) await $.store.set(key, merged)
    else await $.store.delete(key)
  }
  scanned = null
  await setImport($, { ...shown, phase: 'done' })
  await update($, rev, r => r + 1)
}

async function undoImport($: $): Promise<string> {
  const keys = (await $.store.keys()).filter(k => k.startsWith('imported:'))
  for (const key of keys) await $.store.delete(key)
  await setImport($, IDLE)
  await update($, rev, r => r + 1)
  return keys.length > 0 ? 'Removed the imported history. Live tracking is untouched.' : 'There was no imported history to remove.'
}

/** `YYYY-MM-DD` at local noon, or null when it is no real day. */
function dayMs(key: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key)
  if (!m) return null
  const ms = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12).getTime()
  return dayKey(ms) === key ? ms : null
}

const rangeText = (r: { fromDay: string; untilDay: string }) =>
  `${r.fromDay === ALL_HISTORY ? 'all kept history' : shortDay(r.fromDay)} to ${shortDay(dayKey(daysBack(dayMs(r.untilDay) ?? 0, 1)))}`

async function importCommand($: $, args: string[]): Promise<string> {
  const sub = args[0]?.toLowerCase()
  if (sub === 'undo') return undoImport($)
  if (sub === 'cancel') return cancelImport($)
  if (scan) return 'The history is already being read; Payback shows how far it got.'
  const now = await $.clock.now()
  const since = await trackedSince($, now)
  let fromDay = ALL_HISTORY
  let untilDay = dayKey(daysBack(since, -1))
  if (sub && /^\d+d$/.test(sub)) fromDay = dayKey(daysBack(now, Number(sub.slice(0, -1))))
  else if (sub) {
    const from = dayMs(sub)
    const to = args[1] === undefined ? null : dayMs(args[1])
    if (from === null || (args[1] !== undefined && to === null))
      return 'Give the days as YYYY-MM-DD, for example /payback import 2026-09-20 2026-10-10, or a span such as /payback import 30d.'
    fromDay = sub
    if (to !== null) untilDay = [dayKey(daysBack(to, -1)), untilDay].sort()[0]!
  }
  if (fromDay >= untilDay) return `Nothing to import: Payback has counted everything since ${shortDay(dayKey(since))} itself.`
  const range = { fromDay, untilDay, untilMs: since }
  $.clock.after(0, () => void runScan($, range))
  void openPane($)
  return `Reading your Claude Code history, ${rangeText(range)}. Payback shows a preview when it is done; nothing is saved until you press Import.`
}

async function cancelImport($: $): Promise<string> {
  if (scan) scan.isCancelled = true
  scanned = null
  await setImport($, IDLE)
  return 'Import cancelled. Nothing was saved.'
}

// ---------------------------------------------------------------- commands

const SETTING_NAMES: Record<string, (s: Settings, v: number) => void> = {
  rate: (s, v) => (s.rate = v),
  emails: (s, v) => (s.minutes.emails = v),
  documents: (s, v) => (s.minutes.documents = v),
  images: (s, v) => (s.minutes.images = v),
  research: (s, v) => (s.minutes.research = v),
  devops: (s, v) => (s.minutes.devops = v),
  questions: (s, v) => (s.minutes.questions = v),
  other: (s, v) => (s.minutes.other = v),
  small: (s, v) => (s.sizes.s = v),
  medium: (s, v) => (s.sizes.m = v),
  large: (s, v) => (s.sizes.l = v),
}

function listSettings(s: Settings): string {
  return [
    'Payback settings (hours and money are estimates):',
    `  currency   ${s.currency === 'eur' ? 'euro' : 'dollar'}`,
    `  rate       ${fmtMoney(s.rate, s.currency)} per hour`,
    `  emails     ${s.minutes.emails} min per task`,
    `  documents  ${s.minutes.documents} min per task`,
    `  images     ${s.minutes.images} min per task`,
    `  research   ${s.minutes.research} min per task`,
    `  devops     ${s.minutes.devops} min per task`,
    `  questions  ${s.minutes.questions} min per task`,
    `  other      ${s.minutes.other} min per task`,
    `  small      ${s.sizes.s} min per small coding task`,
    `  medium     ${s.sizes.m} min per medium coding task`,
    `  large      ${s.sizes.l} min per large coding task`,
    `  judge      ${s.judge ? 'on' : 'off'} (off by default; when on, Haiku 5.5 labels each coding task's type and size)`,
    'Change one with /payback settings <name> <value>, for example /payback settings rate 75.',
  ].join('\n')
}

async function settingsCommand($: $, args: string[]): Promise<string> {
  const s = await loadSettings($)
  if (args.length === 0) return listSettings(s)
  const [name, value] = [args[0]!.toLowerCase(), args[1]]
  if (name === 'judge') {
    if (value !== 'on' && value !== 'off') return 'Use /payback settings judge on or /payback settings judge off.'
    s.judge = value === 'on'
    await $.store.set('settings', s)
    await update($, rev, r => r + 1)
    return `The Haiku judge is ${value}.`
  }
  if (name === 'currency') {
    const currency = CURRENCY_NAMES[(value ?? '').toLowerCase()]
    if (!currency) return 'Use /payback settings currency eur or /payback settings currency usd.'
    await setCurrency($, currency)
    return `Money is now shown in ${currency === 'eur' ? 'euro' : 'dollars'}. The hourly rate stays ${fmtMoney(s.rate, currency)}; nothing is converted.`
  }
  const set = SETTING_NAMES[name]
  if (!set) return `There is no setting called "${name}". The settings are: ${[...Object.keys(SETTING_NAMES), 'currency', 'judge'].join(', ')}.`
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0 || n > 100_000) return `Give ${name} a number above 0, for example /payback settings ${name} ${name === 'rate' ? 75 : 15}.`
  set(s, n)
  await $.store.set('settings', s)
  await update($, rev, r => r + 1)
  return name === 'rate' ? `Hourly rate is now ${fmtMoney(n, s.currency)}.` : `${name} is now ${n} minutes per task.`
}

const CURRENCY_NAMES: Record<string, Currency> = { eur: 'eur', euro: 'eur', euros: 'eur', '€': 'eur', usd: 'usd', dollar: 'usd', dollars: 'usd', $: 'usd' }

/** Saves the currency read fresh, so a change made elsewhere meanwhile is kept, and redraws the pane. */
async function setCurrency($: $, currency: Currency) {
  const s = await loadSettings($)
  await $.store.set('settings', { ...s, currency })
  await update($, rev, r => r + 1)
}

const openPane = ($: $) => $.ui.open({ id: PANE, title: 'Payback' }).catch(() => undefined)

// ---------------------------------------------------------------- drawing
//
// Every Text is `mono`: the desktop then measures in the same cells as `bodyColumns`, as the terminal always does.
// Rows hold fixed-width boxes that never shrink, so a long value is cut by us, never squeezed by the layout.

type Els = ReturnType<EngineInterface['ui']['resolve']>
type Seg = [string, string?, boolean?]
// `mono` and the type scale are refused on the terminal (always monospaced there), so they ride along only elsewhere.
type Ctx = { ui: Els; isTerminal: boolean; mono: { mono?: true } }

const len = (text: string) => [...text].length

/** The segments cut so together they fill at most `width` cells. */
function cut(segs: Seg[], width: number): Seg[] {
  let room = width
  return segs
    .map(([text, color, bold]): Seg => {
      const t = len(text) <= room ? text : fit(text, Math.max(0, room))
      room -= len(t)
      return [t, color, bold]
    })
    .filter(([text]) => text !== '')
}

/** One Text holding coloured parts, so the parts are laid out as one run of text. */
function spans(c: Ctx, key: string, segs: Seg[]) {
  const { Text } = c.ui
  return (
    <Text key={key} {...c.mono} wrap="truncate-end">
      {segs.map(([text, color, bold], i) => (
        <Text key={`${key}-${i}`} {...c.mono} color={color ?? C.text} bold={bold}>{text}</Text>
      ))}
    </Text>
  )
}

/** A row exactly `width` cells wide. */
function line(c: Ctx, key: string, width: number, segs: Seg[]) {
  const { Box } = c.ui
  return (
    <Box key={key} width={width} flexDirection="row" overflow="hidden">
      {spans(c, `${key}-t`, cut(segs, width))}
    </Box>
  )
}

/** A fixed cell of `width` that never shrinks, its text cut to fit, left or right aligned. */
function cell(c: Ctx, key: string, width: number, segs: Seg[], isRight = false) {
  const { Box } = c.ui
  return (
    <Box key={key} width={width} flexShrink={0} flexDirection="row" justifyContent={isRight ? 'flex-end' : 'flex-start'} overflow="hidden">
      {spans(c, `${key}-t`, cut(segs, width))}
    </Box>
  )
}

/** A section heading in small muted capitals, then a hairline to the edge. */
function heading(c: Ctx, key: string, width: number, title: string) {
  const { Box } = c.ui
  const label = fit(title.toUpperCase(), width)
  return (
    <Box key={key} width={width} flexDirection="row" overflow="hidden" marginTop={1}>
      {cell(c, `${key}-l`, len(label), [[label, C.muted, true]])}
      {width - len(label) > 1 && cell(c, `${key}-r`, width - len(label), [[' ' + '─'.repeat(width - len(label) - 1), C.hair]])}
    </Box>
  )
}

/** A label, a bar of coloured cells for `value` against `max`, and the numbers on the right. */
function barRow(c: Ctx, key: string, width: number, label: string, color: string, value: number, max: number, right: string, hasBar: boolean) {
  const { Box } = c.ui
  const labelW = width >= 56 ? 21 : Math.min(16, Math.max(8, Math.floor(width * 0.32)))
  const rightW = Math.min(len(right), Math.max(0, width - labelW))
  const barW = width - labelW - rightW - 2
  const fill = value > 0 ? Math.max(1, Math.round((value / Math.max(1, max)) * barW)) : 0
  return (
    <Box key={key} width={width} flexDirection="row" overflow="hidden">
      {cell(c, `${key}-l`, labelW, [[label, C.text]])}
      {hasBar && barW >= 4
        ? cell(c, `${key}-b`, barW + 2, [[' '], ['█'.repeat(fill), color], ['█'.repeat(barW - fill), C.hair], [' ']])
        : cell(c, `${key}-b`, Math.max(0, width - labelW - rightW), [['']])}
      {cell(c, `${key}-r`, rightW, [[right, C.text]], true)}
    </Box>
  )
}

/** A muted label column, then the value. */
function kv(c: Ctx, key: string, width: number, label: string, value: Seg[]) {
  const { Box } = c.ui
  const labelW = width >= 36 ? 11 : 9
  return (
    <Box key={key} width={width} flexDirection="row" overflow="hidden">
      {cell(c, `${key}-l`, labelW, [[label, C.muted]])}
      {cell(c, `${key}-v`, width - labelW, value)}
    </Box>
  )
}

/** A rounded card with a muted title; `inner` is the width its rows draw in. */
function card(c: Ctx, key: string, width: number, title: string, rows: (inner: number) => RenderChildren[]) {
  const { Box } = c.ui
  const inner = Math.max(8, width - 4)
  return (
    <Box key={key} width={width} flexDirection="column" borderStyle="round" borderColor={C.hair} paddingX={1}>
      {line(c, `${key}-title`, inner, [[title.toUpperCase(), C.muted, true]])}
      {rows(inner)}
    </Box>
  )
}

function tile(c: Ctx, key: string, width: number, label: string, digits: string, shown: string, foot: string) {
  const { Box, Text } = c.ui
  const inner = Math.max(1, width - 4)
  const big = c.isTerminal ? bigText(digits, inner) : null
  return (
    <Box key={key} width={width} flexDirection="column" borderStyle="round" borderColor={C.hair} paddingX={1}>
      {line(c, `${key}-label`, inner, [[label, C.muted]])}
      {big
        ? big.map((row, i) => line(c, `${key}-big-${i}`, inner, [[row, C.text]]))
        : <Text key={`${key}-value`} {...c.mono} {...(c.isTerminal ? {} : { size: 'title' as const, weight: 'bold' as const })} bold color={C.text} wrap="truncate-end">{fit(shown, inner)}</Text>}
      {line(c, `${key}-foot`, inner, [[foot, C.muted]])}
    </Box>
  )
}

/** The chart: on the terminal three rows of eighth blocks, elsewhere one SVG (text rows there leave gaps). */
function chart(c: Ctx, width: number, v: View) {
  const { Box, Text } = c.ui
  const all = v.chart
  const els = c.ui
  if (!c.isTerminal && 'Svg' in els) {
    const { Svg } = els
    return [<Svg key="chart" source={chartSvg(all, width)} alt={`Tasks: ${all.map(b => `${b.label} ${b.isFuture ? '-' : b.value}`).join(', ')}`} height={132} />]
  }
  const gap = all.length < 30 || width >= all.length * 2 - 1 ? 1 : 0
  const cap = all.length === 7 ? 6 : all.length === 12 ? 4 : 1
  const bw = Math.max(1, Math.min(cap, Math.floor((width - gap * (all.length - 1)) / all.length)))
  const shown = all.slice(-Math.max(1, Math.floor((width + gap) / (bw + gap))))
  const max = Math.max(...shown.map(b => b.value))
  const sep = (i: number) => (i < shown.length - 1 ? ' '.repeat(gap) : '')
  const rows = [0, 1, 2].map(row =>
    line(c, `chart-${row}`, width, shown.map((b, i): Seg => [(b.isFuture ? ' ' : barCell(b.value, max, row)).repeat(bw) + sep(i), b.isFuture || b.value === 0 ? C.hair : b.isCurrent ? C.gold : C.text])),
  )
  const labels =
    shown.length === 30 || shown.length < all.length
      ? (
          <Box key="chart-labels" width={width} flexDirection="row" justifyContent="space-between">
            {cell(c, 'cl-a', len(`${shown.length} days ago`), [[`${shown.length} days ago`, C.muted]])}
            {cell(c, 'cl-b', 5, [['today', C.gold]])}
          </Box>
        )
      : line(c, 'chart-labels', width, shown.map((b, i): Seg => [fit(b.label, bw).padEnd(bw) + sep(i), b.isCurrent ? C.gold : C.muted]))
  return [...rows, labels]
}

function chartSvg(buckets: View['chart'], width: number): string {
  const vw = Math.max(240, width * 8)
  const vh = 132
  const base = vh - 22
  const slot = vw / buckets.length
  const barW = Math.min(slot * 0.62, 40)
  const max = Math.max(1, ...buckets.map(b => b.value))
  const every = buckets.length > 12 ? 5 : 1
  const parts = buckets.map((b, i) => {
    const x = i * slot + (slot - barW) / 2
    const cx = i * slot + slot / 2
    const fill = b.isCurrent ? C.gold : C.text
    const h = b.isFuture ? 0 : b.value > 0 ? Math.max(3, (b.value / max) * (base - 18)) : 2
    const bar = b.isFuture ? '' : `<rect x="${x.toFixed(1)}" y="${(base - h).toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="3" fill="${b.value > 0 ? fill : C.hair}"/>`
    const count = b.value > 0 && slot >= 16 ? `<text x="${cx.toFixed(1)}" y="${(base - h - 5).toFixed(1)}" text-anchor="middle" font-size="11" fill="${C.muted}">${b.value}</text>` : ''
    const showLabel = (buckets.length - 1 - i) % every === 0
    const label = showLabel ? `<text x="${cx.toFixed(1)}" y="${vh - 5}" text-anchor="middle" font-size="11" fill="${b.isCurrent ? C.gold : C.muted}">${b.label}</text>` : ''
    return bar + count + label
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${vw} ${vh}" width="${vw}" height="${vh}" font-family="ui-monospace, Menlo, Consolas, monospace"><line x1="0" y1="${base + 0.5}" x2="${vw}" y2="${base + 0.5}" stroke="${C.hair}"/>${parts.join('')}</svg>`
}

const EMPTY: Record<Tab, string> = {
  today: 'Nothing finished yet today.',
  week: 'Nothing finished in the last 7 days.',
  month: 'Nothing finished in the last 30 days.',
  year: 'Nothing finished yet this year.',
}

const plural = (x: number, one: string, many = `${one}s`) => `${fmtInt(x)} ${x === 1 ? one : many}`

/** Columns from which the desktop draws the body as a picture, sized to the pane; below it the text layout is kinder. */
const WIDE = 62

type ImportActions = { importNow: () => void; cancel: () => void; close: () => void }
type Who = { source: Source; you: number; sdk: number; hasSdk: boolean; set: (s: Source) => void }

function importCard(c: Ctx, width: number, imp: ImportView, s: Settings, act: ImportActions) {
  const { Box, Button } = c.ui
  const buttons = (main: { label: string; onPress: () => void } | null, other: { key: string; label: string; onPress: () => void }) => (
    <Box key="imp-buttons" flexDirection="row" columnGap={2} marginTop={1}>
      {main && <Button key="imp-go" label={main.label} variant="primary" onPress={main.onPress} />}
      <Button key={other.key} label={other.label} plain dimColor onPress={other.onPress} />
    </Box>
  )
  return card(c, 'card-import', width, 'Import history', inner => {
    const rows: RenderChildren[] = []
    const range = rangeText(imp)
    if (imp.phase === 'scanning') {
      const fill = imp.total > 0 ? Math.round((imp.done / imp.total) * inner) : 0
      rows.push(line(c, 'imp-status', inner, [[imp.total > 0 ? `Reading transcripts: ${fmtInt(imp.done)} of ${fmtInt(imp.total)}` : 'Finding transcripts…'], [`  ·  ${range}`, C.muted]]))
      rows.push(line(c, 'imp-bar', inner, [['█'.repeat(fill), C.gold], ['█'.repeat(inner - fill), C.hair]]))
      rows.push(buttons(null, { key: 'imp-cancel', label: 'Cancel', onPress: act.cancel }))
    } else if (imp.phase === 'preview' && imp.preview) {
      const p = imp.preview
      rows.push(line(c, 'imp-found', inner, [[`Found ${plural(p.tasks, 'task')} on ${plural(p.activeDays, 'day')} in ${plural(p.sessions + p.sdkSessions, 'session')}`, C.text, true]]))
      if (p.sdkTasks > 0) rows.push(line(c, 'imp-split', inner, [[`Started by you ${fmtInt(p.tasks - p.sdkTasks)} · SDK ${fmtInt(p.sdkTasks)}`]]))
      rows.push(line(c, 'imp-range', inner, [[range, C.muted]]))
      const kinds = KINDS.filter(k => (p.kinds[k] ?? 0) > 0).map(k => `${KIND_LABEL[k]} ${fmtInt(p.kinds[k] ?? 0)}`).join(' · ')
      if (kinds) rows.push(line(c, 'imp-kinds', inner, [[kinds]]))
      if (p.tasks > 0) rows.push(line(c, 'imp-worth', inner, [[`≈ ${fmtHours(p.minutes)} h · ${fmtMoney((p.minutes / 60) * s.rate, s.currency)}`, C.green], [' estimate', C.muted]]))
      rows.push(line(c, 'imp-note', inner, [['Coding tasks are sized by lines changed, not judged by Haiku.', C.muted]]))
      if (p.testSessions > 0) rows.push(line(c, 'imp-tests', inner, [[`Left out: ${plural(p.testSessions, 'SDK test session')} run from a temp folder.`, C.muted]]))
      if (p.skipped > 0) rows.push(line(c, 'imp-skipped', inner, [[`${plural(p.skipped, 'unreadable file or line', 'unreadable files or lines')} skipped.`, C.amber]]))
      rows.push(
        p.tasks > 0
          ? buttons({ label: 'Import', onPress: act.importNow }, { key: 'imp-cancel', label: 'Cancel', onPress: act.cancel })
          : buttons(null, { key: 'imp-close', label: 'Close', onPress: act.close }),
      )
    } else if (imp.phase === 'done') {
      rows.push(line(c, 'imp-done', inner, [[`Imported ${plural(imp.preview?.tasks ?? 0, 'task')}, ${range}.`, C.green]]))
      rows.push(line(c, 'imp-undo', inner, [['Undo it any time with /payback import undo.', C.muted]]))
      rows.push(buttons(null, { key: 'imp-close', label: 'Close', onPress: act.close }))
    } else {
      rows.push(line(c, 'imp-error', inner, [[imp.message ?? 'The history could not be read.', C.amber]]))
      rows.push(buttons(null, { key: 'imp-close', label: 'Close', onPress: act.close }))
    }
    return rows
  })
}

function drawPane(ui: Els, isTerminal: boolean, v: View, s: Settings, width: number, setTab: (t: Tab) => void, setMoney: (c: Currency) => void, imp: ImportView, act: ImportActions, who: Who) {
  const { Box, Text, Button } = ui
  const c: Ctx = { ui, isTerminal, mono: isTerminal ? {} : { mono: true } }
  const W = Math.max(16, width)
  const d = v.total
  const n = (k: Counter) => d.n?.[k] ?? 0
  const out: RenderChildren[] = []

  // Title bar: the stretch on the left, its dates on the right, a gold rule under the title.
  const dates = fit(v.dates, Math.max(0, W - v.title.length - 1))
  out.push(
    <Box key="title" width={W} flexDirection="row" justifyContent="space-between">
      {cell(c, 'title-l', v.title.length, [[v.title, C.text, true]])}
      {cell(c, 'title-r', len(dates), [[dates, C.muted]])}
    </Box>,
  )
  out.push(
    <Box key="rule" width={W} flexDirection="row">
      {cell(c, 'rule-gold', v.title.length, [['━'.repeat(v.title.length), C.gold]])}
      {cell(c, 'rule-hair', W - v.title.length, [['─'.repeat(W - v.title.length), C.hair]])}
    </Box>,
  )

  // Tabs on the left, the currency on the right: the chosen chip gold with dark text, the others slate.
  const chip = (key: string, label: string, isOn: boolean, onPress: () => void) =>
    isOn ? (
      <Text key={`${key}-on`} {...c.mono} backgroundColor={C.gold} color={C.dark} bold>{` ${label} `}</Text>
    ) : (
      <Box key={`${key}-chip`} backgroundColor={C.hair} paddingX={1}>
        <Button key={key} label={label} plain onPress={onPress} />
      </Box>
    )
  const tabs: Tab[] = ['today', 'week', 'month', 'year']
  const isTight = W < 40
  out.push(
    <Box key="tabs" width={W} flexDirection="row" justifyContent="space-between" marginTop={1}>
      <Box key="tabs-left" flexDirection="row" columnGap={1}>
        {tabs.map(t => chip(`tab-${t}`, isTight ? TITLES[t][0]! : TITLES[t][0] + TITLES[t].slice(1).toLowerCase(), t === v.tab, () => setTab(t)))}
      </Box>
      <Box key="tabs-money" flexDirection="row" columnGap={1}>
        {chip('cur-usd', '$', s.currency === 'usd', () => setMoney('usd'))}
        {chip('cur-eur', '€', s.currency === 'eur', () => setMoney('eur'))}
      </Box>
    </Box>,
  )

  // Who started the work, and a filter on it: shown once the SDK has done any work in this stretch.
  if (who.hasSdk || who.source !== 'all') {
    const lead = W >= 60 ? 'Started by' : ''
    const gaps = lead ? 4 : 3
    const counts = `You ${fmtInt(who.you)} · SDK ${fmtInt(who.sdk)}`
    out.push(
      <Box key="sources" width={W} flexDirection="row" columnGap={1} marginTop={1}>
        {lead && cell(c, 'src-lead', len(lead), [[lead, C.muted]])}
        {chip('src-all', 'All', who.source === 'all', () => who.set('all'))}
        {chip('src-you', 'You', who.source === 'you', () => who.set('you'))}
        {chip('src-sdk', 'SDK', who.source === 'sdk', () => who.set('sdk'))}
        {cell(c, 'src-counts', Math.max(0, W - len(lead) - 15 - gaps), [[counts, C.muted]])}
      </Box>,
    )
  }

  if (imp.phase !== 'idle') {
    out.push(<Box key="gap-import" height={1} />)
    out.push(importCard(c, W, imp, s, act))
  }

  if (taskCount(d) === 0 && Object.keys(d.n ?? {}).length === 0) {
    out.push(<Box key="gap-empty" height={1} />)
    out.push(line(c, 'empty', W, [[EMPTY[v.tab], C.text, true]]))
    out.push(line(c, 'empty-hint', W, [['Your first finished task shows up here.', C.muted]]))
    return <Box key="report" flexDirection="column" width={W}>{out}</Box>
  }

  // A wide desktop pane draws everything below as one picture; the terminal and narrow panes keep the text layout below.
  if (!isTerminal && W >= WIDE && 'Svg' in ui) {
    const { source, alt } = dashboardSvg(v, s, W)
    const { Svg } = ui
    out.push(<Box key="gap-dashboard" height={1} />, <Svg key="dashboard" source={source} alt={alt} />)
    return <Box key="report" flexDirection="column" width={W}>{out}</Box>
  }

  // Tiles: three, then two, then one per row as the pane narrows.
  const minutes = minutesSaved(d, s)
  const hours = fmtHours(minutes)
  const amount = (minutes / 60) * s.rate
  const worth = s.currency === 'eur' ? Math.round(amount).toLocaleString('de-DE') : fmtInt(amount)
  const tiles = [
    ['tile-hours', 'HOURS SAVED', hours, `${hours} h`, 'estimate'],
    ['tile-tasks', 'TASKS DONE', fmtInt(taskCount(d)), fmtInt(taskCount(d)), `${plural(v.activeDays, 'active day')}`],
    ['tile-worth', s.currency === 'eur' ? 'WORTH IN EUROS' : "DOLLARS' WORTH", worth, fmtMoney(amount, s.currency), `estimate at ${fmtMoney(s.rate, s.currency)}/h`],
  ] as const
  const per = tilesPerRow(W)
  const tileW = Math.floor((W - (per - 1)) / per)
  for (let r = 0; r * per < tiles.length; r++)
    out.push(
      <Box key={`tilerow-${r}`} width={W} flexDirection="row" columnGap={1} marginTop={r === 0 ? 1 : 0}>
        {tiles.slice(r * per, r * per + per).map(([key, label, digits, shown, foot]) => tile(c, key, tileW, label, digits, shown, foot))}
      </Box>,
    )

  // Activity: the chart and its one summary line.
  out.push(heading(c, 'h-chart', W, v.tab === 'year' ? 'Tasks by month' : 'Tasks by day'))
  out.push(...chart(c, W, v))
  out.push(line(c, 'summary', W, [[v.summary, C.green]]))

  // Cards: where the time went and models on the left, code on the right; stacked when narrow.
  const isTwo = W >= 92
  const leftW = isTwo ? Math.floor((W - 1) / 2) : W
  const rightW = isTwo ? W - 1 - leftW : W

  const kindMinutes = (k: Kind) =>
    k === 'coding' ? SIZES.reduce((a, z) => a + (d.sizes?.[z] ?? 0) * s.sizes[z], 0) : (d.tasks?.[k] ?? 0) * s.minutes[k]
  const kinds = KINDS.filter(k => (d.tasks?.[k] ?? 0) > 0)
  const maxKind = Math.max(0, ...kinds.map(k => d.tasks?.[k] ?? 0))
  const timeCard = card(c, 'card-time', leftW, 'Where the time went', inner =>
    kinds.length === 0
      ? [line(c, 'kinds-none', inner, [['No finished tasks in this stretch.', C.muted]])]
      : kinds.map(k => {
          const count = d.tasks?.[k] ?? 0
          return barRow(c, `kind-${k}`, inner, KIND_LABEL[k], KIND_COLOR[k], count, maxKind, `${plural(count, 'task')} · ${fmtHours(kindMinutes(k))} h`, kinds.length > 1)
        }),
  )

  const models = [...new Set([...Object.keys(d.models ?? {}), ...Object.keys(d.tokens ?? {})])].sort(
    (a, b) => (d.models?.[b] ?? 0) - (d.models?.[a] ?? 0) || (d.tokens?.[b]?.out ?? 0) - (d.tokens?.[a]?.out ?? 0),
  )
  const modelCard = card(c, 'card-models', leftW, 'Models and tokens', inner => {
    const wide = inner >= 44
    const colW = inner >= 56 ? 9 : 7
    const cols = wide ? ['Tasks', 'In', 'Out', 'Cached'] : ['Tasks', 'Out']
    const nameW = inner - cols.length * colW
    const row = (key: string, name: string, vals: string[], color = C.text) => (
      <Box key={key} width={inner} flexDirection="row" overflow="hidden">
        {cell(c, `${key}-n`, nameW, [[name, color]])}
        {vals.map((val, i) => cell(c, `${key}-${i}`, colW, [[val, color]], true))}
      </Box>
    )
    const rows: RenderChildren[] = [row('models-head', '', cols, C.muted)]
    for (const id of models) {
      const t = d.tokens?.[id] ?? {}
      const input = (t.in ?? 0) + (t.cacheRead ?? 0) + (t.cacheWrite ?? 0)
      const cached = input > 0 ? `${Math.round(((t.cacheRead ?? 0) / input) * 100)}%` : '-'
      const tasks = String(d.models?.[id] ?? 0)
      rows.push(row(`model-${id}`, modelName(id), wide ? [tasks, fmtCompact(input), fmtCompact(t.out ?? 0), cached] : [tasks, fmtCompact(t.out ?? 0)]))
    }
    if (n('judgeCalls') > 0) {
      const input = n('judgeIn') + n('judgeCacheRead') + n('judgeCacheWrite')
      const calls = plural(n('judgeCalls'), 'call')
      rows.push(row('tok-judge', 'Haiku judge', wide ? [calls.split(' ')[0]!, fmtCompact(input), fmtCompact(n('judgeOut')), '-'] : [calls.split(' ')[0]!, fmtCompact(n('judgeOut'))], C.muted))
      if (n('judgeFails') > 0) rows.push(line(c, 'tok-judge-fails', inner, [[`${plural(n('judgeFails'), 'judge call')} failed`, C.amber]]))
    }
    if (models.length === 0 && n('judgeCalls') === 0) return [line(c, 'models-none', inner, [['No model use in this stretch.', C.muted]])]
    return rows
  })

  const hasCode = (d.tasks?.coding ?? 0) > 0 || Object.keys(d.n ?? {}).some(k => !k.startsWith('judge'))
  const codeCard = card(c, 'card-code', rightW, 'Code', inner => {
    const rows: RenderChildren[] = []
    if (n('linesAdded') + n('linesRemoved') > 0 || n('files') > 0)
      rows.push(kv(c, 'code-lines', inner, 'Lines', [[`+${fmtInt(n('linesAdded'))}`, C.green], ['  '], [`−${fmtInt(n('linesRemoved'))}`, C.muted], [`  ·  ${plural(n('files'), 'file')}`, C.muted]]))
    const langs = Object.entries(d.langs ?? {}).sort((a, b) => b[1] - a[1])
    const langTotal = langs.reduce((a, [, x]) => a + x, 0)
    if (langTotal > 0) rows.push(kv(c, 'code-langs', inner, 'Languages', [[langs.slice(0, 3).map(([l, x]) => `${l} ${Math.round((x / langTotal) * 100)}%`).join(' · ')]]))
    const items = (pairs: [number, string, string?][]) => pairs.filter(([x]) => x > 0).map(([x, one, many]) => plural(x, one, many))
    const wrapped = (key: string, label: string, parts: string[]) => {
      const room = Math.max(10, inner - (inner >= 36 ? 11 : 9))
      const lines: string[] = []
      for (const part of parts) {
        const last = lines[lines.length - 1]
        if (last !== undefined && last.length + 3 + part.length <= room) lines[lines.length - 1] = `${last} · ${part}`
        else lines.push(part)
      }
      lines.forEach((text, i) => rows.push(kv(c, `${key}-${i}`, inner, i === 0 ? label : '', [[text]])))
    }
    wrapped('code-git', 'Git', items([[n('commits'), 'commit'], [n('pushes'), 'push', 'pushes'], [n('merges'), 'merge'], [n('rebases'), 'rebase'], [n('branches'), 'branch', 'branches']]))
    wrapped('code-github', 'GitHub', items([[n('prsOpened'), 'PR opened', 'PRs opened'], [n('prsMerged'), 'PR merged', 'PRs merged'], [n('issuesOpened'), 'issue opened', 'issues opened'], [n('issuesClosed'), 'issue closed', 'issues closed']]))
    const runs = n('testRuns')
    if (runs > 0) {
      const pass = Math.round(((runs - n('testFails')) / runs) * 100)
      rows.push(kv(c, 'code-tests', inner, 'Tests', [[`${plural(runs, 'run')} · `], [`${pass}% pass`, pass >= 90 ? C.green : C.amber], [` · ${fmtDuration(n('testMs'))}`, C.muted]]))
      if (n('testsPassed') + n('testsFailed') > 0)
        rows.push(kv(c, 'code-results', inner, 'Results', [[`${fmtInt(n('testsPassed'))} passed`, C.green], ['  '], [`${fmtInt(n('testsFailed'))} failed`, n('testsFailed') > 0 ? C.amber : C.muted]]))
    }
    if (n('builds') > 0) rows.push(kv(c, 'code-builds', inner, 'Builds', [[`${plural(n('builds'), 'run')} · `], [`${fmtInt(n('buildFails'))} failed`, n('buildFails') > 0 ? C.amber : C.muted]]))
    if ((d.tasks?.coding ?? 0) > 0) {
      const types = DEV_KINDS.filter(k => (d.dev?.[k] ?? 0) > 0).sort((a, b) => (d.dev?.[b] ?? 0) - (d.dev?.[a] ?? 0))
      const typeText = types.map(k => `${k[0]!.toUpperCase()}${k.slice(1)} ${d.dev?.[k]}`).join(' · ')
      rows.push(kv(c, 'code-types', inner, 'Task types', [[typeText || (s.judge ? 'not judged yet' : 'judge is off (/payback settings judge on)'), typeText ? C.text : C.muted]]))
      rows.push(kv(c, 'code-sizes', inner, 'Sizes', [[SIZES.map(z => `${z.toUpperCase()} ${d.sizes?.[z] ?? 0}`).join(' · '), C.muted]]))
    }
    return rows.length > 0 ? rows : [line(c, 'code-none', inner, [['No code work in this stretch.', C.muted]])]
  })

  out.push(<Box key="gap-cards" height={1} />)
  if (isTwo)
    out.push(
      <Box key="grid" width={W} flexDirection="row" columnGap={1}>
        <Box key="col-left" width={leftW} flexDirection="column" rowGap={1}>{[timeCard, modelCard]}</Box>
        <Box key="col-right" width={rightW} flexDirection="column">{hasCode ? [codeCard] : []}</Box>
      </Box>,
    )
  else out.push(<Box key="stack" width={W} flexDirection="column" rowGap={1}>{[timeCard, ...(hasCode ? [codeCard] : []), modelCard]}</Box>)

  out.push(line(c, 'foot', W, [['Hours and money are estimates. /payback settings changes them.', C.muted]]))
  return <Box key="report" flexDirection="column" width={W}>{out}</Box>
}

// ---------------------------------------------------------------- hooks

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      isFromSdk = ((await $.env.get('CLAUDE_CODE_ENTRYPOINT')) ?? '').startsWith('sdk')
      isTestSession = isFromSdk && isTempDir(e.cwd)
      await $.command.register({
        name: 'payback',
        description: 'Payback: what Claude did for you (tasks, code, git, tests, tokens) and the time and money it saved',
        argumentHint: '[settings [name value] | import [30d | from to | undo | cancel]]',
      })
    } catch {}
    return next(e)
  })

  on('command.run', { command: 'payback' }, async ($, e) => {
    const args = e.args.trim().split(/\s+/).filter(Boolean)
    if (args[0]?.toLowerCase() === 'settings') return { text: await settingsCommand($, args.slice(1)) }
    if (args[0]?.toLowerCase() === 'import') return { text: await importCommand($, args.slice(1)) }
    void openPane($)
    return { text: 'Opened Payback. Hours and money in it are estimates.' }
  }).catch(() => ({ text: 'Payback could not run that command. Try /payback again.' }))

  on('prompt.submit', ($, e, next) => {
    if (!e.command && !e.isMeta && !e.turnId && TYPED_ORIGINS.has(e.origin.kind) && !isSummaryJob(e.text)) typed = e.text
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', ($, e, next) => {
    if (!e.agentId && typed !== null) {
      cur = { ...newTask(), turnId: e.turnId, text: typed }
      typed = null
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const startedAt = await $.clock.now()
    const ran = await next(e)
    try {
      if (ran.deny !== undefined) return ran
      const ms = (await $.clock.now()) - startedAt
      const run = { tool: String(e.tool), input: e as unknown as Record<string, unknown>, result: ran.result, isOk: ran.isError !== true, output: ran.text ?? '', ms }
      const delta = toolDelta(run, cur)
      await record($, dayKey(await $.clock.now()), delta)
    } catch {}
    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    try {
      const day = dayKey(await $.clock.now())
      const delta: Day = {}
      if (e.usage)
        delta.tokens = {
          [e.usage.model]: { in: e.usage.input_tokens, out: e.usage.output_tokens, cacheRead: e.usage.cache_read_input_tokens, cacheWrite: e.usage.cache_creation_input_tokens },
        }
      const task = cur
      if (!e.agentId && task && task.turnId === e.turnId) {
        cur = null
        if (e.reason === 'answer') {
          const done = finishTask(task, e.usage?.model ?? 'unknown')
          Object.assign(delta, done.delta)
          const size = done.size
          if (size) {
            if ((await loadSettings($)).judge) {
              queue.push({ day, size, prompt: judgePrompt(task.text, task, task.files.size) })
              $.clock.after(50, () => void drain($))
            }
          }
        }
      }
      await record($, day, delta)
    } catch {}
    return next(e)
  })

  // The status bar button: shown in the hint line under the prompt while it is idle.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if (e.props.isDraft || e.props.isWorking) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    return (
      <Box key="hint" flexDirection="row">
        <Text dimColor wrap="truncate-end">{e.props.hint ? `${e.props.hint}  ` : ''}</Text>
        <Button key="open-payback" label="Payback" plain onPress={() => void openPane($)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const t = await read($, tab)
    const imp = await read($, importView)
    const source = await read($, sourceView)
    await read($, rev)
    const now = await $.clock.now()
    const [settings, days] = await Promise.all([loadSettings($), loadDays($, now)])
    const both = view(t, now, days).total
    const shown = Object.fromEntries(Object.entries(days).map(([k, d]) => [k, bySource(d, source)]))
    const who: Who = { source, you: taskCount(both), sdk: taskCount(both.sdk ?? {}), hasSdk: !isEmptyDay(both.sdk ?? {}), set: s => void update($, sourceView, () => s) }
    return drawPane($.ui.resolve(e), e.surface === 'terminal', view(t, now, shown), settings, e.props.bodyColumns, next => void update($, tab, () => next), money => void setCurrency($, money), imp, {
      importNow: () => void applyImport($),
      cancel: () => void cancelImport($),
      close: () => void setImport($, IDLE),
    }, who)
  })
}

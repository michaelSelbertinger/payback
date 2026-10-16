// Pure logic of Payback: no `$`, so the tests reach it directly.
import type { Counter, Currency, Day, DevKind, Kind, Settings, Size, Source, Tab } from '../types'

export const KINDS: Kind[] = ['coding', 'devops', 'emails', 'images', 'documents', 'research', 'questions', 'other']
export const KIND_LABEL: Record<Kind, string> = {
  coding: 'Coding',
  devops: 'DevOps & shell',
  emails: 'Emails',
  images: 'Images and video',
  documents: 'Documents',
  research: 'Research',
  questions: 'Questions & planning',
  other: 'Other',
}
export const DEV_KINDS: DevKind[] = ['feature', 'bugfix', 'refactor', 'tests', 'debug', 'docs', 'devops', 'review']
export const SIZES: Size[] = ['s', 'm', 'l']

export const DEFAULTS: Settings = {
  rate: 50,
  currency: 'usd',
  minutes: { devops: 20, emails: 10, documents: 30, images: 20, research: 25, questions: 10, other: 10 },
  sizes: { s: 15, m: 45, l: 120 },
  judge: false, // off until the person turns it on: it sends part of each coding request to a model
}

export function withDefaults(stored: unknown): Settings {
  const s = (stored ?? {}) as Partial<Settings>
  return {
    rate: s.rate ?? DEFAULTS.rate,
    currency: s.currency === 'eur' ? 'eur' : 'usd',
    minutes: { ...DEFAULTS.minutes, ...s.minutes },
    sizes: { ...DEFAULTS.sizes, ...s.sizes },
    judge: s.judge ?? DEFAULTS.judge,
  }
}

// ---------------------------------------------------------------- days

const DAY_MS = 86_400_000

/** Local noon of the day `ms` falls on: stepping whole days from noon never crosses a date when clocks change. */
export function noon(ms: number): Date {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12)
}

export function dayKey(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** The day `n` days before the day `ms` falls on, at local noon. */
export function daysBack(ms: number, n: number): number {
  return noon(ms).getTime() - n * DAY_MS
}

export function dayOfYear(ms: number): number {
  const d = noon(ms)
  return Math.round((d.getTime() - new Date(d.getFullYear(), 0, 1, 12).getTime()) / DAY_MS) + 1
}

type Tree = { [k: string]: number | Tree | undefined }

function addTree(a: Tree, b: Tree): Tree {
  const out: Tree = { ...a }
  for (const [k, v] of Object.entries(b)) {
    if (v === undefined) continue
    const cur = out[k]
    out[k] = typeof v === 'number' ? (typeof cur === 'number' ? cur : 0) + v : addTree((cur as Tree) ?? {}, v)
  }
  return out
}

/** Adds two days field by field; nested counts add, missing ones count as zero. */
export function addDays(a: Day, b: Day): Day {
  return addTree(a as Tree, b as Tree) as Day
}

/** A day as one source sees it: `you` the person's own sessions, `sdk` the ones the SDK started, `all` both. */
export function bySource(day: Day, source: Source): Day {
  const { sdk, ...own } = day
  return source === 'you' ? own : source === 'sdk' ? (sdk ?? {}) : addDays(own, sdk ?? {})
}

/** A request that only asks Claude to summarise an earlier session: housekeeping, no task. */
export const isSummaryJob = (text: string) => /^\s*Below is a conversation log from a Claude Code/.test(text)

/** A session run from a temp folder: where scripts test the harness, not real work. */
export const isTempDir = (cwd: string) =>
  /[\\/]AppData[\\/]Local[\\/]Temp([\\/]|$)|^\/tmp(\/|$)|^(\/private)?\/var\/folders\//i.test(cwd)

export function isEmptyDay(d: Day): boolean {
  const walk = (t: Tree): boolean => Object.values(t).every(v => (typeof v === 'number' ? v === 0 : v === undefined || walk(v)))
  return walk(d as Tree)
}

const sum = (r: Record<string, number | undefined> | undefined) => Object.values(r ?? {}).reduce<number>((a, v) => a + (v ?? 0), 0)

export const taskCount = (d: Day) => sum(d.tasks)

/** Days in a row with a finished task, counted back from today (or from yesterday while today has none yet). */
export function streak(days: Record<string, Day>, nowMs: number): number {
  let n = 0
  let i = taskCount(days[dayKey(nowMs)] ?? {}) > 0 ? 0 : 1
  while (taskCount(days[dayKey(daysBack(nowMs, i))] ?? {}) > 0) {
    n++
    i++
  }
  return n
}

export function minutesSaved(d: Day, s: Settings): number {
  let m = 0
  for (const k of KINDS) if (k !== 'coding') m += (d.tasks?.[k] ?? 0) * s.minutes[k]
  for (const z of SIZES) m += (d.sizes?.[z] ?? 0) * s.sizes[z]
  return m
}

// ---------------------------------------------------------------- tasks

export type TaskSignals = {
  tools: string[]
  codeEdits: number
  docWrites: number
  mediaWrites: number
  devShell: number
  added: number
  removed: number
}

const MAIL = /mail|gmail|outlook|inbox|imap/i
const MEDIA_TOOL = /image|video|sprite|animat|portrait|screencast|gif_creator|3d_model|asset_preview/i
const DOC_TOOL = /(^|_)(docs?|document|slides?|sheets?|spreadsheet|pptx|xlsx|docx|pdf|word|excel|powerpoint)(_|$)/i
const RESEARCH_TOOL = /search|fetch|transcript|get_page_text|read_page|navigate/i
/** Connected tools that are building software: a game engine, a code host, an error tracker, a database. */
const CODE_TOOL = /unity|godot|github|gitlab|sentry|supabase|postgres|sqlite|mysql|prisma/i
/** Connected tools that run infrastructure. */
const OPS_TOOL = /docker|kube|k8s|aws|gcloud|azure|vercel|netlify|cloudflare|terraform|ssh/i
/** Tools that only look, ask or keep notes: a task of these alone is a question answered or a plan made. */
const LOOKING = new Set(['Read', 'Grep', 'Glob', 'LSP', 'ToolSearch', 'AskUserQuestion', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'Skill', 'EnterPlanMode', 'ExitPlanMode'])
const SHELL = new Set(['Bash', 'PowerShell', 'Monitor'])

/** One kind per task, by the tools it used; coding first, then the order of the original report. */
export function classify(t: TaskSignals): Kind {
  // Names are read only off connected (MCP) tools: the engine's own ToolSearch or FetchInboxMessage say nothing of the task.
  const mcp = t.tools.filter(n => n.startsWith('mcp__'))
  if (t.codeEdits > 0 || t.devShell > 0 || mcp.some(n => CODE_TOOL.test(n))) return 'coding'
  if (mcp.some(n => MAIL.test(n))) return 'emails'
  if (t.mediaWrites > 0 || mcp.some(n => MEDIA_TOOL.test(n))) return 'images'
  if (t.docWrites > 0 || mcp.some(n => DOC_TOOL.test(n))) return 'documents'
  if (t.tools.some(n => n === 'WebSearch' || n === 'WebFetch') || mcp.some(n => RESEARCH_TOOL.test(n))) return 'research'
  if (t.tools.some(n => SHELL.has(n)) || mcp.some(n => OPS_TOOL.test(n))) return 'devops'
  if (t.tools.every(n => LOOKING.has(n))) return 'questions'
  return 'other'
}

/** Size of a coding task from the lines it changed, until the judge says otherwise. */
export function sizeByLines(lines: number): Size {
  return lines < 40 ? 's' : lines < 250 ? 'm' : 'l'
}

/** A typed request in flight: what its tools did so far. */
export type Task = TaskSignals & { files: Set<string> }

export const newTask = (): Task => ({
  files: new Set(), tools: [], codeEdits: 0, docWrites: 0, mediaWrites: 0, devShell: 0, added: 0, removed: 0,
})

/** One finished tool call, as the live hook sees it and as a transcript replays it. */
export type ToolRun = {
  tool: string
  input: Record<string, unknown>
  /** The tool's own record (an Edit's `structuredPatch`), when it has one. */
  result: unknown
  isOk: boolean
  /** What the tool printed, for a test runner's pass and fail counts. */
  output: string
  ms: number
}

/** What one finished tool call adds to its day, also noting it on the task in flight. */
export function toolDelta(r: ToolRun, task: Task | null): Day {
  const delta: Day = {}
  const counts: Partial<Record<Counter, number>> = {}
  const add = (k: Counter, x: number) => x !== 0 && (counts[k] = (counts[k] ?? 0) + x)
  task?.tools.push(r.tool)

  const path = r.tool === 'NotebookEdit' ? r.input.notebook_path : r.input.file_path
  if (r.isOk && (r.tool === 'Edit' || r.tool === 'Write' || r.tool === 'NotebookEdit') && typeof path === 'string') {
    const lines =
      r.tool === 'NotebookEdit'
        ? { added: String(r.input.new_source ?? '').split('\n').length, removed: 0 }
        : countPatch(r.result as PatchResult | undefined)
    const fk = fileKind(path)
    add('linesAdded', lines.added)
    add('linesRemoved', lines.removed)
    if (!task || !task.files.has(path)) add('files', 1)
    if (fk.lang && lines.added + lines.removed > 0) delta.langs = { [fk.lang]: lines.added + lines.removed }
    if (task) {
      task.files.add(path)
      task.added += lines.added
      task.removed += lines.removed
      if (fk.kind === 'code') task.codeEdits++
      if (fk.kind === 'doc') task.docWrites++
      if (fk.kind === 'media') task.mediaWrites++
    }
  }

  if ((r.tool === 'Bash' || r.tool === 'PowerShell') && typeof r.input.command === 'string') {
    const facts = parseShell(r.input.command)
    const isForeground = r.input.run_in_background !== true
    if (r.isOk) for (const [k, x] of Object.entries(facts.n)) add(k as Counter, x ?? 0)
    if (isForeground && facts.isTest) {
      add('testRuns', 1)
      add('testFails', r.isOk ? 0 : 1)
      add('testMs', r.ms)
      const t = parseTestCounts(r.output)
      add('testsPassed', t.passed)
      // A run that exited cleanly failed nothing: its output's "failed" is a test's own name or log line.
      add('testsFailed', r.isOk ? 0 : t.failed)
    }
    if (isForeground && facts.isBuild) {
      add('builds', 1)
      add('buildFails', r.isOk ? 0 : 1)
    }
    if (task && facts.isDev) task.devShell++
  }

  if (Object.keys(counts).length > 0) delta.n = counts
  return delta
}

/** What a task that finished with an answer adds: one task of its kind, its model, and a size when it is coding. */
export function finishTask(task: Task, model: string): { delta: Day; kind: Kind; size?: Size } {
  const kind = classify(task)
  const delta: Day = { tasks: { [kind]: 1 }, models: { [model]: 1 } }
  if (kind !== 'coding') return { delta, kind }
  const size = sizeByLines(task.added + task.removed)
  delta.sizes = { [size]: 1 }
  return { delta, kind, size }
}

// ---------------------------------------------------------------- files

const LANG: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript',
  js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  py: 'Python', ipynb: 'Python', cs: 'C#', java: 'Java', kt: 'Kotlin', go: 'Go', rs: 'Rust',
  rb: 'Ruby', php: 'PHP', c: 'C', h: 'C', cpp: 'C++', cc: 'C++', hpp: 'C++', swift: 'Swift',
  dart: 'Dart', scala: 'Scala', lua: 'Lua', r: 'R', ex: 'Elixir', exs: 'Elixir',
  html: 'HTML', htm: 'HTML', css: 'CSS', scss: 'CSS', sass: 'CSS', less: 'CSS',
  vue: 'Vue', svelte: 'Svelte', sql: 'SQL', sh: 'Shell', bash: 'Shell', zsh: 'Shell', ps1: 'PowerShell',
  json: 'Config', yaml: 'Config', yml: 'Config', toml: 'Config', xml: 'Config', ini: 'Config',
  shader: 'Shader', hlsl: 'Shader', glsl: 'Shader', gradle: 'Config', dockerfile: 'Config',
}
const DOC_EXT = new Set(['md', 'mdx', 'txt', 'rst', 'docx', 'doc', 'pptx', 'xlsx', 'csv', 'pdf', 'odt'])
const MEDIA_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'mp4', 'mov', 'webm', 'mp3', 'wav'])

export type FileKind = { lang: string | null; kind: 'code' | 'doc' | 'media' | 'other' }

export function fileKind(path: string): FileKind {
  const name = path.split(/[\\/]/).pop()!.toLowerCase()
  const ext = name === 'dockerfile' || name === 'makefile' ? name : (name.includes('.') ? name.split('.').pop()! : '')
  if (LANG[ext]) return { lang: LANG[ext], kind: 'code' }
  if (ext === 'makefile') return { lang: 'Config', kind: 'code' }
  if (DOC_EXT.has(ext)) return { lang: ext === 'md' || ext === 'mdx' ? 'Markdown' : null, kind: 'doc' }
  if (MEDIA_EXT.has(ext)) return { lang: null, kind: 'media' }
  return { lang: null, kind: 'other' }
}

type Hunk = { lines: string[] }
type PatchResult = {
  type?: string
  content?: string
  structuredPatch?: readonly Hunk[]
  gitDiff?: { additions: number; deletions: number }
}

/** Lines an Edit or Write changed, from its result. */
export function countPatch(r: PatchResult | undefined): { added: number; removed: number } {
  if (!r) return { added: 0, removed: 0 }
  if (r.gitDiff) return { added: r.gitDiff.additions, removed: r.gitDiff.deletions }
  let added = 0
  let removed = 0
  for (const hunk of r.structuredPatch ?? [])
    for (const line of hunk.lines) {
      if (line.startsWith('+')) added++
      else if (line.startsWith('-')) removed++
    }
  if (added + removed === 0 && r.type === 'create' && r.content) added = r.content.split('\n').length
  return { added, removed }
}

// ---------------------------------------------------------------- shell

export type ShellFacts = { n: Partial<Record<Counter, number>>; isTest: boolean; isBuild: boolean; isDev: boolean }

// Runners match at the head of a command, so `pip install pytest` or `cat jest.config.js` is no test run.
const TEST = /^(pytest|py\.test|jest|vitest|mocha|rspec|phpunit|ctest|go\s+test|cargo\s+(nextest|test)|dotnet\s+test|mvnw?\s+(\S+\s+)*test|(\.[\\/])?gradlew?(\.bat)?\s+(\S+\s+)*test|(python3?|py)\s+-m\s+(pytest|unittest)|(npm|pnpm|yarn|bun)\s+(run\s+)?test|claude\s+plugin\s+test|flutter\s+test|deno\s+test)\b/i
const BUILD = /^(tsc|cargo\s+build|go\s+build|dotnet\s+build|mvnw?\s+(package|install|compile)|(\.[\\/])?gradlew?(\.bat)?\s+(assemble|build)|make|cmake\s+--build|vite\s+build|next\s+build|webpack|ng\s+build|(npm|pnpm|yarn|bun)\s+(run\s+)?build|msbuild)\b/i
// Env assignments, PowerShell's `&` and runner wrappers in front of the command itself.
const WRAPPER = /^(?:&\s*)?(?:[A-Z_][A-Z0-9_]*=\S*\s+)*(?:(?:npx|bunx|pnpm\s+(?:exec|dlx)|uv\s+run|poetry\s+run|pipenv\s+run)\s+)?/i
const GIT = /^(?:&\s*)?git(?:\.exe)?((?:\s+-[Cc]\s+(?:"[^"]*"|'[^']*'|\S+))*)\s+([a-z-]+)(.*)$/i
const GH = /^(?:&\s*)?gh(?:\.exe)?\s+(pr|issue)\s+(create|merge|close)\b/i

/** Quoted strings and here-docs removed, so a commit message holding `; git push` counts nothing. */
function stripQuoted(cmd: string): string {
  return cmd
    .replace(/<<-?\s*['"]?(\w+)['"]?[\s\S]*?\n\s*\1\b/g, '')
    .replace(/@'[\s\S]*?'@|@"[\s\S]*?"@/g, '""')
    .replace(/"(?:\\.|[^"\\])*"|'[^']*'/g, '""')
}

/** What one Bash or PowerShell command did for the developer: git, gh, test and build runs. */
export function parseShell(cmd: string): ShellFacts {
  const n: Partial<Record<Counter, number>> = {}
  const inc = (k: Counter) => (n[k] = (n[k] ?? 0) + 1)
  let isTest = false
  let isBuild = false
  let isDev = false
  const clean = stripQuoted(cmd)
  for (const raw of clean.split(/&&|\|\||;|\||\r?\n|\bif\s*\(\s*\$\?\s*\)\s*\{|[{}]/)) {
    const seg = raw.trim()
    const head = seg.replace(WRAPPER, '')
    if (TEST.test(head)) isTest = isDev = true
    else if (BUILD.test(head)) isBuild = isDev = true
    if (/^(?:&\s*)?(git|gh)(\.exe)?\s/i.test(seg)) isDev = true
    const git = GIT.exec(seg)
    if (git) {
      const sub = git[2]!.toLowerCase()
      const rest = git[3] ?? ""
      if (/--dry-run|(^|\s)-n(\s|$)/.test(rest) && (sub === 'commit' || sub === 'push')) continue
      if (sub === 'commit') inc('commits')
      else if (sub === 'push') inc('pushes')
      else if (sub === 'merge' && !/--abort/.test(rest)) inc('merges')
      else if (sub === 'rebase' && !/--abort|--continue|--skip|--quit/.test(rest)) inc('rebases')
      else if ((sub === 'checkout' && /(^|\s)-[bB]\s/.test(rest)) || (sub === 'switch' && /(^|\s)(-[cC]|--create)\s/.test(rest))) inc('branches')
      else if (sub === 'branch' && /^\s+[^-\s]\S*\s*\S*\s*$/.test(rest)) inc('branches')
      continue
    }
    const gh = GH.exec(seg)
    if (gh) {
      const what = gh[1]!.toLowerCase()
      const act = gh[2]!.toLowerCase()
      if (what === 'pr' && act === 'create') inc('prsOpened')
      if (what === 'pr' && act === 'merge') inc('prsMerged')
      if (what === 'issue' && act === 'create') inc('issuesOpened')
      if (what === 'issue' && act === 'close') inc('issuesClosed')
    }
  }
  return { n, isTest, isBuild: isBuild && !isTest, isDev }
}

const lastNum = (text: string, re: RegExp) => {
  let found: number | null = null
  for (const m of text.matchAll(re)) found = Number(m[1])
  return found
}

/** Passed and failed test counts from a runner's summary (pytest, jest, vitest, cargo, dotnet, go's own words). */
export function parseTestCounts(output: string): { passed: number; failed: number } {
  // ponytail: last summary line wins; a runner printing per-suite totals after the grand total reads low.
  const passed = lastNum(output, /(\d+)\s+passed/gi) ?? lastNum(output, /Passed:\s*(\d+)/g) ?? 0
  const failed = lastNum(output, /(\d+)\s+failed/gi) ?? lastNum(output, /Failed:\s*(\d+)/g) ?? 0
  return { passed, failed }
}

// ---------------------------------------------------------------- judge

export const JUDGE_MODEL = 'claude-haiku-5-5'

export const JUDGE_SYSTEM =
  'You label one finished software task. Reply with two words and nothing else: TYPE SIZE. ' +
  'TYPE is one of feature, bugfix, refactor, tests, debug, docs, devops, review. ' +
  'SIZE is S, M or L: the time a senior developer would need by hand, S under 30 minutes, M 30 to 90 minutes, L over 90 minutes.'

export function judgePrompt(text: string, t: TaskSignals, files: number): string {
  const tools = Object.entries(t.tools.reduce<Record<string, number>>((a, n) => ((a[n] = (a[n] ?? 0) + 1), a), {}))
    .map(([n, c]) => `${n} x${c}`)
    .join(', ')
  return `Request: ${text.slice(0, 1500)}\nTools: ${tools || 'none'}\nLines: +${t.added} -${t.removed} across ${files} files`
}

export function parseJudge(reply: string): { kind: DevKind; size: Size } | null {
  const m = /\b(feature|bugfix|refactor|tests|debug|docs|devops|review)\b\W+\b([sml])\b/i.exec(reply)
  return m ? { kind: m[1]!.toLowerCase() as DevKind, size: m[2]!.toLowerCase() as Size } : null
}

// ---------------------------------------------------------------- views

export type Bucket = { label: string; value: number; isCurrent: boolean; isFuture: boolean }
export type View = {
  tab: Tab
  title: string
  dates: string
  total: Day
  chart: Bucket[]
  summary: string
  activeDays: number
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']
const short = (ms: number) => {
  const d = new Date(ms)
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`
}
/** `2026-09-19` reads `19 Sep`. */
export const shortDay = (key: string) => {
  const [y, m, d] = key.split('-').map(Number)
  return short(new Date(y ?? 0, (m ?? 1) - 1, d ?? 1, 12).getTime())
}
const long = (ms: number) => `${WEEKDAYS[new Date(ms).getDay()]} ${short(ms)} ${new Date(ms).getFullYear()}`

export const TITLES: Record<Tab, string> = { today: 'TODAY', week: 'WEEK', month: 'MONTH', year: 'YEAR' }

/** Everything a tab draws, from the stored days: totals, the chart's buckets and the summary line. */
export function view(tab: Tab, nowMs: number, days: Record<string, Day>): View {
  const span = tab === 'today' ? 1 : tab === 'week' ? 7 : tab === 'month' ? 30 : dayOfYear(nowMs)
  const keys = Array.from({ length: span }, (_, i) => daysBack(nowMs, span - 1 - i))
  const dayOf = (ms: number) => days[dayKey(ms)] ?? {}
  const total = keys.reduce((a, ms) => addDays(a, dayOf(ms)), {} as Day)
  const activeDays = keys.filter(ms => taskCount(dayOf(ms)) > 0).length

  let chart: Bucket[]
  if (tab === 'year') {
    const now = new Date(nowMs)
    chart = MONTHS.map((label, m) => ({
      label: label[0]!,
      value: keys.filter(ms => new Date(ms).getMonth() === m).reduce((a, ms) => a + taskCount(dayOf(ms)), 0),
      isCurrent: m === now.getMonth(),
      isFuture: m > now.getMonth(),
    }))
  } else {
    const n = tab === 'month' ? 30 : 7
    chart = Array.from({ length: n }, (_, i) => {
      const ms = daysBack(nowMs, n - 1 - i)
      return { label: n === 7 ? WEEKDAYS[new Date(ms).getDay()]! : String(new Date(ms).getDate()), value: taskCount(dayOf(ms)), isCurrent: i === n - 1, isFuture: false }
    })
  }

  let summary: string
  if (tab === 'today' || tab === 'week') {
    const s = streak(days, nowMs)
    summary = `Streak: ${s} ${s === 1 ? 'day' : 'days'} in a row`
  } else {
    const best = tab === 'year' ? chart.reduce((a, b) => (b.value > a.value ? b : a), chart[0]!) : null
    const bestDay = keys.reduce((a, ms) => (taskCount(dayOf(ms)) > taskCount(dayOf(a)) ? ms : a), keys[0]!)
    const bestText =
      tab === 'year'
        ? `Best month: ${MONTHS[chart.indexOf(best!)]} (${best!.value} tasks)`
        : `Best day: ${short(bestDay)} (${taskCount(dayOf(bestDay))} tasks)`
    summary = `${bestText} · ${activeDays} active ${activeDays === 1 ? 'day' : 'days'} of ${span}`
  }

  const first = keys[0]!
  const dates = tab === 'today' ? long(nowMs) : `${short(first)} – ${short(nowMs)} ${new Date(nowMs).getFullYear()}`
  return { tab, title: TITLES[tab], dates, total, chart, summary, activeDays }
}

// ---------------------------------------------------------------- drawing helpers

/** Big numerals, three rows tall, in heavy box-drawing characters. */
const GLYPHS: Record<string, [string, string, string]> = {
  '0': ['┏━┓', '┃ ┃', '┗━┛'],
  '1': ['╺┓ ', ' ┃ ', '╺┻╸'],
  '2': ['┏━┓', '┏━┛', '┗━╸'],
  '3': ['╺━┓', ' ━┫', '╺━┛'],
  '4': ['╻ ╻', '┗━┫', '  ╹'],
  '5': ['┏━╸', '┗━┓', '╺━┛'],
  '6': ['┏━╸', '┣━┓', '┗━┛'],
  '7': ['╺━┓', '  ┃', '  ╹'],
  '8': ['┏━┓', '┣━┫', '┗━┛'],
  '9': ['┏━┓', '┗━┫', '╺━┛'],
  '.': [' ', ' ', '╹'],
  ',': [' ', ' ', '┛'],
}

/** The three rows of `text` in big numerals, or null when it holds a character the font lacks or is wider than `width`. */
export function bigText(text: string, width: number): [string, string, string] | null {
  const rows: [string, string, string] = ['', '', '']
  for (const ch of text) {
    const g = GLYPHS[ch]
    if (!g) return null
    for (let r = 0; r < 3; r++) rows[r] += (rows[r] ? ' ' : '') + g[r]
  }
  return [...rows[0]].length <= width ? rows : null
}

export const fmtInt = (n: number) => Math.round(n).toLocaleString('en-US')
/** `$1,234` or `1.234 €`: each currency written the way its readers write it. */
export const fmtMoney = (amount: number, currency: Currency) =>
  currency === 'eur' ? `${Math.round(amount).toLocaleString('de-DE')} €` : `$${fmtInt(amount)}`

export const fmtHours = (minutes: number) => {
  const h = minutes / 60
  return h < 10 ? (Math.round(h * 10) / 10).toFixed(1) : fmtInt(h)
}
export const fmtCompact = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n))
export const fmtDuration = (ms: number) => {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

/** `claude-opus-5-5` reads `Opus 5.5`; an id it cannot read stays as it is. */
export function modelName(id: string): string {
  const m = /claude-([a-z]+)-(\d+)(?:-(\d+))?/i.exec(id)
  return m ? `${m[1]![0]!.toUpperCase()}${m[1]!.slice(1)} ${m[2]}${m[3] && m[3].length < 3 ? `.${m[3]}` : ''}` : id
}

/** Tiles per row for a body `width` cells wide. */
export const tilesPerRow = (width: number) => (width >= 66 ? 3 : width >= 44 ? 2 : 1)

const EIGHTHS = ' ▁▂▃▄▅▆▇█'

/** Row `row` (0 top, 2 bottom) of a three-row bar for `value` against `max`. */
export function barCell(value: number, max: number, row: number): string {
  if (max <= 0 || value <= 0) return row === 2 ? '▁' : ' '
  const eighths = Math.max(1, Math.round((value / max) * 24))
  return EIGHTHS[Math.min(8, Math.max(0, eighths - (2 - row) * 8))] ?? " "
}

export function fit(text: string, width: number): string {
  const chars = [...text]
  return chars.length <= width ? text : width <= 1 ? chars.slice(0, width).join('') : chars.slice(0, width - 1).join('') + '…'
}

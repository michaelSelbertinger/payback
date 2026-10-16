import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Day } from '../types'
import { addDays, classify, countPatch, dayKey, dayOfYear, daysBack, parseShell, parseTestCounts, streak } from '../hooks/stats'
import type { TaskSignals } from '../hooks/stats'

const NOW = new Date(2026, 9, 16, 15).getTime() // Fri 16 Oct 2026, 15:00 local
const SURFACES = ['terminal', 'desktop'] as const
const signals = (s: Partial<TaskSignals>): TaskSignals => ({ tools: [], codeEdits: 0, docWrites: 0, mediaWrites: 0, devShell: 0, added: 0, removed: 0, ...s })

describe('sorting a task by its tools', () => {
  test('each kind', () => {
    expect(classify(signals({ tools: ['Edit'], codeEdits: 1 }))).toBe('coding')
    expect(classify(signals({ tools: ['Bash'], devShell: 1 }))).toBe('coding')
    expect(classify(signals({ tools: ['mcp__gmail__send_email'] }))).toBe('emails')
    expect(classify(signals({ tools: ['mcp__x__generate_portrait'] }))).toBe('images')
    expect(classify(signals({ tools: ['Write'], mediaWrites: 1 }))).toBe('images')
    expect(classify(signals({ tools: ['Write'], docWrites: 1 }))).toBe('documents')
    expect(classify(signals({ tools: ['WebSearch', 'WebFetch'] }))).toBe('research')
    expect(classify(signals({ tools: ['Read', 'Grep'] }))).toBe('questions')
    expect(classify(signals({ tools: [] }))).toBe('questions')
    expect(classify(signals({ tools: ['Bash', 'Read'] }))).toBe('devops')
    expect(classify(signals({ tools: ['mcp__docker__ps'] }))).toBe('devops')
    expect(classify(signals({ tools: ['mcp__unity-mcp__Unity_RunCommand'] }))).toBe('coding')
    expect(classify(signals({ tools: ['SendUserFile', 'Read'] }))).toBe('other')
    expect(classify(signals({ tools: ['WebSearch', 'Edit'], codeEdits: 1 }))).toBe('coding')
    expect(classify(signals({ tools: ['ToolSearch', 'Read'] }))).toBe('questions')
    expect(classify(signals({ tools: ['FetchInboxMessage', 'SearchSkills'] }))).toBe('other') // engine tools say nothing
    expect(classify(signals({ tools: ['mcp__exa__web_search'] }))).toBe('research')
  })
})

describe('shell commands', () => {
  test('chained git in bash, quoted text ignored', () => {
    const f = parseShell('git add . && git commit -m "fix; git push --force" && git push origin main')
    expect(f.n).toEqual({ commits: 1, pushes: 1 })
  })
  test('powershell chains, here-strings and git -C', () => {
    const f = parseShell("git -C C:\\repo commit -m @'\nline; git merge x\n'@; if ($?) { git push }")
    expect(f.n).toEqual({ commits: 1, pushes: 1 })
  })
  test('dry runs, aborts and listings count nothing', () => {
    expect(parseShell('git push --dry-run && git merge --abort && git branch && git branch -d old').n).toEqual({})
  })
  test('branches, merges, rebases and gh', () => {
    const f = parseShell('git checkout -b feat/x; git switch -c y; git merge main; git rebase main; gh pr create --fill; gh pr merge 3; gh issue create -t t; gh issue close 4')
    expect(f.n).toEqual({ branches: 2, merges: 1, rebases: 1, prsOpened: 1, prsMerged: 1, issuesOpened: 1, issuesClosed: 1 })
  })
  test('test and build runs', () => {
    expect(parseShell('cd app && npm test -- --watch=false').isTest).toBe(true)
    expect(parseShell('python -m pytest -q').isTest).toBe(true)
    expect(parseShell('dotnet test').isTest).toBe(true)
    expect(parseShell('npm run build').isBuild).toBe(true)
    expect(parseShell('ls -la').isDev).toBe(false)
    expect(parseShell('uv run pytest -x').isTest).toBe(true)
    expect(parseShell('& npx vitest run').isTest).toBe(true)
    expect(parseShell('CI=1 npm test').isTest).toBe(true)
    for (const cmd of ['pip install pytest', 'npm i -D vitest', 'cat jest.config.js', 'ls node_modules/.bin/jest']) expect(parseShell(cmd).isTest, cmd).toBe(false)
    expect(parseShell('npm i webpack').isBuild).toBe(false)
    expect(parseShell('npm i webpack').isDev).toBe(false)
    expect(parseTestCounts('Tests:       1 failed, 5 passed, 6 total')).toEqual({ passed: 5, failed: 1 })
    expect(parseTestCounts('==== 12 passed in 0.31s ====')).toEqual({ passed: 12, failed: 0 })
  })
})

test('lines from a patch', () => {
  expect(countPatch({ structuredPatch: [{ lines: [' a', '-b', '+c', '+d'] }] })).toEqual({ added: 2, removed: 1 })
  expect(countPatch({ gitDiff: { additions: 7, deletions: 3 }, structuredPatch: [] })).toEqual({ added: 7, removed: 3 })
  expect(countPatch({ type: 'create', content: 'a\nb\nc', structuredPatch: [] })).toEqual({ added: 3, removed: 0 })
})

describe('days', () => {
  test('adding days together', () => {
    const a: Day = { tasks: { coding: 1 }, tokens: { m: { in: 5 } }, n: { commits: 1 } }
    const b: Day = { tasks: { coding: 2, other: 1 }, tokens: { m: { in: 1, out: 2 } }, sizes: { s: 1 } }
    expect(addDays(a, b)).toEqual({ tasks: { coding: 3, other: 1 }, tokens: { m: { in: 6, out: 2 } }, n: { commits: 1 }, sizes: { s: 1 } })
  })
  test('the streak', () => {
    const days: Record<string, Day> = {}
    for (const i of [0, 1, 2, 4]) days[dayKey(daysBack(NOW, i))] = { tasks: { other: 1 } }
    expect(streak(days, NOW)).toBe(3)
    delete days[dayKey(NOW)]
    expect(streak(days, NOW)).toBe(2) // today has none yet: the run up to yesterday still stands
    expect(streak({}, NOW)).toBe(0)
  })
  test('the day of the year, and stepping days at local noon', () => {
    expect(dayOfYear(new Date(2026, 0, 1, 0, 5).getTime())).toBe(1)
    expect(dayOfYear(NOW)).toBe(289)
    expect(dayOfYear(new Date(2026, 11, 31, 23, 50).getTime())).toBe(365)
    expect(dayOfYear(new Date(2028, 11, 31, 1).getTime())).toBe(366)
    // Across the spring and autumn clock changes the date still steps by one.
    expect(dayKey(daysBack(new Date(2026, 2, 30, 0, 30).getTime(), 1))).toBe('2026-03-29')
    expect(dayKey(daysBack(new Date(2026, 9, 26, 23, 30).getTime(), 1))).toBe('2026-10-25')
  })
})

// ---------------------------------------------------------------- through the engine

function bottoms(on: On) {
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('tool.call', ($, e) =>
    e.tool === 'Bash' && e.command.includes('fail')
      ? { isError: true, result: 'exit 1', text: '1 failed, 3 passed' }
      : { result: { structuredPatch: [{ lines: ['+a', '+b', '-c'] }] }, text: '' },
  )
}

/** The store beneath the plugin, in memory, readable by the test. */
function memStore(on: On, seed: Record<string, unknown> = {}) {
  const mem = new Map<string, unknown>(Object.entries(JSON.parse(JSON.stringify(seed))))
  on('store.get', ($, e) => ({ value: mem.get(e.key) }))
  on('store.set', ($, e) => (mem.set(e.key, JSON.parse(JSON.stringify(e.value))), { value: undefined }))
  on('store.delete', ($, e) => (mem.delete(e.key), { value: undefined }))
  on('store.keys', () => ({ value: [...mem.keys()] }))
  return mem
}

const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as const
const ZERO = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const usage = (model: string) => ({ model, input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 })
const finish = (turnId: string, extra: object = {}) =>
  ({ turnId, answer: 'done', durationMs: 1000, isAborted: false, reason: 'answer', usage: usage('claude-opus-5-5'), ...extra }) as const

test('counts only typed prompts that finish, and judges coding tasks with Haiku', async ($, on) => {
  const store = memStore(on)
  const clock = mock.clock(on, { now: NOW })
  bottoms(on)
  const judged: string[] = []
  on('model.complete', ($, e) => {
    judged.push(e.model)
    return { value: { isAnswered: true as const, text: 'bugfix M', usage: { ...ZERO, input_tokens: 300, output_tokens: 3 } } }
  })

  // A typed prompt that edits code and commits: one coding task.
  await $.prompt.submit({ text: 'fix the login bug', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'fix the login bug', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: 'src/login.ts', old_string: 'c', new_string: 'a\nb' })
  await $.tool.call({ tool: 'Bash', command: 'git commit -am fix && git push' })
  await $.tool.call({ tool: 'Bash', command: 'npm test fail' })
  await $.turn.complete(finish('t1'))

  // A slash command, an interrupted prompt and a helper agent: no tasks.
  await $.prompt.submit({ text: '/commit', wait: false, origin: { kind: 'composer' }, command: { name: 'commit', args: '' } })
  await $.turn.start({ text: '', turnId: 't2' })
  await $.turn.complete(finish('t2'))
  await $.prompt.submit({ text: 'research x', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'research x', turnId: 't3' })
  await $.turn.complete(finish('t3', { reason: 'aborted', isAborted: true, usage: undefined }))
  await $.turn.start({ text: 'helper', turnId: 't4', agentId: 'a1' })
  await $.turn.complete(finish('t4', { agentId: 'a1', usage: usage('claude-haiku-5-5') }))

  await clock.advance(100)
  const year = store.get('days:2026') as Record<string, Day>
  const day = year['2026-10-16']!
  expect(day.tasks).toEqual({ coding: 1 })
  expect(day.models).toEqual({ 'claude-opus-5-5': 1 })
  expect(day.n).toMatchObject({ linesAdded: 2, linesRemoved: 1, files: 1, commits: 1, pushes: 1, testRuns: 1, testFails: 1, testsPassed: 3, testsFailed: 1 })
  expect(day.langs).toEqual({ TypeScript: 3 })
  expect(judged).toEqual(['claude-haiku-5-5'])
  expect(day.dev).toEqual({ bugfix: 1 })
  expect(day.sizes).toEqual({ s: 0, m: 1 })
  expect(day.n).toMatchObject({ judgeCalls: 1, judgeIn: 300, judgeOut: 3 })
  expect(day.tokens?.['claude-opus-5-5']).toEqual({ in: 20, out: 40, cacheRead: 200, cacheWrite: 0 })
  expect(day.tokens?.['claude-haiku-5-5']).toEqual({ in: 10, out: 20, cacheRead: 100, cacheWrite: 0 })
})

test('a failed judge keeps the lines-based size and counts the failure', async ($, on) => {
  const store = memStore(on)
  const clock = mock.clock(on, { now: NOW })
  bottoms(on)
  on('model.complete', () => ({ value: { isAnswered: false as const, reason: 'api-error' as const, status: 529, error: 'overloaded' as const, usage: ZERO } }))
  await $.prompt.submit({ text: 'add a field', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'add a field', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: 'a.py', old_string: 'c', new_string: 'a\nb' })
  await $.turn.complete(finish('t1'))
  await clock.advance(100)
  const day = (store.get('days:2026') as Record<string, Day>)['2026-10-16']!
  expect(day.sizes).toEqual({ s: 1 })
  expect(day.dev).toBeUndefined()
  expect(day.n).toMatchObject({ judgeCalls: 1, judgeFails: 1 })
})

test('settings list and change', async ($, on) => {
  const store = memStore(on)
  const listed = await $.command.run({ command: 'payback', args: 'settings', ...RUN })
  expect(listed.text).toContain('rate       $50 per hour')
  expect((await $.command.run({ command: 'payback', args: 'settings rate 75', ...RUN })).text).toBe('Hourly rate is now $75.')
  expect((await $.command.run({ command: 'payback', args: 'settings emails 15', ...RUN })).text).toBe('emails is now 15 minutes per task.')
  expect((await $.command.run({ command: 'payback', args: 'settings rate nope', ...RUN })).text).toContain('number above 0')
  expect(store.get('settings') as object).toMatchObject({ rate: 75, minutes: { emails: 15 } })
  expect((await $.command.run({ command: 'payback', args: 'settings currency euro', ...RUN })).text).toContain('Money is now shown in euro')
  expect((await $.command.run({ command: 'payback', args: 'settings currency yen', ...RUN })).text).toContain('currency eur or')
  const listedEur = (await $.command.run({ command: 'payback', args: 'settings', ...RUN })).text
  expect(listedEur).toContain('currency   euro')
  expect(listedEur).toContain('rate       75 € per hour')
  expect(store.get('settings') as object).toMatchObject({ rate: 75, currency: 'eur' })
})

// ---------------------------------------------------------------- the pane

const SEEDED: Record<string, unknown> = {
  'days:2026': {
    '2026-10-16': { tasks: { coding: 2, research: 1 }, models: { 'claude-opus-5-5': 3 }, sizes: { s: 1, m: 1 }, dev: { feature: 1, bugfix: 1 }, langs: { TypeScript: 90, Python: 30 }, n: { linesAdded: 100, linesRemoved: 20, files: 4, commits: 2, testRuns: 2, testMs: 5000 }, tokens: { 'claude-opus-5-5': { in: 1000, out: 2000, cacheRead: 9000 } } },
    '2026-10-15': { tasks: { other: 1 }, models: { 'claude-opus-5-5': 1 } },
    '2026-10-14': { tasks: { emails: 2 }, models: { 'claude-sonnet-5-5': 2 } },
    '2026-03-02': { tasks: { documents: 4 }, models: { 'claude-opus-5-5': 4 } },
  },
}

const pane = (bodyColumns: number) => ({
  component: 'Pane' as const,
  requestId: 'payback',
  props: { title: 'Payback', isFocused: false, bodyColumns, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 80 }, view: {} },
})

test('each tab draws its own title and chart', async ($, on) => {
  memStore(on, SEEDED)
  mock.clock(on, { now: NOW })
  for (const surface of SURFACES) {
    // 50 columns on the desktop is below the picture's minimum, so this checks its text layout; the picture has its own test below
    const ui = await $.ui.mount({ plugin: 'payback', surface, ...pane(surface === 'desktop' ? 50 : 90) })
    expect((await ui.find({ key: 'title' }))?.text).toContain('TODAY')
    expect((await ui.find({ key: 'title' }))?.text).toContain('Fr 16 Oct 2026')
    const isTerminal = surface === 'terminal'
    const chartText = async () => (isTerminal ? (await ui.find({ key: 'chart-labels' }))?.text : String((await ui.find({ type: 'Svg' }))?.props.alt))
    if (isTerminal) expect(await ui.find({ type: 'Text', text: '╺┻╸' })).toBeDefined() // the bottom row of a big 1
    else expect(await ui.find({ type: 'Text', text: '1.4 h' })).toBeDefined() // plain large type off the terminal
    expect(await chartText()).toMatch(isTerminal ? /Sa\s+Su\s+Mo\s+Tu\s+We\s+Th\s+Fr/ : /Sa 0, Su 0, Mo 0, Tu 0, We 2, Th 1, Fr 3/)
    expect((await ui.find({ key: 'summary' }))?.text).toBe('Streak: 3 days in a row')
    expect((await ui.find({ key: 'code-git-0' }))?.text).toContain('2 commits')

    // The currency switch: euro written the German way, dollars back again.
    await ui.press({ key: 'cur-eur' })
    expect(await ui.find({ type: 'Text', text: 'estimate at 50 €/h' })).toBeDefined()
    if (!isTerminal) expect(await ui.find({ type: 'Text', text: '71 €' })).toBeDefined()
    await ui.press({ key: 'cur-usd' })
    expect(await ui.find({ type: 'Text', text: 'estimate at $50/h' })).toBeDefined()
    if (!isTerminal) expect(await ui.find({ type: 'Text', text: '$71' })).toBeDefined()

    await ui.press({ key: 'tab-week' })
    expect((await ui.find({ key: 'title' }))?.text).toContain('WEEK')
    expect((await ui.find({ key: 'title' }))?.text).toContain('10 Oct – 16 Oct 2026')
    expect((await ui.find({ key: 'kind-emails' }))?.text).toContain('2')

    await ui.press({ key: 'tab-month' })
    expect((await ui.find({ key: 'title' }))?.text).toContain('MONTH')
    expect(await chartText()).toMatch(isTerminal ? /30 days ago/ : /^Tasks: (\d+ \d+, ){29}16 3$/)
    expect((await ui.find({ key: 'summary' }))?.text).toContain('Best day: 16 Oct (3 tasks) · 3 active days of 30')

    await ui.press({ key: 'tab-year' })
    expect((await ui.find({ key: 'title' }))?.text).toContain('YEAR')
    expect(await chartText()).toMatch(isTerminal ? /J\s+F\s+M\s+A\s+M\s+J\s+J\s+A\s+S\s+O\s+N\s+D/ : /J 0, F 0, M 4, .*O 6, N -, D -/)
    expect((await ui.find({ key: 'summary' }))?.text).toContain('Best month: Oct (6 tasks) · 4 active days of 289')
    await ui.press({ key: 'tab-today' })
    await ui.unmount()
  }
})

test('the empty state', async ($, on) => {
  const store = memStore(on)
  mock.clock(on, { now: NOW })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'payback', surface, ...pane(60) })
    expect((await ui.find({ key: 'empty' }))?.text).toBe('Nothing finished yet today.')
    expect((await ui.find({ key: 'empty-hint' }))?.text).toBe('Your first finished task shows up here.')
    expect(await ui.find({ key: 'tilerow-0' })).toBeUndefined()
    await ui.unmount()
  }
})

test('a narrow pane stacks the tiles and no row is wider than the pane', async ($, on) => {
  memStore(on, SEEDED)
  mock.clock(on, { now: NOW })
  for (const surface of SURFACES) {
    for (const [width, rows] of (surface === 'desktop' ? [[30, 3], [50, 2]] : [[30, 3], [50, 2], [100, 1]]) as readonly (readonly [number, number])[]) {
      const ui = await $.ui.mount({ plugin: 'payback', surface, ...pane(width) })
      for (let r = 0; r < 3; r++) expect(Boolean(await ui.find({ key: `tilerow-${r}` }))).toBe(r < rows)
      for (const box of await ui.findAll({ type: 'Box' })) {
        // Containers hold many rows; every single row in them is checked on its own.
        if (!box.key || /^(tile|report|card-[a-z]+$|col-|grid|gap|stack)/.test(box.key)) continue
        expect([...box.text].length <= width, `${box.key} is ${[...box.text].length} wide at ${width}: ${box.text}`).toBe(true)
      }
      await ui.unmount()
    }
  }
})

test('the status bar button draws under an idle prompt and steps aside while working', async ($, on) => {
  memStore(on)
  on('ui.render', ($, e) => ({ type: 'Text', props: {}, children: ['engine'] }) as never)
  for (const surface of SURFACES) {
    const idle = await $.ui.mount({ plugin: 'payback', surface, component: 'PromptHint', props: { isDraft: false, isWorking: false, hint: '? for shortcuts' } })
    expect((await idle.find({ type: 'Button', key: 'open-payback' }))?.text).toBe('Payback')
    expect(await idle.find({ type: 'Text', text: '? for shortcuts' })).toBeDefined()
    await idle.unmount()
    const busy = await $.ui.mount({ plugin: 'payback', surface, component: 'PromptHint', props: { isDraft: false, isWorking: true, hint: 'esc to interrupt' } })
    expect(await busy.find({ key: 'open-payback' })).toBeUndefined()
    await busy.unmount()
  }
})

test('/payback answers at once', async ($, on) => {
  memStore(on)
  const r = await $.command.run({ command: 'payback', args: '', ...RUN })
  expect(r.text).toBe('Opened Payback. Hours and money in it are estimates.')
})

// ---------------------------------------------------------------- the wide desktop pane draws its body as one picture

test('a wide desktop pane draws the body as an SVG, the terminal and a narrow pane keep the text layout', async ($, on) => {
  memStore(on, SEEDED)
  mock.clock(on, { now: NOW })

  const wide = await $.ui.mount({ plugin: 'payback', surface: 'desktop', ...pane(140) })
  const svg = await wide.find({ type: 'Svg' })
  expect(svg).toBeDefined()
  expect((await wide.findAll({ type: 'Svg' })).length).toBe(1)
  const source = String(svg?.props.source)
  for (const part of ['HOURS SAVED', 'TASKS DONE', 'WHERE THE TIME WENT', 'MODELS AND TOKENS', 'Opus 5.5', '+100', 'Hours and money are estimates.']) expect(source).toContain(part)
  expect(String(svg?.props.alt)).toContain('Payback, today: 3 tasks')
  expect(source.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
  expect(await wide.find({ key: 'tilerow-0' })).toBeUndefined()
  expect(await wide.find({ key: 'tab-week' })).toBeDefined() // the tabs stay real buttons above the picture
  await wide.press({ key: 'tab-year' })
  expect(String((await wide.find({ type: 'Svg' }))?.props.source)).toContain('TASKS BY MONTH')
  await wide.unmount()

  // The picture starts at 62 columns on the desktop; the terminal and anything narrower keep the text layout (whose chart is an Svg too).
  for (const [surface, columns, isPicture] of [['terminal', 140, false], ['desktop', 61, false], ['desktop', 62, true]] as const) {
    const ui = await $.ui.mount({ plugin: 'payback', surface, ...pane(columns) })
    expect((await ui.findAll({ type: 'Svg' })).some(el => String(el.props.source).includes('HOURS SAVED'))).toBe(isPicture)
    expect(Boolean(await ui.find({ key: 'tilerow-0' }))).toBe(!isPicture)
    await ui.unmount()
  }
})

test('the text layout wraps a long Git row and keeps the model columns apart', async ($, on) => {
  memStore(on, {
    'days:2026': { '2026-10-16': { tasks: { coding: 5 }, models: { 'claude-opus-5-5': 977 }, tokens: { 'claude-opus-5-5': { in: 100, out: 15_600_000, cacheRead: 6_300_000_000 } }, n: { commits: 633, pushes: 39, merges: 26, rebases: 4, branches: 13 } } },
  })
  mock.clock(on, { now: NOW })
  const ui = await $.ui.mount({ plugin: 'payback', surface: 'terminal', ...pane(100) })
  expect((await ui.find({ key: 'code-git-0' }))?.text).toContain('633 commits')
  expect((await ui.find({ key: 'code-git-1' }))?.text).toContain('13 branches')
  const row = (await ui.find({ key: 'model-claude-opus-5-5' }))?.text ?? ''
  expect(row).toContain('977')
  expect(row).toContain('6.3B') // billions of tokens are written 6.3B, not 6300.0M
  await ui.unmount()
})

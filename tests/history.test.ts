import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Day } from '../types'
import { createImporter } from '../hooks/history'

// ---------------------------------------------------------------- transcript lines, shaped as Claude Code writes them

const at = (day: number, min: number) => new Date(2026, 9, day, 10, min).toISOString() // 10:xx local on 2026-10-<day>
const USAGE = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 }
const line = (o: object) => JSON.stringify({ parentUuid: null, isSidechain: false, entrypoint: 'claude-desktop', ...o })
const prompt = (uuid: string, text: string, min: number, extra: object = {}, day = 10) =>
  line({ type: 'user', uuid, timestamp: at(day, min), message: { role: 'user', content: text }, ...extra })
const answer = (id: string, min: number, extra: object = {}, day = 10) =>
  line({ type: 'assistant', timestamp: at(day, min), message: { id, model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text: 'Done.' }], usage: USAGE }, ...extra })
const use = (id: string, msg: string, name: string, input: object, min: number) =>
  line({ type: 'assistant', timestamp: at(10, min), message: { id: msg, model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'tool_use', id, name, input }], usage: USAGE } })
const result = (id: string, min: number, record: object, isError = false, text = '') =>
  line({ type: 'user', timestamp: at(10, min), message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: text, is_error: isError }] }, toolUseResult: record })

const RANGE = { fromDay: '2026-10-01', untilDay: '2026-10-16', untilMs: Infinity }

function replay(files: { lines: string[]; isSubagent?: boolean }[], range = RANGE) {
  const importer = createImporter(range)
  for (const f of files) {
    const reader = importer.file(f.isSubagent ?? false)
    for (const text of f.lines) reader.line(text)
    reader.end()
  }
  return importer.result()
}
const day10 = (r: ReturnType<typeof replay>): Day => r.days['2026-10-10'] ?? {}

describe('reading transcripts', () => {
  test('a typed request answered is one task; commands, injected text, meta, summaries and interrupts are not', () => {
    const r = replay([{
      lines: [
        prompt('p1', 'Explain the login flow', 0),
        answer('m1', 1),
        prompt('c1', '<command-name>/compact</command-name>', 2),
        answer('m2', 3),
        prompt('i1', '<system-reminder>\nnote</system-reminder>', 4),
        prompt('meta', 'hidden', 5, { isMeta: true }),
        prompt('sum', 'This session is being continued from a previous conversation', 6, { isCompactSummary: true }),
        prompt('p2', 'Refactor everything', 7),
        use('t0', 'm3', 'Read', { file_path: 'a.ts' }, 8),
        prompt('x', '[Request interrupted by user]', 9),
        prompt('side', 'helper task', 10, { isSidechain: true }),
        answer('m4', 11, { isSidechain: true }),
      ],
    }])
    expect(day10(r).tasks).toEqual({ questions: 1 })
    expect(day10(r).models).toEqual({ 'claude-opus-5-5': 1 })
    expect(r.sessions).toBe(1)
  })

  test('a response split over several lines counts its tokens once', () => {
    const r = replay([{ lines: [prompt('p1', 'Hi', 0), use('t1', 'm1', 'Read', {}, 1), answer('m1', 1)] }])
    expect(day10(r).tokens).toEqual({ 'claude-opus-5-5': { in: 10, out: 5, cacheRead: 100, cacheWrite: 0 } })
  })

  test('edits, commits and a failing test run, by the live tracker rules', () => {
    const r = replay([{
      lines: [
        prompt('p1', 'Fix the bug', 0),
        use('e1', 'm1', 'Edit', { file_path: 'src/a.ts', old_string: 'x', new_string: 'y' }, 1),
        result('e1', 1, { filePath: 'src/a.ts', structuredPatch: [{ lines: ['-x', '+y', '+z'] }] }),
        use('b1', 'm2', 'Bash', { command: 'npm test' }, 2),
        result('b1', 3, { stdout: 'Tests: 1 failed, 4 passed' }, true, 'Tests: 1 failed, 4 passed'),
        use('b2', 'm3', 'Bash', { command: 'git commit -am fix && git push' }, 4),
        result('b2', 4, { stdout: '' }),
        answer('m4', 5),
      ],
    }])
    const d = day10(r)
    expect(d.tasks).toEqual({ coding: 1 })
    expect(d.sizes).toEqual({ s: 1 })
    expect(d.langs).toEqual({ TypeScript: 3 })
    expect(d.n).toMatchObject({ linesAdded: 2, linesRemoved: 1, files: 1, commits: 1, pushes: 1, testRuns: 1, testFails: 1, testMs: 60_000, testsPassed: 4, testsFailed: 1 })
  })

  test('every tool a task used sorts it, not only the ones whose results are read', () => {
    const r = replay([{ lines: [prompt('p1', 'What changed in Vite 6?', 0), use('w1', 'm1', 'WebSearch', { query: 'vite 6' }, 1), result('w1', 1, {}), answer('m2', 2), prompt('p2', 'Restart the container', 3), use('s1', 'm3', 'Bash', { command: 'docker compose restart app' }, 4), result('s1', 4, { stdout: '' }), answer('m4', 5)] }])
    expect(day10(r).tasks).toEqual({ research: 1, devops: 1 })
  })

  test('a Read result is skipped without being parsed', () => {
    const r = replay([{ lines: [prompt('p1', 'Read it', 0), use('r1', 'm1', 'Read', { file_path: 'big.txt' }, 1), `{"type":"user","message":{"content":[{"tool_use_id":"r1","type":"tool_result","content":"not json at all`, answer('m2', 2)] }])
    expect(r.badLines).toBe(0)
    expect(day10(r).tasks).toEqual({ questions: 1 })
  })

  test('history copied into a second file counts once', () => {
    const lines = [prompt('p1', 'Build it', 0), answer('m1', 1)]
    const r = replay([{ lines }, { lines: [...lines, prompt('p2', 'And test it', 2), answer('m2', 3)] }])
    expect(day10(r).tasks).toEqual({ questions: 2 })
    expect(day10(r).tokens?.['claude-opus-5-5']?.out).toBe(10)
  })

  test('days outside the range and subagent prompts are left out', () => {
    const r = replay([
      { lines: [prompt('late', 'Today', 0, {}, 16), answer('m1', 1, {}, 16), prompt('early', 'Long ago', 0, {}, 1), answer('m2', 1, {}, 1)] },
      { isSubagent: true, lines: [prompt('a1', 'helper', 0, { isSidechain: true }), answer('m4', 1, { isSidechain: true })] },
    ], { fromDay: '2026-10-02', untilDay: '2026-10-16', untilMs: Infinity })
    expect(Object.keys(r.days)).toEqual(['2026-10-10'])
    expect(day10(r).tasks).toBeUndefined()
    expect(day10(r).tokens?.['claude-opus-5-5']?.out).toBe(5) // the subagent's tokens count, its prompt is no task
    expect(r.sessions).toBe(1)
  })

  test('SDK sessions count apart; their tests in a temp folder and summary jobs do not count', () => {
    const sdk = { entrypoint: 'sdk-py', cwd: 'C:\\Users\\me\\Projects\\assistant\\marketing' }
    const temp = { entrypoint: 'sdk-py', cwd: 'C:\\Users\\me\\AppData\\Local\\Temp' }
    const r = replay([
      { lines: [prompt('j1', 'Write the draft for article 3', 0, sdk), answer('m1', 1, sdk)] },
      { lines: [prompt('j2', 'Below is a conversation log from a Claude Code coding session. Create a summary', 0, sdk), answer('m2', 1, sdk)] },
      { lines: [prompt('t1', 'Reply only: OK', 0, temp), answer('m3', 1, temp)] },
      { lines: [prompt('y1', 'Mine', 0), answer('m4', 1)] },
    ])
    expect(day10(r).tasks).toEqual({ questions: 1 })
    expect(day10(r).sdk?.tasks).toEqual({ questions: 1 })
    expect(day10(r).sdk?.tokens?.['claude-opus-5-5']?.out).toBe(10) // the summary job's tokens are still spent
    expect(day10(r).tokens?.['claude-opus-5-5']?.out).toBe(5)
    expect([r.sessions, r.sdkSessions, r.testSessions]).toEqual([1, 2, 1])
  })
})

// ---------------------------------------------------------------- the whole import, through the engine

const NOW = new Date(2026, 9, 16, 15).getTime()
const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as const
const ROOT = 'C:/Users/me/.claude/projects'
const FILE = `${ROOT}/proj/s1.jsonl`
const TRANSCRIPT = [
  prompt('p1', 'Fix the bug', 0),
  use('e1', 'm1', 'Edit', { file_path: 'src/a.ts', old_string: 'x', new_string: 'y' }, 1),
  result('e1', 1, { structuredPatch: [{ lines: ['-x', '+y'] }] }),
  answer('m2', 2),
  prompt('p2', 'What is next?', 3),
  answer('m3', 4),
  prompt('p0', 'Before live tracking began, today', -60, {}, 16), // 09:00, before the 09:30 cut-off
  answer('m0', -59, {}, 16),
  prompt('p3', 'Already tracked live', 0, {}, 16), // 10:00, the live tracker's
  answer('m4', 1, {}, 16),
].join('\n')

function memStore(on: On, seed: Record<string, unknown> = {}) {
  const mem = new Map<string, unknown>(Object.entries(JSON.parse(JSON.stringify(seed))))
  on('store.get', ($, e) => ({ value: mem.get(e.key) }))
  on('store.set', ($, e) => (mem.set(e.key, JSON.parse(JSON.stringify(e.value))), { value: undefined }))
  on('store.delete', ($, e) => (mem.delete(e.key), { value: undefined }))
  on('store.keys', () => ({ value: [...mem.keys()] }))
  return mem
}

/** The engine hands hooks the path as the platform spells it; compare with forward slashes. */
const norm = (path: string) => path.replaceAll('\\', '/')

function home(on: On) {
  on('env.get', ($, e) => ({ value: e.name === 'USERPROFILE' ? 'C:/Users/me' : e.name === 'OS' ? 'Windows_NT' : undefined }))
  on('fs.exists', ($, e) => ({ value: norm(e.path) === ROOT }))
  const entry = (name: string, kind: 'dir' | 'file') => ({ name, kind, size: TRANSCRIPT.length, mtimeMs: NOW, isLink: false })
  on('fs.list', ($, e) => ({ value: norm(e.path) === ROOT ? [entry('proj', 'dir')] : norm(e.path) === `${ROOT}/proj` ? [entry('s1.jsonl', 'file')] : [] }))
  on('fs.read', ($, e) => ({ value: norm(e.path) === FILE ? TRANSCRIPT : '' }))
}

const PANE = {
  component: 'Pane' as const,
  requestId: 'payback',
  props: { title: 'Payback', isFocused: false, bodyColumns: 90, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 80 }, view: {} },
}

test('import: a preview first, saved on Import, the same run twice counts once, undo removes it', async ($, on) => {
  const LIVE_SINCE = new Date(2026, 9, 16, 9, 30).getTime()
  const store = memStore(on, { 'days:2026': { '2026-10-16': { tasks: { other: 1 } } }, 'tracked-since-ms': LIVE_SINCE })
  const clock = mock.clock(on, { now: NOW })
  home(on)
  const run = async (args: string) => (await $.command.run({ command: 'payback', args, ...RUN })).text

  expect(await run('import 2026-10-20')).toContain('Nothing to import: Payback has counted everything since 16 Oct itself.')
  expect(await run('import yesterday')).toContain('YYYY-MM-DD')
  expect(await run('import')).toContain('nothing is saved until you press Import')
  await clock.advance(10)
  expect(store.has('imported:2026')).toBe(false) // a scan saves nothing

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'payback', surface, ...PANE })
    expect((await ui.find({ key: 'imp-found' }))?.text).toBe('Found 3 tasks on 2 days in 1 session')
    expect((await ui.find({ key: 'imp-range' }))?.text).toBe('all kept history to 16 Oct')
    await ui.unmount()
  }

  const ui = await $.ui.mount({ plugin: 'payback', surface: 'desktop', ...PANE })
  await ui.press({ key: 'imp-go' })
  expect((store.get('imported:2026') as Record<string, Day>)['2026-10-10']?.tasks).toEqual({ coding: 1, questions: 1 })
  expect(Object.keys(store.get('imported:2026') as object)).toEqual(['2026-10-10', '2026-10-16'])
  expect((store.get('imported:2026') as Record<string, Day>)['2026-10-16']?.tasks).toEqual({ questions: 1 }) // only the morning before 09:30
  expect((await ui.find({ key: 'imp-done' }))?.text).toBe('Imported 3 tasks, all kept history to 16 Oct.')
  await ui.press({ key: 'imp-close' })
  expect(await ui.find({ key: 'card-import' })).toBeUndefined()
  await ui.press({ key: 'tab-week' })
  expect(String((await ui.find({ type: 'Svg' }))?.props.source)).toContain('1 task') // the imported coding task, in the picture
  await ui.unmount()

  await run('import')
  await clock.advance(10)
  const again = await $.ui.mount({ plugin: 'payback', surface: 'terminal', ...PANE })
  await again.press({ key: 'imp-go' })
  expect((store.get('imported:2026') as Record<string, Day>)['2026-10-10']?.tasks).toEqual({ coding: 1, questions: 1 })
  await again.unmount()

  expect(await run('import undo')).toBe('Removed the imported history. Live tracking is untouched.')
  expect(store.has('imported:2026')).toBe(false)
  expect(store.get('days:2026')).toEqual({ '2026-10-16': { tasks: { other: 1 } } })
  expect(store.get('tracked-since-ms')).toBe(LIVE_SINCE)
})

test('import: cancel during the preview saves nothing', async ($, on) => {
  const store = memStore(on)
  const clock = mock.clock(on, { now: NOW })
  home(on)
  await $.command.run({ command: 'payback', args: 'import 30d', ...RUN })
  await clock.advance(10)
  const ui = await $.ui.mount({ plugin: 'payback', surface: 'terminal', ...PANE })
  await ui.press({ key: 'imp-cancel' })
  expect(await ui.find({ key: 'card-import' })).toBeUndefined()
  expect(store.has('imported:2026')).toBe(false)
  await ui.unmount()
})

test('import: a missing transcripts folder says so in plain words', async ($, on) => {
  memStore(on)
  const clock = mock.clock(on, { now: NOW })
  on('env.get', ($, e) => ({ value: e.name === 'USERPROFILE' ? 'C:/Users/me' : undefined }))
  on('fs.exists', () => ({ value: false }))
  await $.command.run({ command: 'payback', args: 'import', ...RUN })
  await clock.advance(10)
  const ui = await $.ui.mount({ plugin: 'payback', surface: 'desktop', ...PANE })
  expect(norm((await ui.find({ key: 'imp-error' }))?.text ?? '')).toBe(`There are no transcripts in ${ROOT}.`)
  await ui.unmount()
})

// ---------------------------------------------------------------- live tracking in a session the SDK started

const BOTTOMS = (on: On) => {
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('tool.call', () => ({ result: { structuredPatch: [{ lines: ['+a'] }] }, text: '' }))
}
const LIVE_USAGE = { model: 'claude-opus-5-5', input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

async function liveTask($: Engine, text: string) {
  await $.prompt.submit({ text, wait: false, origin: { kind: 'sdk' } })
  await $.turn.start({ text, turnId: text })
  await $.tool.call({ tool: 'Edit', file_path: 'a.ts', old_string: 'x', new_string: 'a' })
  await $.turn.complete({ turnId: text, answer: 'ok', durationMs: 1, isAborted: false, reason: 'answer', usage: LIVE_USAGE })
}

test('live: a session the SDK started counts apart, its summary jobs and its temp-folder tests not at all', async ($, on) => {
  const store = memStore(on, { settings: { judge: false } })
  mock.clock(on, { now: NOW })
  let entrypoint = 'sdk-py'
  on('env.get', ($, e) => ({ value: e.name === 'CLAUDE_CODE_ENTRYPOINT' ? entrypoint : undefined }))
  BOTTOMS(on)

  await $.session.start({ cwd: 'C:/Users/me/Projects/assistant/marketing', surface: null, isInteractive: false })
  await liveTask($, 'Write the draft')
  await liveTask($, 'Below is a conversation log from a Claude Code coding session. Summarise it.')
  const day = () => (store.get('days:2026') as Record<string, Day>)['2026-10-16']!
  expect(day().tasks).toBeUndefined()
  expect(day().sdk?.tasks).toEqual({ coding: 1 })
  expect(day().sdk?.n).toMatchObject({ linesAdded: 2 })

  await $.session.start({ cwd: 'C:/Users/me/AppData/Local/Temp', surface: null, isInteractive: false })
  await liveTask($, 'Reply only: OK')
  expect(day().sdk?.tasks).toEqual({ coding: 1 })

  entrypoint = 'claude-desktop' // back to a person's session, so no other test inherits the SDK's
  await $.session.start({ cwd: 'C:/Users/me', surface: 'desktop', isInteractive: true })
  await liveTask($, 'Mine')
  expect(day().tasks).toEqual({ coding: 1 })
})

test('the pane: who started the work, and a filter on it', async ($, on) => {
  memStore(on, {
    'days:2026': { '2026-10-16': { tasks: { coding: 2 }, models: { 'claude-opus-5-5': 2 }, sdk: { tasks: { documents: 3 }, models: { 'claude-opus-5-5': 3 } } } },
  })
  mock.clock(on, { now: NOW })
  for (const [surface, columns] of [['terminal', 90], ['desktop', 50], ['desktop', 140]] as const) {
    const ui = await $.ui.mount({ plugin: 'payback', surface, ...PANE, props: { ...PANE.props, bodyColumns: columns } })
    expect((await ui.find({ key: 'sources' }))?.text).toContain('You 2 · SDK 3')
    if (columns === 140) {
      // the picture: the same rows, as text inside it
      const body = async () => String((await ui.find({ type: 'Svg' }))?.props.source)
      expect(await body()).toMatch(/Coding[\s\S]*Documents/)
      await ui.press({ key: 'src-sdk' })
      expect(await body()).not.toContain('Coding')
      expect(await body()).toContain('3 tasks')
      await ui.press({ key: 'src-you' })
      expect(await body()).not.toContain('Documents')
      expect(await body()).toContain('2 tasks')
      await ui.press({ key: 'src-all' })
      await ui.unmount()
      continue
    }
    expect((await ui.find({ key: 'kind-coding' }))?.text).toContain('2 tasks')
    expect((await ui.find({ key: 'kind-documents' }))?.text).toContain('3 tasks')
    await ui.press({ key: 'src-sdk' })
    expect(await ui.find({ key: 'kind-coding' })).toBeUndefined()
    expect((await ui.find({ key: 'kind-documents' }))?.text).toContain('3 tasks')
    await ui.press({ key: 'src-you' })
    expect((await ui.find({ key: 'kind-coding' }))?.text).toContain('2 tasks')
    expect(await ui.find({ key: 'kind-documents' })).toBeUndefined()
    await ui.press({ key: 'src-all' })
    await ui.unmount()
  }
})

// ---------------------------------------------------------------- large transcripts are streamed through the shell

const BS = String.fromCharCode(92)

function bigHome(on: On, name: string, os: string | undefined) {
  on('env.get', ($, e) => ({ value: e.name === 'USERPROFILE' || e.name === 'HOME' ? 'C:/Users/me' : e.name === 'OS' ? os : undefined }))
  on('fs.exists', ($, e) => ({ value: norm(e.path) === ROOT }))
  const entry = (n: string, kind: 'dir' | 'file') => ({ name: n, kind, size: 5_000_000, mtimeMs: NOW, isLink: false })
  on('fs.list', ($, e) => ({ value: norm(e.path) === ROOT ? [entry('proj', 'dir')] : norm(e.path) === `${ROOT}/proj` ? [entry(name, 'file')] : [] }))
  const spawned: (readonly string[])[] = []
  on('process.spawn', async function* ($, e) {
    spawned.push(e.argv)
    yield { stream: 'stdout' as const, text: TRANSCRIPT.slice(0, 40) } // cut mid-line, as a pipe does
    yield { stream: 'stdout' as const, text: TRANSCRIPT.slice(40) }
    return { value: { code: 0, signal: null } }
  })
  return spawned
}

async function scanBig($: Engine, on: On, name: string, os: string | undefined) {
  memStore(on, { 'tracked-since-ms': new Date(2026, 9, 16, 9, 30).getTime() })
  const clock = mock.clock(on, { now: NOW })
  const spawned = bigHome(on, name, os)
  await $.command.run({ command: 'payback', args: 'import', ...RUN })
  await clock.advance(10)
  const ui = await $.ui.mount({ plugin: 'payback', surface: 'desktop', ...PANE })
  return { spawned, ui }
}

test('import: a large transcript is streamed through cmd on Windows, spaces and brackets in its path are fine', async ($, on) => {
  const { spawned, ui } = await scanBig($, on, 'My Chats (work).jsonl', 'Windows_NT')
  expect(spawned).toEqual([['cmd', '/c', 'type', `${ROOT}/proj/My Chats (work).jsonl`.replaceAll('/', BS)]])
  expect((await ui.find({ key: 'imp-found' }))?.text).toBe('Found 3 tasks on 2 days in 1 session') // lines cut in the middle were put back together
  await ui.unmount()
})

test('import: a large transcript is streamed through cat elsewhere', async ($, on) => {
  const { spawned, ui } = await scanBig($, on, 's1.jsonl', undefined)
  expect(spawned).toEqual([['cat', `${ROOT}/proj/s1.jsonl`]])
  expect((await ui.find({ key: 'imp-found' }))?.text).toBe('Found 3 tasks on 2 days in 1 session')
  await ui.unmount()
})

test('import: a Windows path cmd would read as a command is skipped, never handed to it', async ($, on) => {
  const { spawned, ui } = await scanBig($, on, 'a&b.jsonl', 'Windows_NT')
  expect(spawned).toEqual([])
  expect((await ui.find({ key: 'imp-skipped' }))?.text).toContain('1 unreadable file')
  await ui.unmount()
})

// Replays Claude Code's own transcripts (~/.claude/projects/**/*.jsonl) into days, by the live tracker's rules.
// Pure: it takes lines; reading the files is the caller's.
import type { Day } from '../types'
import { addDays, dayKey, finishTask, isEmptyDay, isTempDir, newTask, toolDelta } from './stats'
import type { Task } from './stats'

/** Tools whose results the replay reads; any other result line (a Read's whole file) is skipped unparsed. */
const TRACKED = new Set(['Edit', 'Write', 'NotebookEdit', 'Bash', 'PowerShell'])

/** Text that is no typed request: slash commands, their output, and what the engine injects. */
const NOT_TYPED = /^\s*(<command-name>|<command-message>|<command-args>|<local-command|<system-reminder>|<bash-input>|<bash-stdout>|<bash-stderr>|<task-notification>|<user-prompt-submit-hook>|Caveat:|This session is being continued from a previous conversation|Below is a conversation log from a Claude Code)/

export type ImportRange = {
  /** First day counted, `YYYY-MM-DD`. */
  fromDay: string
  /** First day not counted: the day after live tracking began, or after the end of the range asked for. */
  untilDay: string
  /** The moment live tracking began: nothing from then on is read, so a day it shares with the import counts once. */
  untilMs: number
}

export type ImportResult = {
  days: Record<string, Day>
  /** Interactive sessions read. */
  sessions: number
  /** Sessions the SDK started (an assistant, a script): counted apart, under `sdk`. */
  sdkSessions: number
  /** SDK sessions run from a temp folder: harness tests, left out. */
  testSessions: number
  /** Lines that were not JSON. */
  badLines: number
}

type Use = { tool: string; input: Record<string, unknown>; ms: number }
type Open = Task & { ms: number; model: string; isAnswered: boolean }
type Rec = {
  type?: string
  uuid?: string
  timestamp?: string
  entrypoint?: string
  cwd?: string
  isSidechain?: boolean
  isMeta?: boolean
  isCompactSummary?: boolean
  toolUseResult?: unknown
  message?: { id?: string; model?: string; content?: unknown; usage?: Record<string, number> }
}
type Block = { type?: string; text?: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; is_error?: boolean; content?: unknown }

const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? (content as Block[]).filter(b => b?.type === 'text').map(b => b.text ?? '').join('\n')
      : ''

/**
 * One import run. Ids are remembered across every file it reads, so history a fork or a resume
 * copied into another file, and a response split over several lines, count once.
 */
export function createImporter(range: ImportRange) {
  const days: Record<string, Day> = {}
  const seenPrompts = new Set<string>()
  const seenMessages = new Set<string>()
  const seenResults = new Set<string>()
  let sessions = 0
  let sdkSessions = 0
  let testSessions = 0
  let badLines = 0

  const add = (ms: number, delta: Day) => {
    const day = dayKey(ms)
    if (day < range.fromDay || day >= range.untilDay || ms >= range.untilMs || isEmptyDay(delta)) return
    days[day] = addDays(days[day] ?? {}, delta)
  }

  /** Reads one transcript; `isSubagent` for a file under `subagents/`, whose work adds counts but no tasks. */
  function file(isSubagent: boolean) {
    const uses = new Map<string, Use>()
    let task: Open | null = null
    let entry: string | null = null
    let isSdk = false
    let isTest = false
    const put = (ms: number, delta: Day) => add(ms, isSdk ? { sdk: delta } : delta)

    const close = () => {
      if (task?.isAnswered) put(task.ms, finishTask(task, task.model).delta)
      task = null
    }

    function line(raw: string) {
      if (isTest) return
      const isUser = raw.includes('"type":"user"')
      if (!isUser && !raw.includes('"type":"assistant"')) return
      // A result of a tool the replay does not count (a Read holding a whole file) is skipped before parsing.
      const resultId = isUser ? /"tool_use_id":"([^"]+)"/.exec(raw.slice(0, 2000))?.[1] : undefined
      if (resultId !== undefined && !TRACKED.has(uses.get(resultId)?.tool ?? '')) return

      let o: Rec
      try {
        o = JSON.parse(raw) as Rec
      } catch {
        badLines++
        return
      }
      if (entry === null && typeof o.entrypoint === 'string') {
        entry = o.entrypoint
        isSdk = entry.startsWith('sdk')
        isTest = isSdk && isTempDir(o.cwd ?? '')
        if (!isSubagent) isTest ? testSessions++ : isSdk ? sdkSessions++ : sessions++
        if (isTest) return
      }
      const ms = Date.parse(o.timestamp ?? '')
      if (Number.isNaN(ms)) return
      const isSide = isSubagent || o.isSidechain === true
      const content = o.message?.content

      if (o.type === 'assistant') {
        const model = o.message?.model ?? 'unknown'
        if (model === '<synthetic>') return
        const id = o.message?.id
        const u = o.message?.usage
        if (u && id && !seenMessages.has(id)) {
          seenMessages.add(id)
          put(ms, { tokens: { [model]: { in: u.input_tokens ?? 0, out: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 } } })
        }
        for (const b of Array.isArray(content) ? (content as Block[]) : []) {
          if (b?.type === 'tool_use' && b.id && b.name) {
            uses.set(b.id, { tool: b.name, input: b.input ?? {}, ms })
            // Every tool sorts the task (WebSearch makes it research); the tracked ones are noted when their result comes.
            if (task && !isSubagent && !TRACKED.has(b.name)) task.tools.push(b.name)
          }
          if (b?.type === 'text' && (b.text ?? '').trim() !== '' && !isSide && task) {
            task.isAnswered = true
            task.model = model
          }
        }
        return
      }

      if (o.type !== 'user') return
      const results = Array.isArray(content) ? (content as Block[]).filter(b => b?.type === 'tool_result') : []
      if (results.length > 0) {
        for (const b of results) {
          const id = b.tool_use_id
          const use = id ? uses.get(id) : undefined
          if (!id || !use || seenResults.has(id)) continue
          seenResults.add(id)
          const record = o.toolUseResult as { stdout?: string } | undefined
          put(ms, toolDelta({ tool: use.tool, input: use.input, result: o.toolUseResult, isOk: b.is_error !== true, output: record?.stdout ?? textOf(b.content), ms: ms - use.ms }, isSubagent ? null : task))
        }
        return
      }
      if (isSide || o.isMeta || o.isCompactSummary) return
      const text = textOf(content)
      if (text.startsWith('[Request interrupted')) {
        task = null // an interrupted request is no finished task
        return
      }
      if (NOT_TYPED.test(text)) {
        close()
        return
      }
      close()
      if (o.uuid && seenPrompts.has(o.uuid)) return // copied history: counted where it was first read
      if (o.uuid) seenPrompts.add(o.uuid)
      task = { ...newTask(), ms, model: 'unknown', isAnswered: false }
    }

    return { line, end: close }
  }

  const result = (): ImportResult => ({ days, sessions, sdkSessions, testSessions, badLines })
  return { file, result }
}

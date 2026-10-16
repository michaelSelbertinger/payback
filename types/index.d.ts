export type Tab = 'today' | 'week' | 'month' | 'year'

export type Kind = 'coding' | 'devops' | 'emails' | 'images' | 'documents' | 'research' | 'questions' | 'other'

export type DevKind = 'feature' | 'bugfix' | 'refactor' | 'tests' | 'debug' | 'docs' | 'devops' | 'review'

export type Size = 's' | 'm' | 'l'

export type Counter =
  | 'linesAdded' | 'linesRemoved' | 'files'
  | 'commits' | 'pushes' | 'merges' | 'rebases' | 'branches'
  | 'prsOpened' | 'prsMerged' | 'issuesOpened' | 'issuesClosed'
  | 'testRuns' | 'testFails' | 'testMs' | 'testsPassed' | 'testsFailed'
  | 'builds' | 'buildFails'
  | 'judgeCalls' | 'judgeFails' | 'judgeIn' | 'judgeOut' | 'judgeCacheRead' | 'judgeCacheWrite'

export type Tokens = { in?: number; out?: number; cacheRead?: number; cacheWrite?: number }

/** One calendar day, every field optional so a stored day holds only what happened. */
export type Day = {
  tasks?: Partial<Record<Kind, number>>
  models?: Record<string, number>
  sizes?: Partial<Record<Size, number>>
  dev?: Partial<Record<DevKind, number>>
  langs?: Record<string, number>
  n?: Partial<Record<Counter, number>>
  tokens?: Record<string, Tokens>
  /** Work in sessions the SDK started (an assistant, a script): the same fields, kept apart from the person's own. */
  sdk?: Day
}

/** Whose work the pane shows: the person's own sessions, the SDK's, or both. */
export type Source = 'all' | 'you' | 'sdk'

export type Currency = 'usd' | 'eur'

export type Settings = {
  rate: number
  currency: Currency
  minutes: Record<Exclude<Kind, 'coding'>, number>
  sizes: Record<Size, number>
  judge: boolean
}

/** What the history import shows in the pane. */
export type ImportView = {
  phase: 'idle' | 'scanning' | 'preview' | 'done' | 'error'
  /** First day read, `YYYY-MM-DD`; `0000-01-01` for all history kept. */
  fromDay: string
  /** First day not read: where live tracking began, or the end asked for. */
  untilDay: string
  done: number
  total: number
  message?: string
  preview?: {
    tasks: number
    kinds: Partial<Record<Kind, number>>
    minutes: number
    sessions: number
    sdkSessions: number
    sdkTasks: number
    testSessions: number
    skipped: number
    activeDays: number
  }
}

declare module 'claude-code' {
  interface PluginState {
    payback: { tab: Tab; rev: number; import: ImportView; source: Source }
  }
}

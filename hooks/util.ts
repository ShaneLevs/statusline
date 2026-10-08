import type { ModelUsage } from 'claude-code'

import type { StatusStat } from '../types'

/** "1.0M", "200k", "850": a token count in the status line's own spelling. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    const millions = n / 1_000_000
    return `${millions >= 10 ? Math.round(millions) : millions.toFixed(1)}M`
  }
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return `${n}`
}

/** The share of the last response's input tokens the prompt cache served, 0-100. */
export function cachePercentOf(usage: ModelUsage): number | null {
  const total = usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens
  if (total <= 0) return null
  return Math.round((usage.cache_read_input_tokens / total) * 100)
}

/** The effort a model request asks for, as the line spells it; null when none. */
export function effortLabel(effort: string | number | undefined): string | null {
  return effort === undefined ? null : String(effort)
}

/**
 * Reads `git status --porcelain=v2 --branch`: the branch (or a detached
 * short oid) and how many commits it is ahead of its upstream. Null when the
 * output names no branch (not a repository, or a git error).
 */
export function parseGitStatus(stdout: string): { branch: string; ahead: number } | null {
  let head = ''
  let oid = ''
  let ahead = 0

  for (const line of stdout.split('\n')) {
    if (line.startsWith('# branch.head ')) {
      head = line.slice('# branch.head '.length).trim()
    } else if (line.startsWith('# branch.oid ')) {
      oid = line.slice('# branch.oid '.length).trim()
    } else if (line.startsWith('# branch.ab ')) {
      const match = /\+(\d+) -(\d+)/.exec(line)
      if (match !== null) ahead = Number(match[1] ?? 0)
    }
  }

  if (head === '') return null
  const branch = head === '(detached)' ? detachedLabel(oid) : head
  return { branch, ahead }
}

function detachedLabel(oid: string): string {
  return oid === '' || oid === '(initial)' ? 'detached' : `detached@${oid.slice(0, 7)}`
}

/** Sums `git diff HEAD --numstat`'s columns; a binary entry's `-` adds nothing. */
export function parseNumstat(stdout: string): { added: number; deleted: number } {
  let added = 0
  let deleted = 0

  for (const line of stdout.split('\n')) {
    const [a, d] = line.split('\t')
    if (a === undefined || d === undefined) continue
    const add = Number(a)
    const del = Number(d)
    if (Number.isFinite(add) && Number.isFinite(del)) {
      added += add
      deleted += del
    }
  }

  return { added, deleted }
}

/** The last path segment of `dir`, for the project name. */
export function baseName(dir: string): string {
  const trimmed = dir.replace(/\/+$/, '')
  const cut = trimmed.lastIndexOf('/')
  return cut === -1 ? trimmed : trimmed.slice(cut + 1)
}

/** How the line tints one run of text. */
export type Tone = 'accent' | 'plain' | 'dim' | 'good' | 'warn' | 'bad'

/** One run of the line: what it says and how it is tinted. */
export type Segment = { text: string; tone: Tone }

const SEPARATOR: Segment = { text: ' · ', tone: 'dim' }

/**
 * The one line the band draws under the prompt, fields in order and joined
 * with " · ": model, effort, context fill and window, cache, project, branch
 * and working-copy state. Unknown fields drop out; [] when nothing is known.
 */
export function statusSegments(stat: StatusStat): Segment[] {
  const fields: Segment[][] = []

  if (stat.model !== '') fields.push([{ text: stat.model, tone: 'accent' }])
  if (stat.effort !== null) fields.push([{ text: stat.effort, tone: 'plain' }])
  if (stat.contextPercent !== null) {
    fields.push([
      {
        text: `${stat.contextPercent}%${stat.contextWindow === null ? '' : `/${formatTokens(stat.contextWindow)}`}`,
        tone: stat.contextPercent >= 90 ? 'bad' : stat.contextPercent >= 70 ? 'warn' : 'good',
      },
    ])
  }
  if (stat.cachePercent !== null) fields.push([{ text: `${stat.cachePercent}%`, tone: 'plain' }])
  if (stat.project !== '') fields.push([{ text: stat.project, tone: 'accent' }])

  if (stat.git !== null) {
    fields.push([{ text: stat.git.branch, tone: 'accent' }])
    const marks: Segment[] = []
    if (stat.git.added > 0) marks.push({ text: `+${stat.git.added}`, tone: 'good' })
    if (stat.git.deleted > 0) marks.push({ text: `-${stat.git.deleted}`, tone: 'bad' })
    if (stat.git.ahead > 0) marks.push({ text: `↑${stat.git.ahead}`, tone: 'plain' })
    fields.push(marks.length === 0 ? [{ text: '✓', tone: 'good' }] : spaced(marks))
  }

  const out: Segment[] = []
  for (const field of fields) {
    if (out.length > 0) out.push(SEPARATOR)
    out.push(...field)
  }
  return out
}

/** One run's marks on a row, a space between them. */
function spaced(marks: Segment[]): Segment[] {
  const out: Segment[] = []
  for (const mark of marks) {
    if (out.length > 0) out.push({ text: ' ', tone: 'dim' })
    out.push(mark)
  }
  return out
}

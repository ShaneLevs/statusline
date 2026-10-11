import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { createRateMeter, isWritingChunk } from './rate'
import {
  INITIAL_STAT,
  baseName,
  cachePercentOf,
  effortLabel,
  heldStat,
  parseGitStatus,
  parseNumstat,
  statusSegments,
} from './util'
import type { Tone } from './util'
import type { GitInfo, StatusStat, TokenRate } from '../types'

/** How often the line re-reads session and git state, in milliseconds. */
const REFRESH_MS = 5000

const stat = atom({ plugin: 'statusline', key: 'stat' } as const, INITIAL_STAT)

/** How fast the model is writing, kept across the session; the host's state holds what the line shows. */
const rate = createRateMeter()

/** The Text props one tone draws with. */
function toneProps(tone: Tone): { color?: 'claude' | 'success' | 'warning' | 'error'; dimColor?: true } {
  switch (tone) {
    case 'accent':
      return { color: 'claude' }
    case 'good':
      return { color: 'success' }
    case 'warn':
      return { color: 'warning' }
    case 'bad':
      return { color: 'error' }
    case 'dim':
      return { dimColor: true }
    default:
      return {}
  }
}

async function patch($: EngineInterface, change: Partial<StatusStat>): Promise<void> {
  try {
    // Held over the defaults, so a value an older build stored is completed
    // rather than kept short of the fields this one reads.
    await update($, stat, current => heldStat({ ...current, ...change }))
  } catch {
    // Keep the last reading; the next refresh tries again.
  }
}

/** Draws a speed the meter has read, when it read one. */
async function publishRate($: EngineInterface, reading: TokenRate | null): Promise<void> {
  if (reading === null) return
  await patch($, { tokenRate: reading })
}

/** One `git status` and one `git diff`, merged; null outside a repository. */
async function gitOf($: EngineInterface): Promise<GitInfo | null> {
  try {
    const { exitCode, stdout } = await $.process.run(['git', 'status', '--porcelain=v2', '--branch'])
    if (exitCode !== 0) return null

    const head = parseGitStatus(stdout)
    if (head === null) return null

    let added = 0
    let deleted = 0
    try {
      const diff = await $.process.run(['git', 'diff', 'HEAD', '--numstat'])
      if (diff.exitCode === 0) ({ added, deleted } = parseNumstat(diff.stdout))
    } catch {
      // Keep 0/0; the branch and the ahead count still stand.
    }

    return { ...head, added, deleted }
  } catch {
    return null
  }
}

/** Re-reads everything the line shows, in one state write. Never rejects. */
async function refresh($: EngineInterface): Promise<void> {
  const change: Partial<StatusStat> = {}

  try {
    change.model = await $.session.model()
  } catch {}
  try {
    change.project = baseName(await $.session.root())
  } catch {}
  try {
    const { context } = await $.session.usage({ breakdown: 'summary' })
    change.contextPercent = context.percent ?? null
    change.contextWindow = context.window
    const last = context.breakdown?.apiUsage ?? null
    change.cachePercent = last === null ? null : cachePercentOf(last)
  } catch {}

  change.git = await gitOf($)

  await patch($, change)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await refresh($)
    $.clock.every(REFRESH_MS, () => {
      void refresh($)
    })
    return next(e)
  })

  // A subagent's run raises no `turn.start`: every step of one turn, the
  // spawner's and its subagents' alike, is counted into that turn.
  on('turn.start', ($, e, next) => {
    rate.startTurn()
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      await patch($, { effort: effortLabel(e.effort) })
    }

    const sentAt = await $.clock.now()
    let writingAt: number | null = null

    const stream = next(e)
    for await (const chunk of stream) {
      // A request is timed by its writing, so the wait for its first token
      // costs the rate nothing; one clock read per request, not per chunk.
      if (writingAt === null && isWritingChunk(chunk)) writingAt = await $.clock.now()
      yield chunk
    }

    // The response is in: its own token count settles the request, exactly.
    const response = await stream.result
    const settledAt = await $.clock.now()
    await publishRate($, rate.endStep(response.usage?.output_tokens ?? null, settledAt - (writingAt ?? sentAt)))

    return response
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) {
      // The turn's average, kept on the line until the next turn settles its own.
      await publishRate($, rate.endTurn())
      await refresh($)
    }
    return done
  })

  // The dim hint line under the prompt: the engine's hint keeps the row it
  // always sits on, the band drawn on the row under it. The engine's line
  // when nothing is known yet, the hint and the band after.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const segments = statusSegments(heldStat(await read($, stat)))
    if (segments.length === 0) return next(e)

    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        {e.props.hint === '' ? null : <Text dimColor wrap="truncate">{e.props.hint}</Text>}
        <Box>
          {segments.map(segment => (
            <Text {...toneProps(segment.tone)}>{segment.text}</Text>
          ))}
        </Box>
      </Box>
    )
  })
}

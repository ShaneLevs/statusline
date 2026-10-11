import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, TurnStepResult } from 'claude-code'

import { chunkChars, createRateMeter } from './rate'
import { baseName, cachePercentOf, effortLabel, parseGitStatus, parseNumstat, statusSegments } from './util'
import type { Tone } from './util'
import type { GitInfo, StatusStat, TokenRate } from '../types'

/** How often the line re-reads session and git state, in milliseconds. */
const REFRESH_MS = 5000

const INITIAL: StatusStat = {
  model: '',
  effort: null,
  cachePercent: null,
  contextPercent: null,
  contextWindow: null,
  project: '',
  git: null,
  tokenRate: null,
}

const stat = atom({ plugin: 'statusline', key: 'stat' } as const, INITIAL)

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
    await update($, stat, current => ({ ...current, ...change }))
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

    const key = `${e.turnId}:${e.index}`
    rate.startStep(key, await $.clock.now())

    const stream = next(e)
    for await (const chunk of stream) {
      const chars = chunkChars(chunk)
      if (chars > 0) {
        const streamedAt = await $.clock.now()
        rate.addChars(key, chars, streamedAt)
        if (rate.wantsReading()) await publishRate($, rate.take(streamedAt))
      }
      yield chunk
    }

    // The response is in: its own token count settles the step, exactly. The
    // words were already counted as they streamed, in characters.
    let response: TurnStepResult
    try {
      response = await stream.result
    } catch (error) {
      // A closed stream: the response never settled, so nothing is counted.
      rate.endStep(key, null, await $.clock.now())
      throw error
    }

    const settledAt = await $.clock.now()
    rate.endStep(key, response.usage?.output_tokens ?? null, settledAt)
    await publishRate($, rate.take(settledAt))

    return response
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) {
      // The turn's average, kept on the line until the next turn measures its own.
      await publishRate($, rate.endTurn())
      await refresh($)
    }
    return done
  })

  // The dim hint line under the prompt: the engine's hint keeps the row it
  // always sits on, the band drawn on the row under it. The engine's line
  // when nothing is known yet, the hint and the band after.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const segments = statusSegments(await read($, stat))
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

import type { TurnStepChunk } from 'claude-code'

import type { TokenRate } from '../types'

/**
 * How fast the model writes, measured a request at a time.
 *
 * A request's figure is the output tokens the API reports for it over the time
 * it spent writing — its first streamed characters to its last — so a tool
 * call's own running time, the wait for the person and a slow first token all
 * cost it nothing. A turn's figure is its requests' summed, which is what the
 * line keeps once the turn is over.
 *
 * Nothing moves while a request writes: the line settles once per request and
 * once more when the turn ends, rather than reading a rate off a stream that
 * is still arriving.
 */

/** True for the chunks the model is paying output tokens for: its text, its thinking, a tool call's arguments. */
export function isWritingChunk(chunk: TurnStepChunk): boolean {
  switch (chunk.kind) {
    case 'text':
    case 'thinking':
    case 'input':
      return true
    default:
      return false
  }
}

/** One request's, or one turn's, tokens over its writing time in milliseconds. */
function rateOf(tokens: number, ms: number, isSettled: boolean): TokenRate | null {
  if (tokens <= 0 || ms <= 0) return null

  return { perSecond: tokens / (ms / 1000), isSettled }
}

export type RateMeter = {
  /** A model turn is beginning: nothing counted yet. What the line shows stands until this turn's first request settles. */
  startTurn: () => void
  /**
   * One request of the turn settled, having generated `tokens` (`null` when no
   * response arrived) over `ms` of writing. Returns that request's own rate —
   * the reading to draw now — or null when the request counts nothing.
   */
  endStep: (tokens: number | null, ms: number) => TokenRate | null
  /** The turn ended: the average of its requests, or null when it counted nothing. */
  endTurn: () => TokenRate | null
}

/**
 * A meter for one session, fed what the caller measured: the requests' real
 * token counts and their own writing times, so it holds no clock and a test
 * can run a whole turn in microseconds.
 */
export function createRateMeter(): RateMeter {
  /** The turn's requests so far: their output tokens, and the time they wrote for. */
  let tokens = 0
  let writingMs = 0

  return {
    startTurn() {
      tokens = 0
      writingMs = 0
    },

    endStep(stepTokens, ms) {
      if (stepTokens === null || stepTokens <= 0 || ms <= 0) return null

      tokens += stepTokens
      writingMs += ms
      return rateOf(stepTokens, ms, false)
    },

    endTurn() {
      const rate = rateOf(tokens, writingMs, true)

      tokens = 0
      writingMs = 0
      return rate
    },
  }
}

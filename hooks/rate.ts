import type { TurnStepChunk } from 'claude-code'

import type { TokenRate } from '../types'

/**
 * How fast a model writes, measured a turn at a time.
 *
 * A turn's figure is its requests' real output tokens over the time they
 * spent writing — a request's first streamed characters to its last — so a
 * tool call's own running time, the wait for the person, and a model's slow
 * first token all cost it nothing: the line answers for the model, not for
 * the turn's wall clock. A request still writing has no token count yet, so
 * its characters are read as tokens by what the session's settled requests
 * have taught the meter ("abc" and "字" cost nothing alike) — that live
 * reading is an estimate, the settled one is exact.
 */

/** Characters one request must add between readings, so a reading costs the host a few clocks a second at most. */
const READING_CHARS = 48

/** Streaming shorter than this is too short to read a rate off. */
const WARMUP_MS = 400

/** What a character is worth before any request has said; English prose, roughly. */
const CHARS_PER_TOKEN = 4

/** The estimate's bounds, and how hard one settled request pulls it. */
const MIN_CHARS_PER_TOKEN = 1
const MAX_CHARS_PER_TOKEN = 8
const CALIBRATION_WEIGHT = 0.3

/** One model request streaming now. */
type Step = {
  /** When the request went out. */
  sentAt: number
  /** When its first characters arrived, which is where the writing is timed from. */
  writingAt: number | null
  /** Characters of text, thinking and tool arguments streamed since. */
  chars: number
  /** The character count the last reading stood at. */
  readChars: number
}

/** The moment a step's rate is read against: it wrote nothing, the request's own going out. */
function writingFrom(step: Step): number {
  return step.writingAt ?? step.sentAt
}

export type RateMeter = {
  /** A model turn is beginning: nothing counted yet. */
  startTurn: () => void
  /** A model request is going out under `key` (`turnId:index`), at time `now`. */
  startStep: (key: string, now: number) => void
  /**
   * `chars` more characters of `key`'s response streamed, at `now`. The first
   * of them start the clock: a request is timed by its writing, so thinking
   * and a slow first token cost the rate nothing.
   */
  addChars: (key: string, chars: number, now: number) => void
  /** True when enough has streamed to be worth reading the host's clock for. */
  wantsReading: () => boolean
  /**
   * The reading to draw at `now`, recorded as taken: the streaming request's
   * own rate, or the turn's average between requests. Null when there is
   * nothing to show — too little streamed yet, or nothing measured at all.
   */
  take: (now: number) => TokenRate | null
  /**
   * `key`'s request settled at `now`, having generated `tokens` (`null` when
   * no response arrived). Only a settled request is counted, and by its real
   * token count.
   */
  endStep: (key: string, tokens: number | null, now: number) => void
  /** The turn ended: the average to keep showing, or null when it counted nothing. */
  endTurn: () => TokenRate | null
}

/** The characters of one streamed chunk: what the model is paying output tokens for. */
export function chunkChars(chunk: TurnStepChunk): number {
  switch (chunk.kind) {
    case 'text':
    case 'thinking':
      return chunk.text.length
    case 'input':
      return chunk.json.length
    default:
      return 0
  }
}

/** Folds one settled request's real characters-per-token into the estimate. */
export function calibratedCharsPerToken(previous: number, chars: number, tokens: number): number {
  if (chars <= 0 || tokens <= 0) return previous

  const observed = chars / tokens
  const pulled = previous * (1 - CALIBRATION_WEIGHT) + observed * CALIBRATION_WEIGHT
  return Math.min(MAX_CHARS_PER_TOKEN, Math.max(MIN_CHARS_PER_TOKEN, pulled))
}

/**
 * A meter for one session, fed the clock the caller read: every method takes
 * the time it acts at, so the meter holds no clock of its own and a test can
 * run a whole turn in microseconds.
 */
export function createRateMeter(): RateMeter {
  /** What a character is worth, learned from the session's settled requests. */
  let charsPerToken = CHARS_PER_TOKEN
  /** The turn's real output tokens and the time they took to generate. */
  let tokens = 0
  let genMs = 0

  /** The requests open now, by key: a turn may stream several (a subagent's too). */
  const steps = new Map<string, Step>()
  /** The one that streamed last, which is the one a live reading is read off. */
  let streaming: Step | null = null

  const average = (): number | null => (tokens > 0 && genMs > 0 ? tokens / (genMs / 1000) : null)

  return {
    startTurn() {
      tokens = 0
      genMs = 0
      steps.clear()
      streaming = null
    },

    startStep(key, now) {
      const step: Step = { sentAt: now, writingAt: null, chars: 0, readChars: 0 }
      steps.set(key, step)
      streaming = step
    },

    addChars(key, chars, now) {
      const step = steps.get(key)
      if (step === undefined) return

      step.writingAt ??= now
      step.chars += chars
      streaming = step
    },

    wantsReading() {
      return streaming !== null && streaming.chars - streaming.readChars >= READING_CHARS
    },

    take(now) {
      // A request that has streamed nothing yet has no rate; between requests,
      // and through one that has only just gone out, the turn's average stands.
      if (streaming !== null && streaming.chars > 0) {
        streaming.readChars = streaming.chars
        const elapsed = now - writingFrom(streaming)
        if (elapsed < WARMUP_MS) return null

        return { perSecond: streaming.chars / charsPerToken / (elapsed / 1000), isLive: true }
      }

      const perSecond = average()
      return perSecond === null ? null : { perSecond, isLive: true }
    },

    endStep(key, stepTokens, now) {
      const step = steps.get(key)
      if (step === undefined) return

      steps.delete(key)
      if (streaming === step) streaming = null

      const ms = now - writingFrom(step)
      if (stepTokens === null || stepTokens <= 0 || ms <= 0) return

      tokens += stepTokens
      genMs += ms
      charsPerToken = calibratedCharsPerToken(charsPerToken, step.chars, stepTokens)
    },

    endTurn() {
      const perSecond = average()

      tokens = 0
      genMs = 0
      steps.clear()
      streaming = null

      return perSecond === null ? null : { perSecond, isLive: false }
    },
  }
}

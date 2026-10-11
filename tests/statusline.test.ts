import { expect, test } from 'claude-code/testing'
import type { SessionUsage } from 'claude-code'

import { calibratedCharsPerToken, chunkChars, createRateMeter } from '../hooks/rate'
import {
  cachePercentOf,
  effortLabel,
  formatRate,
  formatTokens,
  parseGitStatus,
  parseNumstat,
  statusSegments,
} from '../hooks/util'
import type { StatusStat } from '../types'

const EMPTY: StatusStat = {
  model: '',
  effort: null,
  cachePercent: null,
  contextPercent: null,
  contextWindow: null,
  project: '',
  git: null,
  tokenRate: null,
}

const joined = (stat: StatusStat): string =>
  statusSegments(stat)
    .map(segment => segment.text)
    .join('')

test('the line spells the fields in order and drops the unknown ones', () => {
  const full: StatusStat = {
    model: 'glm-5.3-flash',
    effort: 'high',
    cachePercent: 95,
    contextPercent: 4,
    contextWindow: 1_000_000,
    project: 'energy-service',
    git: { branch: 'feat/topology', ahead: 2, added: 120, deleted: 45 },
    tokenRate: { perSecond: 42.4, isLive: false },
  }
  expect(joined(full)).toBe(
    'glm-5.3-flash · high · 4%/1.0M · 95% · energy-service · feat/topology · +120 -45 ↑2 · 42 tok/s',
  )

  expect(statusSegments(full).find(s => s.text === 'glm-5.3-flash')?.tone).toBe('accent')
  expect(statusSegments(full).find(s => s.text === '4%/1.0M')?.tone).toBe('good')
  expect(statusSegments(full).find(s => s.text === '+120')?.tone).toBe('good')
  expect(statusSegments(full).find(s => s.text === '-45')?.tone).toBe('bad')
  expect(statusSegments(full).find(s => s.text === '↑2')?.tone).toBe('plain')
  expect(statusSegments(full).find(s => s.text === '42 tok/s')?.tone).toBe('plain')
  expect(statusSegments(full).some(s => s.text === ' · ' && s.tone === 'dim')).toBe(true)

  expect(statusSegments({ ...EMPTY, contextPercent: 75 }).find(s => s.tone === 'warn')?.text).toBe('75%')
  expect(statusSegments({ ...EMPTY, contextPercent: 92 }).find(s => s.tone === 'bad')?.text).toBe('92%')

  expect(joined({ ...EMPTY, model: 'm' })).toBe('m')
  expect(joined({ ...EMPTY, contextPercent: 4 })).toBe('4%')
  expect(joined({ ...EMPTY, model: 'm', git: { branch: 'main', ahead: 0, added: 0, deleted: 0 } })).toBe('m · main · ✓')
  expect(statusSegments({ ...EMPTY, model: 'm', git: { branch: 'main', ahead: 0, added: 0, deleted: 0 } }).at(-1)?.tone).toBe('good')
  expect(joined({ ...EMPTY, model: 'm', git: { branch: 'main', ahead: 0, added: 12, deleted: 0 } })).toBe('m · main · +12')
  expect(statusSegments(EMPTY)).toEqual([])
})

test('the speed lands last, dim while it is an estimate and plain once settled', () => {
  const git = { branch: 'main', ahead: 0, added: 0, deleted: 0 }
  const settled = { ...EMPTY, model: 'm', git, tokenRate: { perSecond: 48.4, isLive: false } }
  const live = { ...EMPTY, model: 'm', git, tokenRate: { perSecond: 9.87, isLive: true } }

  expect(joined(settled)).toBe('m · main · ✓ · 48 tok/s')
  expect(joined(live)).toBe('m · main · ✓ · 9.9 tok/s')
  expect(statusSegments(settled).at(-1)?.tone).toBe('plain')
  expect(statusSegments(live).at(-1)?.tone).toBe('dim')
})

test('parseGitStatus reads the branch and the commits to push', () => {
  const parsed = parseGitStatus(
    ['# branch.oid 8a1b2c3d4e5f', '# branch.head feat/topology', '# branch.ab +2 -0', '? notes.txt'].join('\n'),
  )
  expect(parsed).toEqual({ branch: 'feat/topology', ahead: 2 })

  expect(parseGitStatus('# branch.head main\n')).toEqual({ branch: 'main', ahead: 0 })

  expect(parseGitStatus('# branch.head (detached)\n# branch.oid 8a1b2c3d4e5f\n')).toEqual({
    branch: 'detached@8a1b2c3',
    ahead: 0,
  })

  expect(parseGitStatus('fatal: not a git repository (or any of the parent directories): .git\n')).toBeNull()
})

test('parseNumstat sums added and deleted lines, skipping binary entries', () => {
  expect(parseNumstat('12\t3\tsrc/app.ts\n-\t-\tlogo.png\n0\t5\tdocs/x.md\n')).toEqual({ added: 12, deleted: 8 })
  expect(parseNumstat('')).toEqual({ added: 0, deleted: 0 })
})

test('formatTokens, cachePercentOf and effortLabel hold the display rules', () => {
  expect(formatTokens(1_000_000)).toBe('1.0M')
  expect(formatTokens(200_000)).toBe('200k')
  expect(formatTokens(850)).toBe('850')

  expect(
    cachePercentOf({ input_tokens: 5, output_tokens: 40, cache_read_input_tokens: 95, cache_creation_input_tokens: 0 }),
  ).toBe(95)
  expect(
    cachePercentOf({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
  ).toBeNull()

  expect(effortLabel('high')).toBe('high')
  expect(effortLabel(undefined)).toBeNull()

  expect(formatRate(48.4)).toBe('48 tok/s')
  expect(formatRate(3.54)).toBe('3.5 tok/s')
  expect(formatRate(0)).toBe('0 tok/s')
})

test('the meter reads a live estimate off the stream and settles on the real counts', () => {
  const meter = createRateMeter()
  meter.startTurn()
  meter.startStep('t1:0', 1_000)

  // The response starts writing half a second later; that is where its clock starts.
  meter.addChars('t1:0', 120, 1_500)
  expect(meter.wantsReading()).toBe(true)

  // Two hundred milliseconds of writing is too soon to read a rate off, and the reading is spent.
  expect(meter.take(1_700)).toBeNull()
  expect(meter.wantsReading()).toBe(false)

  // Half a second of writing: 120 characters at the fallback four a token are 30 tokens.
  expect(meter.take(2_000)).toEqual({ perSecond: 60, isLive: true })

  // The response settles, saying it generated 40 tokens over that one second of writing.
  meter.endStep('t1:0', 40, 2_500)

  // Between requests the turn's average stands, and it is exact.
  expect(meter.take(2_500)).toEqual({ perSecond: 40, isLive: true })

  // CJK streams at a character a token, which the settled request has taught it.
  expect(Math.round(calibratedCharsPerToken(4, 120, 40) * 10) / 10).toBe(3.7)
  meter.startStep('t1:1', 3_000)
  meter.addChars('t1:1', 60, 3_500)
  expect(Math.round(meter.take(4_100)?.perSecond ?? 0)).toBe(27)

  meter.endStep('t1:1', 40, 4_500)

  // Forty tokens in each of the two seconds writing took.
  expect(meter.endTurn()).toEqual({ perSecond: 40, isLive: false })
})

test('a reading costs one clock read per stretch of characters', () => {
  const meter = createRateMeter()
  meter.startTurn()
  meter.startStep('t1:0', 0)

  meter.addChars('t1:0', 47, 100)
  expect(meter.wantsReading()).toBe(false)
  meter.addChars('t1:0', 1, 200)
  expect(meter.wantsReading()).toBe(true)

  // Twelve estimated tokens over the half second since the first characters.
  expect(meter.take(600)).toEqual({ perSecond: 24, isLive: true })
  expect(meter.wantsReading()).toBe(false)
})

test('a turn that settled no tokens leaves the last reading alone', () => {
  const meter = createRateMeter()
  meter.startTurn()
  meter.startStep('t1:0', 0)
  meter.addChars('t1:0', 200, 0)
  expect(meter.take(1_000)).toEqual({ perSecond: 50, isLive: true })

  // An interrupt: no response settled, so the step counts nothing.
  meter.endStep('t1:0', null, 1_000)
  expect(meter.take(1_000)).toBeNull()
  expect(meter.endTurn()).toBeNull()
})

test('two requests streaming at once are counted apart', () => {
  const meter = createRateMeter()
  meter.startTurn()

  // The main loop's request, and a subagent's writing alongside it.
  meter.startStep('t1:0', 0)
  meter.addChars('t1:0', 400, 0)
  meter.startStep('sub:0', 500)
  meter.addChars('sub:0', 40, 900)

  // The reading follows the request that streamed last: ten estimated tokens over the half second it has written for.
  expect(meter.take(1_400)).toEqual({ perSecond: 20, isLive: true })

  // The subagent's settles with its own count; the main loop's is still open,
  // so what is read now is the turn's average, exact.
  meter.endStep('sub:0', 20, 1_400)
  expect(meter.take(1_400)).toEqual({ perSecond: 40, isLive: true })

  meter.endStep('t1:0', 30, 2_000)

  // Fifty real tokens over the two and a half seconds the two requests wrote for.
  expect(meter.take(2_500)).toEqual({ perSecond: 20, isLive: true })

  // A request that has only just gone out says nothing of its own.
  meter.startStep('t1:1', 2_600)
  expect(meter.take(2_600)).toEqual({ perSecond: 20, isLive: true })

  expect(meter.endTurn()).toEqual({ perSecond: 20, isLive: false })
})

test('chunkChars counts what the model pays output tokens for', () => {
  expect(chunkChars({ kind: 'text', index: 0, text: 'hello' })).toBe(5)
  expect(chunkChars({ kind: 'thinking', index: 0, text: 'hm' })).toBe(2)
  expect(chunkChars({ kind: 'input', index: 1, json: '{"a":1}' })).toBe(7)
  expect(chunkChars({ kind: 'tool', index: 1, id: 'toolu_1', name: 'Read' })).toBe(0)
  expect(chunkChars({ kind: 'stop', stopReason: 'end_turn', usage: null })).toBe(0)
  expect(chunkChars({ kind: 'engine', ref: 1 })).toBe(0)
})

const HINT_PROPS = { isDraft: false, isWorking: false, hint: '? for shortcuts' }
/** What the prompt hint says while a turn runs: the band's row, and nothing above it. */
const WORKING_PROPS = { isDraft: false, isWorking: true, hint: '' }

/** One session's figures, as `$.session.usage()` gives them. */
const USAGE: SessionUsage = {
  startedAt: 0,
  context: {
    tokens: 41_000,
    window: 1_000_000,
    percent: 4,
    breakdown: {
      categories: [],
      totalTokens: 41_000,
      maxTokens: 1_000_000,
      rawMaxTokens: 1_000_000,
      autocompactSource: 'model-default',
      isAutoCompactEnabled: true,
      percentage: 4,
      gridRows: [],
      model: 'test-model',
      memoryFiles: [],
      mcpTools: [],
      agents: [],
      apiUsage: {
        input_tokens: 5,
        output_tokens: 0,
        cache_read_input_tokens: 95,
        cache_creation_input_tokens: 0,
      },
    },
  },
  rateLimits: [],
}

test('a completed turn redraws the hint line from the session and the working copy', async ($, on) => {
  on('session.model', () => ({ value: 'test-model' }))
  on('session.root', () => ({ value: '/work/demo-proj' }))
  on('session.usage', () => ({ value: USAGE }))
  on('process.run', ($, e) => ({
    value:
      e.argv[1] === 'status'
        ? {
            exitCode: 0,
            stdout: '# branch.oid 8a1b2c3d\n# branch.head main\n# branch.ab +2 -0\n? notes.txt\n',
            stderr: '',
            isStdoutTruncated: false,
            isStderrTruncated: false,
          }
        : {
            exitCode: 0,
            stdout: '120\t45\tsrc/app.ts\n',
            stderr: '',
            isStdoutTruncated: false,
            isStderrTruncated: false,
          },
  }))
  on('turn.complete', () => ({ text: '' }))

  await $.turn.complete({ answer: '', durationMs: 12, isAborted: false, turnId: 't1', reason: 'answer' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'statusline',
      surface,
      component: 'PromptHint',
      props: HINT_PROPS,
    })

    const texts = (await ui.findAll({ type: 'Text' })).map(el => el.text)
    expect(texts).toContain('test-model')
    expect(texts).toContain('4%/1.0M')
    expect(texts).toContain('95%')
    expect(texts).toContain('demo-proj')
    expect(texts).toContain('main')
    expect(texts).toContain('+120')
    expect(texts).toContain('-45')
    expect(texts).toContain('↑2')
    // The engine's hint keeps its own row under the band.
    expect(texts).toContain('? for shortcuts')

    await ui.unmount()
  }
})

test('the line yields to the engine hint before anything is known', async ($, on) => {
  on('ui.render', { component: 'PromptHint' }, () => ({ type: 'Text', children: ['? for shortcuts'] }))

  const ui = await $.ui.mount({
    plugin: 'statusline',
    surface: 'terminal',
    component: 'PromptHint',
    props: HINT_PROPS,
  })

  expect((await ui.find({ type: 'Text', text: /for shortcuts/ }))?.text).toBe('? for shortcuts')
  expect(await ui.find({ type: 'Text', text: /test-model/ })).toBeUndefined()

  await ui.unmount()
})

test('a streaming turn draws its speed as it writes, then keeps the turn average', async ($, on) => {
  let time = 0

  on('clock.now', () => ({ value: time }))
  on('session.model', () => ({ value: 'test-model' }))
  on('session.root', () => ({ value: '/work/demo-proj' }))
  on('session.usage', () => ({ value: USAGE }))
  on('process.run', () => ({
    value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('turn.start', () => ({ turnId: 't1' }))
  on('turn.complete', () => ({ text: '' }))
  // The engine's own hint row, which the band yields to before anything is known.
  on('ui.render', { component: 'PromptHint' }, () => ({ type: 'Text', children: ['? for shortcuts'] }))

  // The engine beneath: two flushes, one and two seconds in, and a response
  // that says the request generated seventy tokens.
  on('turn.step', async function* () {
    time = 500
    yield { kind: 'text', index: 0, text: 'a'.repeat(120) }
    time = 1_500
    yield { kind: 'text', index: 0, text: 'b'.repeat(120) }

    return {
      turnId: 't1',
      index: 0,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: {
        input_tokens: 5,
        output_tokens: 70,
        cache_read_input_tokens: 95,
        cache_creation_input_tokens: 0,
        model: 'test-model',
      },
    }
  })

  await $.turn.start({ text: 'hello', turnId: 't1' })

  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'test-model', messageCount: 1 })
  const chunks = stream[Symbol.asyncIterator]()

  // One drawing of the band, read again after every flush.
  const ui = await $.ui.mount({
    plugin: 'statusline',
    surface: 'terminal',
    component: 'PromptHint',
    props: WORKING_PROPS,
  })
  const speed = async (): Promise<string | undefined> =>
    (await ui.findAll({ type: 'Text' })).map(el => el.text).find(text => text.endsWith('tok/s'))

  // The request is out; nothing has been written yet.
  expect(await speed()).toBeUndefined()

  // The first flush starts the clock but says nothing yet: too short to read a rate off.
  await chunks.next()
  expect(await speed()).toBeUndefined()

  // A second of writing, 240 characters read as 60 tokens.
  await chunks.next()
  expect(await speed()).toBe('60 tok/s')

  // The response settles: 70 real tokens over that one second of writing.
  expect((await chunks.next()).done).toBe(true)
  expect(await speed()).toBe('70 tok/s')

  // The turn is over: the average stays, settled rather than estimated.
  await $.turn.complete({ answer: '', durationMs: 2_000, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(await speed()).toBe('70 tok/s')

  await ui.unmount()
})

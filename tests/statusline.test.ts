import { expect, test } from 'claude-code/testing'
import type { SessionUsage } from 'claude-code'

import { createRateMeter, isWritingChunk } from '../hooks/rate'
import {
  cachePercentOf,
  effortLabel,
  formatRate,
  formatTokens,
  heldStat,
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
    tokenRate: { perSecond: 42.4, isSettled: true },
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

test('the speed lands last, dim while its turn runs and plain once the turn is over', () => {
  const git = { branch: 'main', ahead: 0, added: 0, deleted: 0 }
  const settled = { ...EMPTY, model: 'm', git, tokenRate: { perSecond: 48.4, isSettled: true } }
  const running = { ...EMPTY, model: 'm', git, tokenRate: { perSecond: 9.87, isSettled: false } }

  expect(joined(settled)).toBe('m · main · ✓ · 48 tok/s')
  expect(joined(running)).toBe('m · main · ✓ · 9.9 tok/s')
  expect(statusSegments(settled).at(-1)?.tone).toBe('plain')
  expect(statusSegments(running).at(-1)?.tone).toBe('dim')
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

test('the meter reads a rate per request and the turn average at the end', () => {
  const meter = createRateMeter()
  meter.startTurn()

  // A request that wrote 70 tokens over the second it took.
  expect(meter.endStep(70, 1_000)).toEqual({ perSecond: 70, isSettled: false })

  // A slower one: its own figure is what the line reads next, not the run so far.
  expect(meter.endStep(30, 1_000)).toEqual({ perSecond: 30, isSettled: false })

  // The turn's figure is its requests' summed: 100 tokens over two seconds.
  expect(meter.endTurn()).toEqual({ perSecond: 50, isSettled: true })
})

test('a request that counted no tokens leaves the last reading alone', () => {
  const meter = createRateMeter()
  meter.startTurn()

  // An interrupt, an empty response, a request too short to time.
  expect(meter.endStep(null, 1_000)).toBeNull()
  expect(meter.endStep(0, 1_000)).toBeNull()
  expect(meter.endStep(40, 0)).toBeNull()

  expect(meter.endTurn()).toBeNull()
})

test('isWritingChunk counts what the model pays output tokens for', () => {
  expect(isWritingChunk({ kind: 'text', index: 0, text: 'hello' })).toBe(true)
  expect(isWritingChunk({ kind: 'thinking', index: 0, text: '' })).toBe(true)
  expect(isWritingChunk({ kind: 'input', index: 1, json: '{"a":1}' })).toBe(true)
  expect(isWritingChunk({ kind: 'tool', index: 1, id: 'toolu_1', name: 'Read' })).toBe(false)
  expect(isWritingChunk({ kind: 'stop', stopReason: 'end_turn', usage: null })).toBe(false)
  expect(isWritingChunk({ kind: 'engine', ref: 1 })).toBe(false)
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

test('a turn settles a rate per request, then the turn average', async ($, on) => {
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

  const writing = { kind: 'text' as const, index: 0, text: 'a'.repeat(120) }
  const answered = (index: number, outputTokens: number) => ({
    turnId: 't1',
    index,
    answer: '',
    toolUses: [],
    stopReason: 'end_turn' as const,
    usage: {
      input_tokens: 5,
      output_tokens: outputTokens,
      cache_read_input_tokens: 95,
      cache_creation_input_tokens: 0,
      model: 'test-model',
    },
  })

  // The engine beneath: two requests, each writing for its own second.
  on('turn.step', async function* ($, e) {
    if (e.index === 0) {
      time = 500
      yield writing
      time = 1_500
      yield writing
      return answered(0, 70)
    }

    time = 2_000
    yield writing
    time = 3_000
    yield writing
    return answered(1, 30)
  })

  await $.turn.start({ text: 'hello', turnId: 't1' })

  // One drawing of the band, read again after every flush.
  const ui = await $.ui.mount({
    plugin: 'statusline',
    surface: 'terminal',
    component: 'PromptHint',
    props: WORKING_PROPS,
  })
  const speed = async (): Promise<{ text: string; props: Record<string, unknown> } | undefined> =>
    (await ui.findAll({ type: 'Text' })).find(el => el.text.endsWith('tok/s'))

  /** One model request of the turn, pulled by hand so the line can be read mid-flight. */
  const request = (index: number): AsyncIterator<unknown> =>
    $.turn.step({ turnId: 't1', index, model: 'test-model', messageCount: 1 })[Symbol.asyncIterator]()

  const first = request(0)

  // The request is out; nothing has been measured yet.
  expect(await speed()).toBeUndefined()

  // While a request writes, the line does not move: the reading waits for it to settle.
  await first.next()
  expect(await speed()).toBeUndefined()
  await first.next()
  expect(await speed()).toBeUndefined()

  // It settled: 70 tokens over the one second it spent writing, its own figure.
  expect((await first.next()).done).toBe(true)
  expect((await speed())?.text).toBe('70 tok/s')
  expect((await speed())?.props.dimColor).toBe(true)

  const second = request(1)

  // The second request writes with the first one's figure still standing.
  await second.next()
  expect((await speed())?.text).toBe('70 tok/s')

  await second.next()
  expect((await second.next()).done).toBe(true)
  expect((await speed())?.text).toBe('30 tok/s')

  // The turn is over: what stays is its requests' average, 100 tokens over two seconds.
  await $.turn.complete({ answer: '', durationMs: 3_000, isAborted: false, turnId: 't1', reason: 'answer' })
  expect((await speed())?.text).toBe('50 tok/s')
  expect((await speed())?.props.dimColor).toBeUndefined()

  await ui.unmount()
})

test('a value an older version stored still draws the line', () => {
  // `$.state` outlives the plugin's code, so what the host holds may be a
  // value a build without the speed field wrote: its own fields draw, the
  // rest come from the line's defaults rather than breaking the drawing.
  const older: Partial<StatusStat> = {
    model: 'test-model',
    effort: 'high',
    cachePercent: 90,
    contextPercent: 4,
    contextWindow: 1_000_000,
    project: 'demo-proj',
    git: null,
  }

  const held = heldStat(older)
  expect(held.tokenRate).toBeNull()
  expect(joined(held)).toBe('test-model · high · 4%/1.0M · 90% · demo-proj')

  // Nothing stored at all draws nothing, rather than crashing on a missing field.
  expect(statusSegments(heldStat(undefined))).toEqual([])
})

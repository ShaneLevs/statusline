import { expect, test } from 'claude-code/testing'

import { cachePercentOf, effortLabel, formatTokens, parseGitStatus, parseNumstat, statusSegments } from '../hooks/util'
import type { StatusStat } from '../types'

const EMPTY: StatusStat = {
  model: '',
  effort: null,
  cachePercent: null,
  contextPercent: null,
  contextWindow: null,
  project: '',
  git: null,
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
  }
  expect(joined(full)).toBe('glm-5.3-flash · high · 4%/1.0M · 95% · energy-service · feat/topology · +120 -45 ↑2')

  expect(statusSegments(full).find(s => s.text === 'glm-5.3-flash')?.tone).toBe('accent')
  expect(statusSegments(full).find(s => s.text === '4%/1.0M')?.tone).toBe('good')
  expect(statusSegments(full).find(s => s.text === '+120')?.tone).toBe('good')
  expect(statusSegments(full).find(s => s.text === '-45')?.tone).toBe('bad')
  expect(statusSegments(full).find(s => s.text === '↑2')?.tone).toBe('plain')
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
})

const HINT_PROPS = { isDraft: false, isWorking: false, hint: '? for shortcuts' }

test('a completed turn redraws the hint line from the session and the working copy', async ($, on) => {
  on('session.model', () => ({ value: 'test-model' }))
  on('session.root', () => ({ value: '/work/demo-proj' }))
  on('session.usage', () => ({
    value: {
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
    },
  }))
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

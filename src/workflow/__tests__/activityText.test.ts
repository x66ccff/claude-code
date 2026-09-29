import { expect, test } from 'bun:test'
import { describeAssistantActivity } from '../activityText.js'

test('returns undefined for missing or empty content', () => {
  expect(describeAssistantActivity(undefined)).toBeUndefined()
  expect(describeAssistantActivity([])).toBeUndefined()
})

test('skips blocks without visible content', () => {
  expect(
    describeAssistantActivity([
      { type: 'text', text: '   ' },
      { type: 'thinking', thinking: '' },
      { type: 'tool_result' },
    ]),
  ).toBeUndefined()
})

test('keeps the LAST interesting block across mixed content', () => {
  const act = describeAssistantActivity([
    { type: 'thinking', thinking: 'plan the step' },
    { type: 'text', text: 'now reading' },
    { type: 'tool_use', name: 'Read', input: { file_path: '/a/b.ts' } },
  ])
  expect(act).toBe('⚙ Read {"file_path":"/a/b.ts"}')
})

test('thinking blocks get the "thinking: " prefix', () => {
  expect(
    describeAssistantActivity([
      { type: 'thinking', thinking: ' deep thought ' },
    ]),
  ).toBe('thinking: deep thought')
})

test('text blocks are trimmed and returned raw', () => {
  expect(describeAssistantActivity([{ type: 'text', text: ' hello ' }])).toBe(
    'hello',
  )
})

test('tool_use input is JSON-stringified and truncated to 120 chars with …', () => {
  const long = 'x'.repeat(200)
  const act = describeAssistantActivity([
    { type: 'tool_use', name: 'Bash', input: { command: long } },
  ])!
  expect(act.startsWith('⚙ Bash {"command":"')).toBe(true)
  expect(act.endsWith('…')).toBe(true)
  // ⚙ + space + name + space + 120-char preview
  expect(act.length).toBeLessThanOrEqual(2 + 4 + 1 + 121)
})

test('tool_use with string input uses it verbatim', () => {
  expect(
    describeAssistantActivity([
      { type: 'tool_use', name: 'Task', input: 'do the thing' },
    ]),
  ).toBe('⚙ Task do the thing')
})

test('tool_use without input renders empty object', () => {
  expect(
    describeAssistantActivity([{ type: 'tool_use', name: 'TaskList' }]),
  ).toBe('⚙ TaskList {}')
})

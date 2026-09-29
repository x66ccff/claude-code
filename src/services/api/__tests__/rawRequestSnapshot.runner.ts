import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { getSessionId, switchSession } from '../../../bootstrap/state.js'
import { asSessionId } from '../../../types/ids.js'
import {
  clearRawRequestSnapshot,
  getRawRequestSnapshot,
  recordRawRequestBody,
  shouldCaptureRawRequest,
  subscribeRawRequestSnapshot,
  wrapFetchForRawRequest,
} from '../rawRequestSnapshot.js'

const originalSessionId = getSessionId()

beforeEach(() => clearRawRequestSnapshot())

afterEach(() => {
  clearRawRequestSnapshot()
  switchSession(originalSessionId)
})

describe('raw request snapshots', () => {
  test('captures only main REPL query sources', () => {
    expect(shouldCaptureRawRequest('repl_main_thread')).toBe(true)
    expect(shouldCaptureRawRequest('repl_main_thread:retry')).toBe(true)
    expect(shouldCaptureRawRequest('side_query')).toBe(false)
    expect(shouldCaptureRawRequest()).toBe(false)
  })

  test('preserves the latest string body exactly', () => {
    const first = '{"text":"first\\nline"}'
    const second = ' {"text":"second","spacing": true} '

    recordRawRequestBody('openai', first)
    recordRawRequestBody('gemini', second)

    expect(getRawRequestSnapshot()).toMatchObject({
      sessionId: getSessionId(),
      provider: 'gemini',
      body: second,
    })
  })

  test('ignores non-string bodies', () => {
    recordRawRequestBody('openai', '{"kept":true}')
    recordRawRequestBody('openai', new Uint8Array([1, 2, 3]))

    expect(getRawRequestSnapshot()?.body).toBe('{"kept":true}')
  })

  test('notifies subscribers and unregisters them', () => {
    let notifications = 0
    const unsubscribe = subscribeRawRequestSnapshot(() => notifications++)

    recordRawRequestBody('openai', '{}')
    clearRawRequestSnapshot()
    unsubscribe()
    recordRawRequestBody('openai', '{"ignored":true}')

    expect(notifications).toBe(2)
  })

  test('clears the previous session body when the session changes', () => {
    recordRawRequestBody('anthropic', '{"private":"old-session"}')

    switchSession(asSessionId(randomUUID()))

    expect(getRawRequestSnapshot()).toBeNull()
  })

  test('observes only the body and passes the request through unchanged', async () => {
    let receivedInput: RequestInfo | URL | undefined
    let receivedInit: RequestInit | undefined
    const baseFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      receivedInput = input
      receivedInit = init
      return new Response('ok')
    }) as typeof fetch
    const wrapped = wrapFetchForRawRequest(baseFetch, 'openai')
    const body = '{"prompt":"model-visible-secret"}'
    const init: RequestInit = {
      method: 'POST',
      headers: {
        Authorization: 'Bearer transport-secret',
        Cookie: 'session=transport-secret',
      },
      body,
    }

    await wrapped('https://example.invalid/model', init)

    expect(receivedInput).toBe('https://example.invalid/model')
    expect(receivedInit).toBe(init)
    expect(getRawRequestSnapshot()?.body).toBe(body)
    expect(JSON.stringify(getRawRequestSnapshot())).not.toContain(
      'transport-secret',
    )
  })
})

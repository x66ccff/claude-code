import { afterEach, describe, expect, test } from 'bun:test'
import { acquireOpenAIRequestSlot } from '../requestGate.js'

const originalSerialRequests = process.env.CLAUDE_CODE_OPENAI_SERIAL_REQUESTS

afterEach(() => {
  if (originalSerialRequests === undefined) {
    delete process.env.CLAUDE_CODE_OPENAI_SERIAL_REQUESTS
  } else {
    process.env.CLAUDE_CODE_OPENAI_SERIAL_REQUESTS = originalSerialRequests
  }
})

describe('acquireOpenAIRequestSlot', () => {
  test('queues a second local request until the first releases', async () => {
    process.env.CLAUDE_CODE_OPENAI_SERIAL_REQUESTS = '1'
    const releaseFirst = await acquireOpenAIRequestSlot()
    let secondAcquired = false
    const second = acquireOpenAIRequestSlot().then(release => {
      secondAcquired = true
      return release
    })

    await Promise.resolve()
    expect(secondAcquired).toBe(false)

    releaseFirst()
    const releaseSecond = await second
    expect(secondAcquired).toBe(true)
    releaseSecond()
  })

  test('does not queue requests when serialization is disabled', async () => {
    delete process.env.CLAUDE_CODE_OPENAI_SERIAL_REQUESTS
    const releaseFirst = await acquireOpenAIRequestSlot()
    const releaseSecond = await acquireOpenAIRequestSlot()

    releaseFirst()
    releaseSecond()
  })
})

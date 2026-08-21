import { describe, expect, test } from 'bun:test'
import {
  abortableAsyncIterable,
  AsyncIteratorAbortedError,
  nextWithAbort,
} from '../abortableAsyncIterator.js'

describe('nextWithAbort', () => {
  test('returns the next iterator result', async () => {
    const iterator: AsyncIterator<number> = {
      next: async () => ({ done: false, value: 42 }),
    }

    const result = await nextWithAbort(iterator, [new AbortController().signal])

    expect(result).toEqual({
      status: 'next',
      result: { done: false, value: 42 },
    })
  })

  test('returns immediately for an already-aborted signal', async () => {
    const controller = new AbortController()
    controller.abort('cancelled')
    let nextCalled = false
    const iterator: AsyncIterator<number> = {
      next: async () => {
        nextCalled = true
        return { done: true, value: undefined }
      },
    }

    const result = await nextWithAbort(iterator, [controller.signal])

    expect(result.status).toBe('aborted')
    expect(nextCalled).toBe(false)
  })

  test('wakes when abort fires even if next never settles', async () => {
    const controller = new AbortController()
    const iterator: AsyncIterator<number> = {
      next: () => new Promise<IteratorResult<number>>(() => {}),
    }

    const pending = nextWithAbort(iterator, [controller.signal])
    controller.abort('cancelled')
    const result = await pending

    expect(result.status).toBe('aborted')
    if (result.status === 'aborted') {
      expect(result.signal).toBe(controller.signal)
    }
  })

  test('propagates iterator errors', async () => {
    const iterator: AsyncIterator<number> = {
      next: async () => {
        throw new Error('stream failed')
      },
    }

    await expect(
      nextWithAbort(iterator, [new AbortController().signal]),
    ).rejects.toThrow('stream failed')
  })

  test('abortable iterable escapes a permanently pending next call', async () => {
    const controller = new AbortController()
    let returnCalled = false
    const iterable: AsyncIterable<number> = {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<number>>(() => {}),
        return: async () => {
          returnCalled = true
          return { done: true, value: undefined }
        },
      }),
    }
    const iterator = abortableAsyncIterable(iterable, [controller.signal])

    const pending = iterator.next()
    controller.abort('cancelled')

    await expect(pending).rejects.toBeInstanceOf(AsyncIteratorAbortedError)
    expect(returnCalled).toBe(true)
  })
})

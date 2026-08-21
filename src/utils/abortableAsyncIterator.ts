export type AbortableIteratorResult<T> =
  | { status: 'next'; result: IteratorResult<T> }
  | { status: 'aborted'; signal: AbortSignal }

export class AsyncIteratorAbortedError extends Error {
  readonly signal: AbortSignal

  constructor(signal: AbortSignal) {
    super('Async iterator aborted while waiting for the next value')
    this.name = 'AsyncIteratorAbortedError'
    this.signal = signal
  }
}

/**
 * Wait for an async iterator value without relying on the iterator's
 * implementation to notice cancellation. Some native-backed iterators can
 * leave next() pending even after their transport has been aborted.
 */
export async function nextWithAbort<T>(
  iterator: AsyncIterator<T>,
  signals: readonly AbortSignal[],
): Promise<AbortableIteratorResult<T>> {
  const alreadyAborted = signals.find(signal => signal.aborted)
  if (alreadyAborted) {
    return { status: 'aborted', signal: alreadyAborted }
  }

  const listeners: Array<{
    signal: AbortSignal
    listener: () => void
  }> = []

  const abortPromise = new Promise<AbortableIteratorResult<T>>(resolve => {
    for (const signal of signals) {
      const listener = () => {
        resolve({ status: 'aborted', signal })
      }
      listeners.push({ signal, listener })
      signal.addEventListener('abort', listener, { once: true })
    }
  })

  try {
    return await Promise.race([
      Promise.resolve(iterator.next()).then(
        result => ({ status: 'next', result }) as const,
      ),
      abortPromise,
    ])
  } finally {
    for (const { signal, listener } of listeners) {
      signal.removeEventListener('abort', listener)
    }
  }
}

/**
 * Wrap an async iterable so cancellation can escape a permanently pending
 * next() call. The abandoned promise keeps its own rejection handler through
 * Promise.race, preventing a later native rejection from becoming unhandled.
 */
export async function* abortableAsyncIterable<T>(
  iterable: AsyncIterable<T>,
  signals: readonly AbortSignal[],
  createAbortError: (signal: AbortSignal) => unknown = signal =>
    new AsyncIteratorAbortedError(signal),
): AsyncGenerator<T> {
  const iterator = iterable[Symbol.asyncIterator]()
  let completed = false
  try {
    while (true) {
      const next = await nextWithAbort(iterator, signals)
      if (next.status === 'aborted') {
        throw createAbortError(next.signal)
      }
      if (next.result.done) {
        completed = true
        return
      }
      yield next.result.value
    }
  } finally {
    if (!completed) {
      // Do not await return(): native-backed iterators can queue it behind the
      // pending next() call that this wrapper exists to escape from.
      try {
        const closeResult = iterator.return?.()
        if (closeResult) void Promise.resolve(closeResult).catch(() => {})
      } catch {
        // The caller remains responsible for aborting its transport.
      }
    }
  }
}

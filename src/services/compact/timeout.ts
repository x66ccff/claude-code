import { createChildAbortController } from '../../utils/abortController.js'

export const DEFAULT_COMPACT_FORK_TIMEOUT_MS = 150_000

export class CompactForkTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Compact cache-sharing request timed out after ${timeoutMs}ms`)
    this.name = 'CompactForkTimeoutError'
  }
}

export function getCompactForkTimeoutMs(
  value: string | undefined = process.env.CLAUDE_COMPACT_FORK_TIMEOUT_MS,
): number {
  if (value === undefined) return DEFAULT_COMPACT_FORK_TIMEOUT_MS

  const parsed = Number.parseInt(value, 10)
  return Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_COMPACT_FORK_TIMEOUT_MS
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Compact cache-sharing request was aborted')
}

/**
 * Give the cache-sharing fork its own cancellation boundary. Parent
 * cancellation rejects immediately even if a provider stream fails to settle;
 * a fork timeout leaves the parent usable by the regular compact fallback.
 */
export async function runCompactForkWithTimeout<T>(
  parentController: AbortController,
  operation: (forkController: AbortController) => Promise<T>,
  timeoutMs = getCompactForkTimeoutMs(),
): Promise<T> {
  const forkController = createChildAbortController(parentController)
  if (forkController.signal.aborted) {
    throw abortReason(forkController.signal)
  }

  let timeout: ReturnType<typeof setTimeout> | undefined
  let abortHandler: (() => void) | undefined
  const operationPromise = Promise.resolve().then(() =>
    operation(forkController),
  )
  // A provider may reject after the timeout race has completed.
  void operationPromise.catch(() => {})

  const abortPromise = new Promise<never>((_, reject) => {
    abortHandler = () => reject(abortReason(forkController.signal))
    forkController.signal.addEventListener('abort', abortHandler, {
      once: true,
    })
    timeout = setTimeout(() => {
      forkController.abort(new CompactForkTimeoutError(timeoutMs))
    }, timeoutMs)
  })

  try {
    return await Promise.race([operationPromise, abortPromise])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
    if (abortHandler) {
      forkController.signal.removeEventListener('abort', abortHandler)
    }
    // Also detaches the parent propagation listener after normal completion.
    if (!forkController.signal.aborted) forkController.abort()
  }
}

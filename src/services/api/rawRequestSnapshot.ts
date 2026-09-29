import { getSessionId, onSessionSwitch } from '../../bootstrap/state.js'

export type RawRequestSnapshot = {
  sessionId: string
  provider: string
  capturedAt: number
  body: string
}

type Listener = () => void

let snapshot: RawRequestSnapshot | null = null
const listeners = new Set<Listener>()

export function shouldCaptureRawRequest(querySource?: string): boolean {
  return querySource?.startsWith('repl_main_thread') === true
}

export function recordRawRequestBody(provider: string, body: unknown): void {
  if (typeof body !== 'string') return
  snapshot = {
    sessionId: getSessionId(),
    provider,
    capturedAt: Date.now(),
    body,
  }
  for (const listener of listeners) listener()
}

export function getRawRequestSnapshot(): RawRequestSnapshot | null {
  return snapshot?.sessionId === getSessionId() ? snapshot : null
}

export function subscribeRawRequestSnapshot(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function clearRawRequestSnapshot(): void {
  if (snapshot === null) return
  snapshot = null
  for (const listener of listeners) listener()
}

onSessionSwitch(clearRawRequestSnapshot)

export function wrapFetchForRawRequest(
  fetchImpl: typeof fetch,
  provider: string,
): typeof fetch {
  const wrapped = (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    recordRawRequestBody(provider, init?.body)
    return fetchImpl(input, init)
  }
  return wrapped as typeof fetch
}

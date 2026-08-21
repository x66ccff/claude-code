import { isEnvTruthy } from '../../../utils/envUtils.js'

let requestTail = Promise.resolve()

/**
 * Optionally serialize OpenAI-compatible requests. Some local multi-node
 * deployments need the server's internal scheduler slots for initialization
 * but cannot safely execute more than one aggregate request at a time.
 */
export async function acquireOpenAIRequestSlot(): Promise<() => void> {
  if (!isEnvTruthy(process.env.CLAUDE_CODE_OPENAI_SERIAL_REQUESTS)) {
    return () => {}
  }

  let resolveCurrent: () => void = () => {}
  const current = new Promise<void>(resolve => {
    resolveCurrent = resolve
  })
  const previous = requestTail
  requestTail = current
  await previous

  let released = false
  return () => {
    if (released) return
    released = true
    resolveCurrent()
  }
}

/**
 * Cancellation tests depend on real AbortController propagation and timers.
 * Run them outside the process-global mock.module() state of the full suite.
 */
import { describe, test } from 'bun:test'
import { relative, resolve } from 'node:path'

const PROJECT_ROOT = resolve(__dirname, '..', '..', '..', '..')
const RUNNER_ABS = resolve(__dirname, 'timeout.runner.ts')
const RUNNER_REL = './' + relative(PROJECT_ROOT, RUNNER_ABS).replace(/\\/g, '/')

describe('compact fork timeout', () => {
  test('runs cancellation tests in an isolated subprocess', async () => {
    const proc = Bun.spawn([process.execPath, 'test', RUNNER_REL], {
      cwd: PROJECT_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const code = await proc.exited
    if (code !== 0) {
      const stderr = await new Response(proc.stderr).text()
      const stdout = await new Response(proc.stdout).text()
      const output = (stderr + '\n' + stdout).slice(-3000)
      throw new Error(
        `compact timeout test subprocess failed (exit ${code}):\n${output}`,
      )
    }
  }, 60_000)
})

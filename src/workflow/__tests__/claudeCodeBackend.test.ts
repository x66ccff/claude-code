/**
 * Run this mock-heavy suite in its own process. Bun's mock.module() registry is
 * process-global, and the backend's UUID/message mocks otherwise leak into
 * unrelated tests that expect the real implementations.
 */
import { describe, test } from 'bun:test'
import { relative, resolve } from 'node:path'

const PROJECT_ROOT = resolve(__dirname, '..', '..', '..')
const RUNNER_ABS = resolve(__dirname, 'claudeCodeBackend.runner.ts')
const RUNNER_REL = './' + relative(PROJECT_ROOT, RUNNER_ABS).replace(/\\/g, '/')

describe('claudeCodeBackend', () => {
  test('runs backend tests in an isolated subprocess', async () => {
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
        `claudeCodeBackend test subprocess failed (exit ${code}):\n${output}`,
      )
    }
  }, 60_000)
})

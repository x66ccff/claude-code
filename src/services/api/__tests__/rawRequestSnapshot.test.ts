// Isolate real SDK and session state from other suites' module mocks.
import { test } from 'bun:test'
import { relative, resolve } from 'node:path'

const root = resolve(import.meta.dir, '../../../..')
const runner =
  './' +
  relative(
    root,
    resolve(import.meta.dir, 'rawRequestSnapshot.runner.ts'),
  ).replace(/\\/g, '/')

test('rawRequestSnapshot runs with isolated module state', async () => {
  const proc = Bun.spawn([process.execPath, 'test', runner], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  if (code !== 0)
    throw new Error(`Isolated suite failed (${code}):\n${stdout}\n${stderr}`)
}, 60_000)

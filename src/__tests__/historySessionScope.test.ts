import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Point CLAUDE_CONFIG_DIR at a temp dir BEFORE importing history.js so
// getClaudeConfigHomeDir (memoized per CLAUDE_CONFIG_DIR value) resolves there.
const tempDir = join(
  tmpdir(),
  `claude-history-scope-test-${process.pid}-${Date.now()}`,
)
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
mkdirSync(tempDir, { recursive: true })
process.env.CLAUDE_CONFIG_DIR = tempDir

const { getHistory } = await import('../history.js')
const { switchSession, setProjectRoot } = await import('../bootstrap/state.js')

const PROJECT = '/mnt/workspace/my-project'
const SESSION_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const SESSION_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'

function asUuid(s: string): any {
  return s as unknown as any
}

function line(
  display: string,
  opts: { project?: string; sessionId?: string; ts: number },
): string {
  const entry: Record<string, unknown> = {
    display,
    pastedContents: {},
    timestamp: opts.ts,
    project: opts.project ?? PROJECT,
  }
  // Legacy lines (pre-sessionId) omit the field entirely.
  if (opts.sessionId !== undefined) entry.sessionId = opts.sessionId
  return JSON.stringify(entry)
}

// Chronological order on disk; makeLogEntryReader reads newest-first.
writeFileSync(
  join(tempDir, 'history.jsonl'),
  [
    line('a1', { sessionId: SESSION_A, ts: 1000 }),
    line('b1', { sessionId: SESSION_B, ts: 1100 }),
    line('a2', { sessionId: SESSION_A, ts: 1200 }),
    line('x1', { project: '/other/project', sessionId: SESSION_A, ts: 1300 }),
    line('legacy-1', { ts: 1400 }),
    line('b2', { sessionId: SESSION_B, ts: 1500 }),
    line('a3', { sessionId: SESSION_A, ts: 1600 }),
  ].join('\n') + '\n',
)

setProjectRoot(PROJECT)
switchSession(asUuid(SESSION_A))

async function collect(
  gen: AsyncGenerator<{ display: string }>,
): Promise<string[]> {
  const out: string[] = []
  for await (const entry of gen) out.push(entry.display)
  return out
}

afterAll(() => {
  if (originalConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  }
  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

describe('getHistory — sessionOnly (up-arrow recall)', () => {
  test('yields ONLY current-session entries of the current project, newest-first', async () => {
    const displays = await collect(getHistory({ sessionOnly: true }))
    expect(displays).toEqual(['a3', 'a2', 'a1'])
  })

  test('never surfaces other sessions or legacy entries without sessionId', async () => {
    const displays = await collect(getHistory({ sessionOnly: true }))
    expect(displays).not.toContain('b1')
    expect(displays).not.toContain('b2')
    expect(displays).not.toContain('x1')
    expect(displays).not.toContain('legacy-1')
  })

  test('after switchSession (resume), recall follows the new session id', async () => {
    switchSession(asUuid(SESSION_B))
    const displays = await collect(getHistory({ sessionOnly: true }))
    expect(displays).toEqual(['b2', 'b1'])
    switchSession(asUuid(SESSION_A))
  })
})

describe('getHistory — default mode (shell completion) unchanged', () => {
  test('current session first, then other sessions of the same project', async () => {
    const displays = await collect(getHistory())
    // Session A newest-first, then the rest (B + legacy) newest-first.
    expect(displays).toEqual(['a3', 'a2', 'a1', 'b2', 'legacy-1', 'b1'])
  })

  test('still excludes other projects', async () => {
    const displays = await collect(getHistory())
    expect(displays).not.toContain('x1')
  })
})

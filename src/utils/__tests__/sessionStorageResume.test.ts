import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const {
  resolveSessionFilePath,
  describeSessionSearchPaths,
  getLastSessionLog,
  getProjectsDir,
  clearSessionMessagesCache,
} = await import('../sessionStorage.js')

function asUuid(s: string): any {
  return s as unknown as any
}

let tempDir: string
let originalConfigDir: string | undefined

beforeEach(() => {
  tempDir = join(
    tmpdir(),
    `claude-resume-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  mkdirSync(join(tempDir, 'projects'), { recursive: true })
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tempDir
})

afterEach(() => {
  clearSessionMessagesCache()
  if (originalConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  }
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

// A transcript line minimal enough for loadTranscriptFile → messages.set and
// buildConversationChain (single message, parentUuid null).
function transcriptLine(sessionId: string, uuid: string): string {
  return JSON.stringify({
    type: 'user',
    uuid,
    parentUuid: null,
    isSidechain: false,
    cwd: '/somewhere/else',
    sessionId,
    timestamp: new Date().toISOString(),
    version: '2.8.4',
    message: { role: 'user', content: 'hello from another project' },
  })
}

describe('resolveSessionFilePath — cross-project resume', () => {
  test('finds a session that lives in a different project dir', async () => {
    const id = '11111111-2222-3333-4444-555555555555'
    const otherDir = join(getProjectsDir(), '-mnt-workspace-other-project')
    mkdirSync(otherDir, { recursive: true })
    const file = join(otherDir, `${id}.jsonl`)
    writeFileSync(file, transcriptLine(id, 'u-1') + '\n')

    // The cwd-scoped primary path does not exist in the temp config dir, so
    // this can only resolve via the cross-project scan.
    await expect(resolveSessionFilePath(id)).resolves.toBe(file)
  })

  test('returns null when no project dir contains the session', async () => {
    await expect(
      resolveSessionFilePath('99999999-9999-4999-8999-999999999999'),
    ).resolves.toBeNull()
  })
})

describe('getLastSessionLog — cross-project fullPath', () => {
  test('fullPath points at the actually-found file, not the cwd-scoped path', async () => {
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const otherDir = join(getProjectsDir(), '-home-user-some-project')
    mkdirSync(otherDir, { recursive: true })
    const file = join(otherDir, `${id}.jsonl`)
    writeFileSync(file, transcriptLine(id, 'u-1') + '\n')

    const log = await getLastSessionLog(asUuid(id))
    expect(log).not.toBeNull()
    // processResumedConversation uses dirname(fullPath) to switchSession, so
    // subsequent messages append to THIS file rather than a cwd-scoped one.
    expect(log?.fullPath).toBe(file)
    expect(log?.messageCount).toBe(1)
  })

  test('returns null for an unknown session id', async () => {
    await expect(
      getLastSessionLog(asUuid('12345678-1234-4123-8123-123456789abc')),
    ).resolves.toBeNull()
  })
})

describe('describeSessionSearchPaths — debug hint', () => {
  test('names the session id, the projects root, and CLAUDE_CONFIG_DIR', () => {
    const id = 'cafe1234-cafe-4caf-8caf-cafe12345678'
    const text = describeSessionSearchPaths(id)
    expect(text).toContain(id)
    expect(text).toContain(`${id}.jsonl`)
    expect(text).toContain(getProjectsDir())
    expect(text).toContain('CLAUDE_CONFIG_DIR')
  })
})

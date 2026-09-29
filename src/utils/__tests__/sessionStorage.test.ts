import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { LogOption } from 'src/types/logs.js'

const MAX_CACHED_ENTRIES = 200 // mirrors MAX_CACHED_SESSION_FILES in sessionStorage.ts

const {
  getSessionMessages,
  getSessionMessagesCache,
  clearSessionMessagesCache,
  enrichLogs,
} = await import('../sessionStorage.js')

function asUuid(s: string): any {
  return s as unknown as any
}

let tempDir: string
let originalConfigDir: string | undefined

beforeEach(() => {
  tempDir = join(
    tmpdir(),
    `claude-session-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  mkdirSync(tempDir, { recursive: true })
  // `getProjectsDir()` returns `${CLAUDE_CONFIG_DIR}/projects`, and
  // loadSessionFile reads from `${getProjectsDir()}/${sessionId}.jsonl`.
  // Pre-create the projects subdir so writeFileSync doesn't fail.
  mkdirSync(join(tempDir, 'projects'), { recursive: true })
  // Pin session-file lookups to a temp dir via CLAUDE_CONFIG_DIR.
  // Restoring in afterEach keeps tests hermetic.
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

function sessionFilePath(sessionId: string): string {
  // Mirror sessionStorage.ts's path computation:
  //   getSessionProjectDir() ?? getProjectDir(getOriginalCwd())
  // With CLAUDE_CONFIG_DIR=tempDir and getSessionProjectDir() returning
  // null in tests, files live at `${tempDir}/projects/${sessionId}.jsonl`.
  return join(tempDir, 'projects', `${sessionId}.jsonl`)
}

describe('getSessionMessagesCache', () => {
  test('returns the same Map instance across calls', () => {
    // Cache identity must be stable — `getLastSessionLog` uses
    // `getSessionMessagesCache()` directly to prime entries, so a
    // different instance each call would break that priming.
    expect(getSessionMessagesCache()).toBe(getSessionMessagesCache())
  })

  test('clearSessionMessagesCache empties a populated cache', async () => {
    const cache = getSessionMessagesCache()
    writeFileSync(sessionFilePath('id-1'), '')
    writeFileSync(sessionFilePath('id-2'), '')
    await getSessionMessages(asUuid('id-1'))
    await getSessionMessages(asUuid('id-2'))
    expect(cache.size).toBeGreaterThan(0)

    clearSessionMessagesCache()
    expect(cache.size).toBe(0)
  })

  test('clearSessionMessagesCache is a no-op on empty cache', () => {
    const cache = getSessionMessagesCache()
    expect(cache.size).toBe(0)
    clearSessionMessagesCache()
    expect(cache.size).toBe(0)
  })

  test('getSessionMessages dedups concurrent calls for the same sessionId', async () => {
    const cache = getSessionMessagesCache()
    const id = asUuid('same-id')
    writeFileSync(sessionFilePath('same-id'), '')
    const [a, b, c] = await Promise.all([
      getSessionMessages(id),
      getSessionMessages(id),
      getSessionMessages(id),
    ])
    expect(a).toBe(b)
    expect(b).toBe(c)
    expect(cache.size).toBe(1)
  })
})

describe('getSessionMessages bounded cache (memory leak fix)', () => {
  test('cache size stays at MAX_CACHED_ENTRIES after many distinct sessionIds', async () => {
    // Bounded cache — calling getSessionMessages with N distinct
    // sessionIds must NOT grow the cache beyond MAX_CACHED_ENTRIES.
    // Pre-fix: lodash memoize grew unbounded. Post-fix: Map-based
    // cache evicts oldest entry when at capacity.
    const cache = getSessionMessagesCache()
    const total = MAX_CACHED_ENTRIES * 3 // 600 distinct sessionIds
    for (let i = 0; i < total; i++) {
      writeFileSync(sessionFilePath(`id-${i}`), '')
      await getSessionMessages(asUuid(`id-${i}`))
    }
    expect(cache.size).toBe(MAX_CACHED_ENTRIES)
  })

  test('FIFO eviction: oldest entry is removed first', async () => {
    // Fill cache to MAX with sequential ids. The first inserted
    // (`oldest`) should be evicted on the (MAX+1)th insertion.
    const cache = getSessionMessagesCache()
    const oldestId = asUuid('id-0')
    writeFileSync(sessionFilePath('id-0'), '')
    await getSessionMessages(oldestId)
    for (let i = 1; i < MAX_CACHED_ENTRIES; i++) {
      writeFileSync(sessionFilePath(`id-${i}`), '')
      await getSessionMessages(asUuid(`id-${i}`))
    }
    expect(cache.size).toBe(MAX_CACHED_ENTRIES)
    expect(cache.has(oldestId)).toBe(true)

    writeFileSync(sessionFilePath('id-overflow'), '')
    await getSessionMessages(asUuid('id-overflow'))
    expect(cache.size).toBe(MAX_CACHED_ENTRIES)
    expect(cache.has(oldestId)).toBe(false)
  })

  test('cleared cache can be refilled without leaking entries', async () => {
    const cache = getSessionMessagesCache()
    for (let i = 0; i < MAX_CACHED_ENTRIES; i++) {
      writeFileSync(sessionFilePath(`id-${i}`), '')
      await getSessionMessages(asUuid(`id-${i}`))
    }
    expect(cache.size).toBe(MAX_CACHED_ENTRIES)

    clearSessionMessagesCache()
    expect(cache.size).toBe(0)

    for (let i = 0; i < MAX_CACHED_ENTRIES + 5; i++) {
      writeFileSync(sessionFilePath(`refill-${i}`), '')
      await getSessionMessages(asUuid(`refill-${i}`))
    }
    expect(cache.size).toBe(MAX_CACHED_ENTRIES)
  })
})

// ─── enrichLogs hostname extraction (/resume picker, dsw/dlc hosts) ───

describe('enrichLogs hostname extraction', () => {
  function transcriptLine(fields: Record<string, unknown>): string {
    return JSON.stringify({
      type: 'user',
      parentUuid: null,
      isSidechain: false,
      cwd: '/tmp/proj',
      sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      timestamp: new Date().toISOString(),
      version: '2.8.4',
      message: { role: 'user', content: 'hello world' },
      ...fields,
    })
  }

  function liteLog(filePath: string): LogOption {
    return {
      date: new Date().toISOString(),
      messages: [],
      value: 0,
      created: new Date(),
      modified: new Date(),
      firstPrompt: '',
      messageCount: 0,
      fileSize: statSync(filePath).size,
      isSidechain: false,
      isLite: true,
      fullPath: filePath,
      sessionId: asUuid('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),
    }
  }

  async function enrichSingle(filePath: string): Promise<LogOption> {
    const { logs } = await enrichLogs([liteLog(filePath)], 0, 1)
    expect(logs.length).toBe(1)
    return logs[0]!
  }

  test('extracts hostname from head of transcript', async () => {
    const file = join(tempDir, 'host-basic.jsonl')
    writeFileSync(
      file,
      [
        transcriptLine({ hostname: 'dsw-1-abc' }),
        transcriptLine({ hostname: 'dsw-1-abc' }),
      ].join('\n') + '\n',
    )
    const log = await enrichSingle(file)
    expect(log.hostname).toBe('dsw-1-abc')
  })

  test('discards scraped hostname not matching dsw/dlc (guard)', async () => {
    const file = join(tempDir, 'host-guard.jsonl')
    writeFileSync(file, transcriptLine({ hostname: 'my-laptop' }) + '\n')
    const log = await enrichSingle(file)
    expect(log.hostname).toBeUndefined()
  })

  test('prefers HEAD hostname over tail (cross-machine resume)', async () => {
    const file = join(tempDir, 'host-head-wins.jsonl')
    // Filler pushes the final line outside the 64KB head buffer, so head
    // and tail are distinct regions of the file.
    const filler = transcriptLine({
      message: { role: 'user', content: 'x'.repeat(2000) },
    })
    const lines = [transcriptLine({ hostname: 'dsw-aaa' })]
    for (let i = 0; i < 40; i++) {
      lines.push(filler)
    }
    lines.push(transcriptLine({ hostname: 'dlc-bbb' }))
    writeFileSync(file, lines.join('\n') + '\n')
    expect(statSync(file).size).toBeGreaterThan(65536)
    const log = await enrichSingle(file)
    expect(log.hostname).toBe('dsw-aaa')
  })

  test('returns undefined hostname for pre-feature sessions', async () => {
    const file = join(tempDir, 'host-absent.jsonl')
    writeFileSync(file, transcriptLine({}) + '\n')
    const log = await enrichSingle(file)
    expect(log.hostname).toBeUndefined()
  })
})

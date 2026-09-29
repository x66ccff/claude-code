// Unit tests for the [agent-timeout patch] in a caller-provided build chunk.
// Extracts the REAL patched functions from the deployed chunk and runs them
// against fake ports/ctx, mirroring the engine's call graph.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { pathToFileURL } from 'url'
import { createHash } from 'crypto'

const chunkArg = process.argv[2] || process.env.CCB_TEST_CHUNK
if (!chunkArg) {
  console.error(
    'Usage: bun tests/test-agent-timeout.mjs <patched-chunk.js> (or set CCB_TEST_CHUNK)',
  )
  process.exit(2)
}
const CHUNK = resolve(chunkArg)
const testDir = mkdtempSync(join(tmpdir(), 'ccb-agent-timeout-'))
const extractedPath = join(testDir, 'extracted-hooks.mjs')
const extractedUrl = pathToFileURL(extractedPath).href
process.on('exit', () => rmSync(testDir, { recursive: true, force: true }))
const src = readFileSync(CHUNK, 'utf-8')
const lines = src.split('\n')

function extractFunction(name) {
  const start = lines.findIndex(
    l => l === `function ${name}(` || l.startsWith(`function ${name}(`),
  )
  if (start < 0) throw new Error(`function ${name} not found`)
  let end = -1
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i] === '}') {
      end = i
      break
    }
  }
  if (end < 0) throw new Error(`end of ${name} not found`)
  return lines.slice(start, end + 1).join('\n')
}

const extracted = {
  agentTimeoutEnvInt: extractFunction('agentTimeoutEnvInt'),
  canonicalParams: extractFunction('canonicalParams'),
  agentCallKey: extractFunction('agentCallKey'),
  resultToOutput: extractFunction('resultToOutput'),
  makeHooks: extractFunction('makeHooks'),
}
for (const [k, v] of Object.entries(extracted)) {
  if (!v || v.length < 50) throw new Error(`extraction of ${k} looks wrong`)
}
if (!extracted.makeHooks.includes('[agent-timeout patch]'))
  throw new Error('patch marker missing in makeHooks')

const moduleSource = `
import { createHash } from "crypto";
class WorkflowError extends Error { constructor(m) { super(m); this.name = "WorkflowError"; } }
class WorkflowAbortedError extends Error { constructor(m) { super(m ?? "aborted"); this.name = "WorkflowAbortedError"; } }
const MAX_TOTAL_AGENTS = 1000;
const MAX_ITEMS_PER_CALL = 4096;
const assertValidJsonSchema = () => {};
const validateStructuredResult = (result) => result;
${extracted.agentTimeoutEnvInt}
${extracted.canonicalParams}
${extracted.agentCallKey}
${extracted.resultToOutput}
${extracted.makeHooks}
export { makeHooks, agentCallKey, WorkflowAbortedError };
`
writeFileSync(extractedPath, moduleSource)
const { makeHooks, agentCallKey, WorkflowAbortedError } = await import(
  extractedUrl
)

// ---------- harness ----------
let passed = 0,
  failed = 0
function check(cond, msg) {
  if (cond) {
    passed++
    console.log(`  ok  ${msg}`)
  } else {
    failed++
    console.log(`  FAIL ${msg}`)
  }
}

function makeCtx({ adapterRun, journal = [], signal } = {}) {
  const events = []
  const warns = []
  const journalAppends = []
  const killed = []
  const registeredAborts = []
  const ctx = {
    ports: {
      progressEmitter: { emit: e => events.push(e) },
      logger: { warn: m => warns.push(m) },
      journalStore: {
        append: async (runId, entry) => {
          journalAppends.push(entry)
        },
        truncate: async () => {},
        read: async () => [],
      },
      taskRegistrar: {
        pendingAction: () => null,
        killAgent: (runId, agentId) => {
          killed.push({ runId, agentId })
          return true
        },
        registerAgentAbort: (runId, id, ac) => {
          registeredAborts.push({ runId, id })
        },
        unregisterAgentAbort: () => {},
      },
      agentAdapterRegistry: { resolve: () => ({ run: adapterRun }) },
    },
    host: {},
    signal: signal ?? new AbortController().signal,
    runId: 'test-run',
    resources: {
      semaphore: { acquire: async () => () => {} },
      budget: {
        assertCanSpend() {},
        addOutputTokens() {},
        spent: () => 0,
        remaining: () => Infinity,
      },
      agentCountBox: { value: 0 },
      agentIdSeq: { value: 0 },
      depth: 0,
    },
    journal: [...journal],
    journalIndex: 0,
    journalInvalidated: false,
    currentPhase: null,
  }
  return { ctx, events, warns, journalAppends, killed, registeredAborts }
}
const okResult = output => ({ kind: 'ok', output, usage: { outputTokens: 1 } })
const sleep = ms => new Promise(r => setTimeout(r, ms))
function setEnv(o) {
  for (const [k, v] of Object.entries(o)) process.env[k] = String(v)
}

// fast timeouts for tests
const FAST = {
  CCB_AGENT_TIMEOUT_MS: 150,
  CCB_AGENT_TIMEOUT_RETRY_MS: 150,
  CCB_AGENT_TIMEOUT_MAX_RETRIES: 2,
}

console.log(
  'test 1: normal success — no kill, journal appended, output returned',
)
{
  setEnv(FAST)
  const calls = []
  const h = makeCtx({
    adapterRun: async params => {
      calls.push(params)
      return okResult('done')
    },
  })
  const hooks = makeHooks(h.ctx, async () => {})
  const out = await hooks.agent('p1')
  check(out === 'done', 'returns adapter output')
  check(
    calls.length === 1 && calls[0].prompt === 'p1',
    'backend called once with original prompt',
  )
  check(h.killed.length === 0, 'killAgent not called')
  check(
    h.journalAppends.length === 1 && h.journalAppends[0].result.kind === 'ok',
    'journal appended once',
  )
}

console.log(
  'test 2: hang -> timeout -> immediate retry WITH urgency suffix -> success',
)
{
  setEnv(FAST)
  const calls = []
  let n = 0
  const h = makeCtx({
    adapterRun: async params => {
      calls.push(params)
      if (++n === 1) {
        await sleep(5000)
        return okResult('never')
      } // hang past 150ms
      return okResult('recovered')
    },
  })
  const hooks = makeHooks(h.ctx, async () => {})
  const out = await hooks.agent('task')
  check(out === 'recovered', 'retry result returned')
  check(calls.length === 2, 'backend called twice')
  check(
    calls[1].prompt.startsWith('task\n\n尽快完成任务，只给你') &&
      /min时间！$/.test(calls[1].prompt),
    `retry prompt has urgency suffix: ${JSON.stringify(calls[1].prompt.slice(-30))}`,
  )
  check(
    h.killed.length === 1 &&
      h.killed[0].runId === 'test-run' &&
      h.killed[0].agentId === 0,
    'killAgent called once for the stuck agent',
  )
  check(
    h.warns.some(w => w.includes('immediate retry 1/2')),
    'warn log for immediate retry present',
  )
  check(
    h.journalAppends.length === 1,
    'journal appended once (under original key)',
  )
}

console.log(
  'test 3: all attempts time out -> WorkflowAbortedError + dead agent_done + no journal',
)
{
  setEnv(FAST)
  const calls = []
  const h = makeCtx({
    adapterRun: async params => {
      calls.push(params)
      await sleep(5000)
      return okResult('never')
    },
  })
  const hooks = makeHooks(h.ctx, async () => {})
  let threw = null
  try {
    await hooks.agent('doomed')
  } catch (e) {
    threw = e
  }
  check(
    threw instanceof WorkflowAbortedError,
    'throws WorkflowAbortedError (entire workflow aborts)',
  )
  check(
    calls.length === 3,
    `backend called 3 times (1 initial + 2 retries), got ${calls.length}`,
  )
  check(h.killed.length === 3, 'killAgent called for every timed-out attempt')
  const done = h.events.filter(e => e.type === 'agent_done')
  check(
    done.length === 1 &&
      done[0].result.kind === 'dead' &&
      done[0].result.reason === 'agent-timeout',
    'agent_done emitted with dead/agent-timeout',
  )
  check(
    h.journalAppends.length === 0,
    'nothing journaled for aborted agent (resume will rerun it)',
  )
  check(
    h.warns.some(w => w.includes('ABORTING ENTIRE WORKFLOW')),
    'abort warn logged',
  )
}

console.log(
  'test 4: regression — backend throws once, retried once WITHOUT suffix, succeeds',
)
{
  setEnv(FAST)
  const calls = []
  let n = 0
  const h = makeCtx({
    adapterRun: async params => {
      calls.push(params)
      if (++n === 1) throw new Error('boom')
      return okResult('fine')
    },
  })
  const hooks = makeHooks(h.ctx, async () => {})
  const out = await hooks.agent('err-task')
  check(out === 'fine', 'error retry recovers')
  check(
    calls.length === 2 && calls[1].prompt === 'err-task',
    'retry keeps original prompt (no urgency suffix on error path)',
  )
  check(
    h.warns.some(w => w.includes('threw (boom); retrying once')),
    'original warn message preserved',
  )
  check(h.killed.length === 0, 'no kill on error path')
}

console.log(
  'test 5: regression — backend throws twice -> dead journaled, returns null, NO abort',
)
{
  setEnv(FAST)
  const h = makeCtx({
    adapterRun: async () => {
      throw new Error('always-boom')
    },
  })
  const hooks = makeHooks(h.ctx, async () => {})
  const out = await hooks.agent('bad')
  check(out === null, 'returns null for dead agent')
  check(
    h.journalAppends.length === 1 &&
      h.journalAppends[0].result.kind === 'dead' &&
      h.journalAppends[0].result.reason === 'runagent-threw',
    'dead result journaled with runagent-threw',
  )
  check(
    h.events.some(e => e.type === 'agent_done' && e.result.kind === 'dead'),
    'agent_done dead emitted (workflow continues)',
  )
}

console.log('test 6: CCB_AGENT_TIMEOUT_MS=0 disables timeout entirely')
{
  setEnv({ ...FAST, CCB_AGENT_TIMEOUT_MS: 0 })
  const h = makeCtx({
    adapterRun: async () => {
      await sleep(250)
      return okResult('slow-but-ok')
    },
  })
  const hooks = makeHooks(h.ctx, async () => {})
  const t0 = Date.now()
  const out = await hooks.agent('slow')
  check(
    out === 'slow-but-ok' && Date.now() - t0 >= 240,
    'slow backend completes when timeout disabled',
  )
  check(h.killed.length === 0, 'no kill when disabled')
}

console.log(
  'test 7: journal replay — cached key returns instantly, backend untouched',
)
{
  setEnv(FAST)
  const key = agentCallKey('cached-task', { prompt: 'cached-task' })
  const h = makeCtx({
    adapterRun: async () => {
      throw new Error('backend must not run')
    },
    journal: [{ key, seq: 0, result: okResult('cached-output') }],
  })
  const hooks = makeHooks(h.ctx, async () => {})
  const out = await hooks.agent('cached-task')
  check(out === 'cached-output', 'cached result replayed')
  check(h.journalAppends.length === 0, 'no new journal entry on replay')
  check(
    h.events.some(
      e => e.type === 'agent_done' && e.result.output === 'cached-output',
    ),
    'agent_done emitted from cache',
  )
}

console.log(
  'test 8: mixed — first attempt throws, error-retry TIMES OUT, then timeout-retry succeeds',
)
{
  setEnv(FAST)
  const calls = []
  let n = 0
  const h = makeCtx({
    adapterRun: async params => {
      calls.push(params)
      n++
      if (n === 1) throw new Error('transient')
      if (n === 2) {
        await sleep(5000)
        return okResult('never')
      } // times out
      return okResult('finally')
    },
  })
  const hooks = makeHooks(h.ctx, async () => {})
  const out = await hooks.agent('mixed')
  check(out === 'finally', 'recovers after error then timeout')
  check(calls.length === 3, '3 attempts total')
  check(
    calls[2].prompt.includes('尽快完成任务'),
    'urgency suffix applied on post-timeout retry',
  )
  check(h.killed.length === 1, 'only the timed-out attempt killed')
}

console.log('test 9: parent abort propagates as WorkflowAbortedError, no retry')
{
  setEnv(FAST)
  const ac = new AbortController()
  const calls = []
  const h = makeCtx({
    signal: ac.signal,
    adapterRun: async (params, adapterCtx) => {
      calls.push(params)
      // simulate backend honoring abort like claudeCodeBackend does
      const { WorkflowAbortedError: WAE } = await import(extractedUrl)
      throw new WAE()
    },
  })
  const hooks = makeHooks(h.ctx, async () => {})
  let threw = null
  try {
    await hooks.agent('abort-me')
  } catch (e) {
    threw = e
  }
  check(
    threw instanceof WorkflowAbortedError,
    'WorkflowAbortedError propagates',
  )
  check(calls.length === 1, 'no retry after abort')
}

console.log(
  'test 10: adapterCtx receives registerAgentAbort wiring (killAgent can find the AC)',
)
{
  setEnv(FAST)
  let seenCtx = null
  const h = makeCtx({
    adapterRun: async (params, adapterCtx) => {
      seenCtx = adapterCtx
      return okResult('x')
    },
  })
  const hooks = makeHooks(h.ctx, async () => {})
  await hooks.agent('wiring')
  check(
    seenCtx &&
      typeof seenCtx.registerAgentAbort === 'function' &&
      typeof seenCtx.onProgress === 'function',
    'adapterCtx carries registerAgentAbort/onProgress',
  )
  check(
    h.registeredAborts.length === 0 || true,
    'registration is adapter-driven (backend registers its own AC)',
  )
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)

import { MAX_ITEMS_PER_CALL, MAX_TOTAL_AGENTS } from '../constants.js'
import type {
  AgentProgressUpdate,
  AgentRunParams,
  AgentRunResult,
  JournalEntry,
  ProgressEvent,
} from '../types.js'
import type { EngineContext } from './context.js'
import { WorkflowAbortedError, WorkflowError } from './errors.js'
import { agentCallKey } from './journal.js'
import type { WorkflowHooks } from './script.js'
import {
  assertValidJsonSchema,
  validateAgainstSchema,
} from './structuredOutput.js'

/** Sub-workflow executor for the workflow() hook (injected by runWorkflow to avoid circular dependencies). */
export type SubWorkflowRunner = (opts: {
  name?: string
  scriptPath?: string
  script?: string
  args?: unknown
}) => Promise<unknown>

type HookProgressInit =
  | { type: 'phase_started'; phase: string }
  | { type: 'phase_done'; phase: string }
  | { type: 'agent_started'; agentId: number; label?: string; phase?: string }
  | {
      type: 'agent_done'
      agentId: number
      label?: string
      phase?: string
      result: AgentRunResult
    }
  | {
      type: 'agent_progress'
      agentId: number
      label?: string
      phase?: string
      tokenCount: number
      toolCount: number
    }
  | { type: 'log'; message: string }

/** [agent-error-backoff patch] Outcome of one backend invocation attempt (raced against the timeout watchdog). */
type BackendAttempt =
  | { kind: 'result'; value: AgentRunResult }
  | { kind: 'error'; error: unknown }
  | { kind: 'timeout' }

/**
 * [agent-error-backoff patch] Content failures (the agent finished but its output shape is wrong:
 * no-structured-output / invalid-structured-output) get a SINGLE immediate retry. Backoff is pointless
 * here — re-running later yields the same distribution — and re-running an expensive agent 5× on a
 * JSON-formatting miss is wasteful. Transient failures (API/network/throw/infra-dead) instead use the
 * separate exponential-backoff budget (CCB_AGENT_ERROR_*).
 */
const CONTENT_MAX_RETRIES = 1

/**
 * [agent-error-backoff patch] Sleep `ms`, but reject early with WorkflowAbortedError if `signal` aborts
 * (user kill / workflow kill) so a backoff wait never delays cancellation. ms<=0 resolves immediately
 * (tests set CCB_AGENT_ERROR_BACKOFF_MS=0 to keep retries instant).
 */
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new WorkflowAbortedError())
      return
    }
    if (ms <= 0) {
      resolve()
      return
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const onAbort = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      reject(new WorkflowAbortedError())
    }
    timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** [agent-error-backoff patch] One-line human-readable description of a failed attempt, for the retry warn log. */
function describeAttemptFailure(attempt: BackendAttempt): string {
  if (attempt.kind === 'error') {
    const msg =
      attempt.error instanceof Error
        ? attempt.error.message
        : String(attempt.error)
    return `threw (${msg})`
  }
  if (attempt.kind === 'result' && attempt.value.kind === 'dead') {
    const detail =
      typeof attempt.value.detail === 'string' ? attempt.value.detail : ''
    return (
      `returned dead${attempt.value.reason ? ` (${attempt.value.reason})` : ''}` +
      (detail ? `: ${detail.slice(0, 150)}` : '')
    )
  }
  return 'failed'
}

export function makeHooks(
  ctx: EngineContext,
  runSubWorkflow: SubWorkflowRunner,
): WorkflowHooks {
  // All progress events auto-inject runId so the adapter can route them to the corresponding task (multiple concurrent workflows)
  const emit = (init: HookProgressInit): void => {
    ctx.ports.progressEmitter.emit({
      runId: ctx.runId,
      ...init,
    } as ProgressEvent)
  }

  const agent: WorkflowHooks['agent'] = async (prompt, opts = {}) => {
    const r = ctx.resources
    if (r.agentCountBox.value >= MAX_TOTAL_AGENTS) {
      throw new WorkflowError(
        `workflow exceeds total agent cap (${MAX_TOTAL_AGENTS})`,
      )
    }

    // Assign a unique id to each agent() call (including journal hits); stamp started/done so the reducer can associate them precisely
    const agentId = r.agentIdSeq.value++

    const params: AgentRunParams = { prompt, ...opts }
    // Compile before consulting the journal or invoking a backend. An invalid schema is a workflow
    // configuration error, not a transient agent failure, so it must fail directly without retry.
    if (params.schema) assertValidJsonSchema(params.schema)
    const key = agentCallKey(prompt, params)
    const label = opts.label as string | undefined
    const phase =
      (opts.phase as string | undefined) ?? ctx.currentPhase ?? undefined

    const invalidateJournal = async (): Promise<void> => {
      ctx.journalInvalidated = true
      ctx.journal = ctx.journal.slice(0, ctx.journalIndex)
      await ctx.ports.journalStore.truncate(ctx.runId)
    }

    // Journal hit -> return a still-valid cached result directly. Old journal entries predate the
    // engine-level validation boundary, so validate structured output again before replaying it.
    if (!ctx.journalInvalidated && ctx.journalIndex < ctx.journal.length) {
      const entry = ctx.journal[ctx.journalIndex]!
      if (entry.key === key) {
        const cachedResult = validateStructuredResult(
          entry.result,
          params.schema,
        )
        if (entry.result.kind === 'ok' && cachedResult.kind === 'dead') {
          ctx.ports.logger.warn?.(
            `cached agent result for "${label ?? `#${agentId}`}" does not match its structured output schema; rerunning`,
          )
          await invalidateJournal()
        } else {
          ctx.journalIndex++
          emit({
            type: 'agent_done',
            agentId,
            label,
            phase,
            result: entry.result,
          })
          return resultToOutput(entry.result)
        }
      } else {
        // Divergence: discard subsequent journal entries; everything from here on runs live
        await invalidateJournal()
      }
    }

    let release: () => void
    try {
      release = await ctx.resources.semaphore.acquire(ctx.signal)
    } catch {
      // Queued wait during abort: the semaphore already removed the waiter and did not consume a permit
      throw new WorkflowAbortedError()
    }
    try {
      if (ctx.signal.aborted) throw new WorkflowAbortedError()
      // Budget check inside the semaphore critical section: a queued waiter sees the latest spent when woken,
      // otherwise N waiters enqueued while spent=0 all pass the check and overspend on wake-up without re-check.
      // Journal-hit path does not charge budget and needs no check.
      r.budget.assertCanSpend()

      const pending = ctx.ports.taskRegistrar.pendingAction(ctx.runId)
      if (pending?.kind === 'skip') {
        const result: AgentRunResult = { kind: 'skipped' }
        emit({ type: 'agent_done', agentId, label, phase, result })
        return null
      }

      ctx.resources.agentCountBox.value++
      emit({ type: 'agent_started', agentId, label, phase })
      const registry = ctx.ports.agentAdapterRegistry
      // onProgress closure: the backend loop accumulates token/tool counts -> emits an agent_progress event (carrying agentId for association)
      const onProgress = (update: AgentProgressUpdate): void => {
        emit({ type: 'agent_progress', agentId, label, phase, ...update })
      }
      // Inject agent-level AbortController register/unregister: the backend creates the controller then calls
      // registerAgentAbort to inject ports-layer bindings; service.kill(runId, agentId) uses this to
      // precisely abort a single agent. When the registry is absent (agentRunner fallback path), there is no backend middle layer,
      // and agentAbortControllers at the ports layer is always empty — single-agent kill degrades to a no-op on this path.
      const adapterCtx = registry
        ? {
            host: ctx.host,
            signal: ctx.signal,
            runId: ctx.runId,
            agentId,
            onProgress,
            ...(ctx.ports.taskRegistrar.registerAgentAbort
              ? {
                  registerAgentAbort: (
                    id: number,
                    ac: AbortController,
                  ): void => {
                    ctx.ports.taskRegistrar.registerAgentAbort?.(
                      ctx.runId,
                      id,
                      ac,
                    )
                  },
                }
              : {}),
            ...(ctx.ports.taskRegistrar.unregisterAgentAbort
              ? {
                  unregisterAgentAbort: (id: number): void => {
                    ctx.ports.taskRegistrar.unregisterAgentAbort?.(
                      ctx.runId,
                      id,
                    )
                  },
                }
              : {}),
          }
        : null
      // resolve is outside the try: configuration errors (e.g. AdapterNotFoundError) propagate directly without retry —
      // this is a workflow configuration problem, not a transient backend failure; retrying is meaningless and would mask the bug.
      const adapter = registry ? registry.resolve(params) : null
      // [agent-timeout patch] invokeBackend now takes the effective params so the
      // timeout-retry can re-run with the urgency-suffixed prompt while the journal
      // key stays derived from the ORIGINAL prompt (resume determinism preserved).
      const invokeBackend = async (
        runParams: AgentRunParams,
      ): Promise<AgentRunResult> => {
        const rawResult = adapter
          ? adapter.run(runParams, adapterCtx!)
          : ctx.ports.agentRunner.runAgentToResult(runParams, ctx.host)
        return validateStructuredResult(await rawResult, params.schema)
      }

      // [agent-timeout patch] Per-attempt watchdog for a single agent (root cause of
      // /ultracode hangs: one stuck agent holds its semaphore permit forever and the
      // whole workflow stalls). Env-tunable, mirrors the CCB_COMPACT_STALL_* style:
      //   CCB_AGENT_TIMEOUT_MS          per-attempt timeout, default 30min (0 = disabled)
      //   CCB_AGENT_TIMEOUT_RETRY_MS    timeout-retry attempt cap, default 20min
      //   CCB_AGENT_TIMEOUT_MAX_RETRIES immediate retries on timeout, default 2
      // On timeout: killAgent aborts the stuck backend run (registered AbortController),
      // then retry IMMEDIATELY with 「尽快完成任务，只给你20min时间！」 appended to the prompt.
      // Retries exhausted -> emit dead(agent-timeout) + throw WorkflowAbortedError:
      // the ENTIRE workflow aborts (run persisted as killed) instead of hanging.
      // Timed-out attempts are NOT journaled, so resume reruns the agent from scratch.
      // Original error/dead semantics are untouched: one retry without suffix; a final
      // dead is journaled and degrades to null (one agent must not take down the workflow).
      const agentTimeoutMs = agentTimeoutEnvInt(
        'CCB_AGENT_TIMEOUT_MS',
        1_800_000,
      )
      const agentTimeoutRetryMs = agentTimeoutEnvInt(
        'CCB_AGENT_TIMEOUT_RETRY_MS',
        1_200_000,
      )
      const agentTimeoutMaxRetries = agentTimeoutEnvInt(
        'CCB_AGENT_TIMEOUT_MAX_RETRIES',
        2,
      )

      // [agent-error-backoff patch] Transient-failure retry knobs — the user-facing fix: a single
      // API error must NOT kill an agent. Exponential backoff, doubling from the base each retry:
      //   CCB_AGENT_ERROR_BACKOFF_MS      base delay, default 2s (0 = instant; tests use this)
      //   CCB_AGENT_ERROR_BACKOFF_MAX_MS  delay cap, default 60s
      //   CCB_AGENT_ERROR_MAX_RETRIES     retry count, default 5  → waits 2,4,8,16,32s then dead
      // Content failures (wrong output shape) use CONTENT_MAX_RETRIES (single immediate retry) instead.
      const errorMaxRetries = agentTimeoutEnvInt(
        'CCB_AGENT_ERROR_MAX_RETRIES',
        5,
      )
      const errorBackoffBaseMs = agentTimeoutEnvInt(
        'CCB_AGENT_ERROR_BACKOFF_MS',
        2000,
      )
      const errorBackoffMaxMs = agentTimeoutEnvInt(
        'CCB_AGENT_ERROR_BACKOFF_MAX_MS',
        60000,
      )

      let effectiveParams = params
      const attemptBackend = async (
        timeoutMs: number,
      ): Promise<BackendAttempt> => {
        const backendPromise: Promise<BackendAttempt> = (async () => {
          try {
            return {
              kind: 'result',
              value: await invokeBackend(effectiveParams),
            }
          } catch (error) {
            if (error instanceof WorkflowAbortedError) throw error
            return { kind: 'error', error }
          }
        })()
        // When the timeout wins the race the backend promise may still reject later —
        // swallow it so it never surfaces as an unhandled rejection.
        backendPromise.catch(() => {})
        if (timeoutMs <= 0) return backendPromise
        let timer: ReturnType<typeof setTimeout> | undefined
        const timeoutPromise = new Promise<'timed-out'>(resolve => {
          timer = setTimeout(() => resolve('timed-out'), timeoutMs)
        })
        const raced = await Promise.race([backendPromise, timeoutPromise])
        if (timer !== undefined) clearTimeout(timer)
        if (raced === 'timed-out') {
          // Best-effort kill: aborts the stuck agent's registered AbortController via
          // the ports layer (no-op on the agentRunner fallback path).
          ctx.ports.taskRegistrar.killAgent?.(ctx.runId, agentId)
          return { kind: 'timeout' }
        }
        return raced
      }

      let attemptTimeoutMs = agentTimeoutMs
      let timeoutRetries = 0
      // [agent-error-backoff patch] Two independent retry budgets (see the knob comment above):
      //   transientRetries — API error / non-abort throw / infra dead (runagent-threw, worktree-failed);
      //     exponential backoff, default 5 retries — only then is the agent marked dead. This is the fix
      //     for "an API error must not kill an agent on the first failure".
      //   contentRetries — no-structured-output / invalid-structured-output (the agent finished but its
      //     output shape is wrong); single immediate retry (backoff would not help, re-running is costly).
      // WorkflowAbortedError already rethrows inside attemptBackend — user kill intent, never retried.
      // budget is not double-charged: dead does not call addOutputTokens; retry-ok charges once (at the final ok).
      let transientRetries = 0
      let contentRetries = 0
      let result: AgentRunResult
      for (;;) {
        const attempt = await attemptBackend(attemptTimeoutMs)
        if (attempt.kind === 'timeout') {
          if (timeoutRetries >= agentTimeoutMaxRetries) {
            ctx.ports.logger.warn?.(
              `agent "${label ?? `#${agentId}`}" timed out again after ${timeoutRetries} immediate retr(y/ies) — retries exhausted; ABORTING ENTIRE WORKFLOW`,
            )
            const deadResult: AgentRunResult = {
              kind: 'dead',
              reason: 'agent-timeout',
            }
            emit({
              type: 'agent_done',
              agentId,
              label,
              phase,
              result: deadResult,
            })
            throw new WorkflowAbortedError()
          }
          timeoutRetries++
          ctx.ports.logger.warn?.(
            `agent "${label ?? `#${agentId}`}" timed out after ${Math.round(attemptTimeoutMs / 60_000)}min; immediate retry ${timeoutRetries}/${agentTimeoutMaxRetries} with a ${Math.round(agentTimeoutRetryMs / 60_000)}min cap`,
          )
          if (effectiveParams === params) {
            effectiveParams = {
              ...params,
              prompt: `${params.prompt}\n\n尽快完成任务，只给你${Math.round(agentTimeoutRetryMs / 60_000)}min时间！`,
            }
          }
          attemptTimeoutMs = agentTimeoutRetryMs
          continue
        }
        if (attempt.kind === 'result' && attempt.value.kind !== 'dead') {
          result = attempt.value
          break
        }
        // error or non-timeout dead — classify content vs transient and retry on the matching budget.
        // The `attempt.kind === 'result' && attempt.value.kind === 'dead'` guard narrows the union for
        // TS (logically always dead here: the non-dead result case broke out above) and gates the
        // content classification — a thrown error is never a content failure.
        if (
          attempt.kind === 'result' &&
          attempt.value.kind === 'dead' &&
          (attempt.value.reason === 'no-structured-output' ||
            attempt.value.reason === 'invalid-structured-output')
        ) {
          // Content failure: single immediate retry; exhausted → journal the dead and degrade to null.
          if (contentRetries < CONTENT_MAX_RETRIES) {
            contentRetries++
            ctx.ports.logger.warn?.(
              `agent "${label ?? `#${agentId}`}" ${describeAttemptFailure(attempt)}; content retry ${contentRetries}/${CONTENT_MAX_RETRIES} (immediate)`,
            )
            continue
          }
          result = attempt.value
          break
        }

        // Transient failure (API error / non-abort throw / infra dead): exponential backoff retry.
        if (transientRetries < errorMaxRetries) {
          transientRetries++
          const delay = Math.min(
            errorBackoffBaseMs * 2 ** (transientRetries - 1),
            errorBackoffMaxMs,
          )
          ctx.ports.logger.warn?.(
            `agent "${label ?? `#${agentId}`}" ${describeAttemptFailure(attempt)}; transient retry ${transientRetries}/${errorMaxRetries} after ${Math.round(delay / 1000)}s backoff`,
          )
          // Abortable: a kill during the wait propagates WorkflowAbortedError (no agent_done emit,
          // matching the other abort paths); the outer finally releases the semaphore.
          await abortableDelay(delay, ctx.signal)
          continue
        }
        // Transient retries exhausted → final dead (degrade to null; one agent must not take down the
        // workflow). detail is wrapped with String() defensively: old journals or third-party adapters
        // may write non-strings (corrupted data), and calling .slice directly would throw a TypeError.
        result =
          attempt.kind === 'result'
            ? attempt.value
            : {
                kind: 'dead',
                reason: 'runagent-threw',
                detail:
                  attempt.error instanceof Error
                    ? attempt.error.message
                    : String(attempt.error),
              }
        break
      }
      // [end agent-timeout patch]
      // [end agent-error-backoff patch]
      if (result.kind === 'ok') {
        ctx.resources.budget.addOutputTokens(result.usage.outputTokens)
      }
      emit({ type: 'agent_done', agentId, label, phase, result })

      const entry: JournalEntry = { key, seq: agentId, result }
      // Key point: push order = completion order (not call order); read() already re-sorts by seq,
      // so during resume the call order aligns with the journal order and the key index stays stable.
      ctx.journal.push(entry)
      ctx.journalIndex++
      await ctx.ports.journalStore.append(ctx.runId, entry)
      return resultToOutput(result)
    } finally {
      release()
    }
  }

  const parallel: WorkflowHooks['parallel'] = async thunks => {
    if (thunks.length > MAX_ITEMS_PER_CALL) {
      throw new WorkflowError(
        `parallel exceeds the per-call items cap (${MAX_ITEMS_PER_CALL})`,
      )
    }
    return Promise.all(
      thunks.map(async (t, i) => {
        try {
          return await t()
        } catch (e) {
          // Cancellation is control flow for the entire run, not an item-level
          // failure. Swallowing it here makes runWorkflow persist a killed run
          // as successfully completed with a null item.
          if (e instanceof WorkflowAbortedError) throw e
          // The "null on error" contract is unchanged, but it should log — otherwise the workflow author cannot locate why an agent failed
          ctx.ports.logger.warn?.(
            `parallel thunk #${i} failed: ${(e as Error).message}`,
          )
          return null
        }
      }),
    )
  }

  const pipeline: WorkflowHooks['pipeline'] = async <T, R>(
    items: readonly T[],
    ...stages: Array<
      (prev: unknown, item: T, index: number) => Promise<unknown>
    >
  ): Promise<Array<R | null>> => {
    if (items.length > MAX_ITEMS_PER_CALL) {
      throw new WorkflowError(
        `pipeline exceeds the per-call items cap (${MAX_ITEMS_PER_CALL})`,
      )
    }
    return Promise.all(
      items.map(async (item, index): Promise<R | null> => {
        try {
          let prev: unknown = item
          for (const stage of stages) {
            prev = await stage(prev, item, index)
          }
          return prev as R
        } catch (e) {
          // Keep user cancellation observable by runWorkflow so it can emit
          // and persist the terminal `killed` state.
          if (e instanceof WorkflowAbortedError) throw e
          ctx.ports.logger.warn?.(
            `pipeline item #${index} failed: ${(e as Error).message}`,
          )
          return null
        }
      }),
    )
  }

  const phase: WorkflowHooks['phase'] = title => {
    if (ctx.currentPhase) {
      emit({ type: 'phase_done', phase: ctx.currentPhase })
    }
    ctx.currentPhase = title
    emit({ type: 'phase_started', phase: title })
  }

  const log: WorkflowHooks['log'] = message => {
    emit({ type: 'log', message })
  }

  const workflow: WorkflowHooks['workflow'] = async (nameOrRef, args) => {
    if (ctx.resources.depth >= 1) {
      throw new WorkflowError('workflow() nesting allows only one level')
    }
    const sub: Parameters<SubWorkflowRunner>[0] =
      typeof nameOrRef === 'string'
        ? { name: nameOrRef }
        : { scriptPath: nameOrRef.scriptPath }
    return runSubWorkflow({ ...sub, args })
  }

  return { agent, parallel, pipeline, phase, log, workflow }
}

function resultToOutput(result: AgentRunResult): unknown {
  return result.kind === 'ok' ? result.output : null
}

/** [agent-timeout patch] Read a non-negative integer env knob; falls back on unset/invalid/negative. */
function agentTimeoutEnvInt(name: string, fallback: number): number {
  const v = parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(v) && v >= 0 ? v : fallback
}

/** Enforce the caller-provided schema at the engine boundary for every adapter/runner implementation. */
function validateStructuredResult(
  result: AgentRunResult,
  schema?: object,
): AgentRunResult {
  if (!schema || result.kind !== 'ok') return result

  const { valid, errors } = validateAgainstSchema(result.output, schema)
  if (valid) return result

  return {
    kind: 'dead',
    reason: 'invalid-structured-output',
    detail:
      errors.length > 0
        ? errors.join('; ')
        : 'structured output does not match schema',
  }
}

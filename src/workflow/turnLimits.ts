// [workflow-turn-limit patch] Env-tunable turn cap + warning window for workflow
// sub-agents (mirrors the CCB_COMPACT_STALL_* / CCB_THINKING_STALL_* knob style).
//
//   CCB_WORKFLOW_AGENT_MAX_TURNS        per-agent tool-call round cap, default 60
//   CCB_WORKFLOW_AGENT_TURN_WARN_START  first turn that gets a remaining-rounds
//                                       reminder, default 30 (reminders fire every
//                                       turn from there up to the cap)
//
// Cap exceeded -> the agent ends GRACEFULLY via the stock max_turns_reached path
// (queryLoop yields the attachment and returns; runAgent breaks; the backend
// finalizes with whatever content exists; result is kind:'ok') — ONLY that agent
// ends, the workflow itself is NOT aborted.

function positiveEnvInt(name: string, fallback: number): number {
  const v = parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(v) && v > 0 ? v : fallback
}

/** Max agentic turns (tool-call rounds) a workflow sub-agent may take. Default 60. */
export function workflowAgentMaxTurns(): number {
  return positiveEnvInt('CCB_WORKFLOW_AGENT_MAX_TURNS', 60)
}

/** Turn number at which remaining-rounds reminders start. Default 30. */
export function workflowAgentTurnWarnStart(): number {
  return positiveEnvInt('CCB_WORKFLOW_AGENT_TURN_WARN_START', 30)
}

import type { Question } from '@claude-code-best/builtin-tools/tools/AskUserQuestionTool/AskUserQuestionTool.js'

/**
 * Idle timeout for the AskUserQuestion multiple-choice dialog.
 *
 * When the dialog sits unanswered for this long the user is assumed to be
 * away from the keyboard. The dialog is dismissed and the model receives
 * feedback telling it to proceed with the recommended/default option (or its
 * own best judgment) instead of waiting forever.
 *
 * Default: 10 minutes. Override with the env var
 * CLAUDE_CODE_ASK_USER_QUESTION_TIMEOUT_MS (milliseconds). Set it to 0 to
 * disable the timeout entirely (wait indefinitely, the old behavior).
 */
export const DEFAULT_ASK_USER_QUESTION_TIMEOUT_MS = 10 * 60 * 1000

export function getAskUserQuestionTimeoutMs(): number {
  const raw = process.env.CLAUDE_CODE_ASK_USER_QUESTION_TIMEOUT_MS
  if (raw !== undefined && raw.trim() !== '') {
    const parsed = Number(raw)
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed
    }
  }
  return DEFAULT_ASK_USER_QUESTION_TIMEOUT_MS
}

/**
 * Builds the rejection feedback delivered to the model when the question
 * dialog times out. Delivered via `toolUseConfirm.onReject(feedback)`, which
 * wraps it with REJECT_MESSAGE_WITH_REASON_PREFIX ("...the user said:") and
 * does NOT abort the turn, so the model keeps going with this instruction.
 */
export function buildAskUserQuestionTimeoutFeedback(
  questions: Question[],
  timeoutMs: number,
): string {
  const minutes = Math.max(1, Math.round(timeoutMs / 60_000))
  const pending = questions
    .map(q => {
      const options = q.options
        .map(
          opt =>
            `"${opt.label}"${opt.description ? ` (${opt.description})` : ''}`,
        )
        .join('; ')
      return `- "${q.question}"${q.multiSelect ? ' [multi-select]' : ''} — options: ${options}`
    })
    .join('\n')

  return `The user did not respond within ${minutes} minutes and may be away from the computer. No answers were provided. Do NOT wait for a response and do NOT re-ask these questions. To keep making progress, answer them yourself: for each question below, choose the option you consider recommended or default (prefer one whose label is marked "(Recommended)"); if none is clearly best, use your own judgment and pick the most reasonable option. Briefly state the choices you made and why, so the user can review them when they return.

Pending questions:
${pending}`
}

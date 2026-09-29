export function shouldShowQuerySpinner({
  toolJSXAllowsSpinner,
  hasToolUseConfirm,
  hasPrompt,
  hasActiveWork,
  pendingWorkerApproval,
  onlySleepToolActive,
}: {
  toolJSXAllowsSpinner: boolean
  hasToolUseConfirm: boolean
  hasPrompt: boolean
  hasActiveWork: boolean
  pendingWorkerApproval: boolean
  onlySleepToolActive: boolean
}): boolean {
  return (
    toolJSXAllowsSpinner &&
    !hasToolUseConfirm &&
    !hasPrompt &&
    hasActiveWork &&
    !pendingWorkerApproval &&
    !onlySleepToolActive
  )
}

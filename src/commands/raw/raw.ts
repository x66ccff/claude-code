import type { LocalCommandCall } from '../../types/command.js'

export const call: LocalCommandCall = async (_, context) => {
  context.setAppState(previous => ({
    ...previous,
    rawRequestViewEnabled: !previous.rawRequestViewEnabled,
  }))
  return { type: 'skip' }
}

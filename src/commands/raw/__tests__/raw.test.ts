import { describe, expect, test } from 'bun:test'
import rawCommand from '../index.js'

describe('/raw command', () => {
  test('is a local interactive command', () => {
    expect(rawCommand).toMatchObject({
      name: 'raw',
      type: 'local',
      supportsNonInteractive: false,
    })
  })

  test('toggles the process-local raw request view in both directions', async () => {
    let state = { rawRequestViewEnabled: false }
    const context = {
      setAppState: (updater: (previous: typeof state) => typeof state) => {
        state = updater(state)
      },
    }
    const command = await rawCommand.load()

    expect(await command.call('', context as never)).toEqual({ type: 'skip' })
    expect(state.rawRequestViewEnabled).toBe(true)

    expect(await command.call('', context as never)).toEqual({ type: 'skip' })
    expect(state.rawRequestViewEnabled).toBe(false)
  })
})

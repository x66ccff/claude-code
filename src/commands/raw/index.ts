import type { Command } from '../../commands.js'

const raw = {
  type: 'local',
  name: 'raw',
  description: 'Toggle the latest model request body view',
  supportsNonInteractive: false,
  load: () => import('./raw.js'),
} satisfies Command

export default raw

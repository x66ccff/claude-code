const MODEL_EMAIL_MAP: Array<{ keywords: string[]; email: string }> = [
  { keywords: ['claude'], email: 'noreply@anthropic.com' },
  // 使用各厂商官方 noreply 域名做占位归因（禁止使用任何个人域名），后续官方有 github 能用的邮箱可以替换
  // github 组织是不能用 co author 的
  {
    keywords: ['gpt', 'dall-e', 'o1-', 'o3-', 'o4-'],
    email: 'openai@noreply.openai.com',
  },
  { keywords: ['gemini'], email: 'google-gemini@noreply.google.com' },
  { keywords: ['grok'], email: 'xai-org@noreply.x.ai' },
  { keywords: ['glm'], email: 'zai-org@noreply.z.ai' },
  { keywords: ['deepseek'], email: 'deepseek-ai@noreply.deepseek.com' },
  { keywords: ['qwen'], email: 'QwenLM@noreply.qwen.ai' },
  { keywords: ['minimax'], email: 'MiniMax-AI@noreply.minimaxi.com' },
  { keywords: ['mimo'], email: 'XiaomiMiMo@noreply.xiaomi.com' },
  { keywords: ['kimi'], email: 'MoonshotAI@noreply.moonshot.cn' },
]

export function getAttributionEmail(modelName: string): string {
  const lower = modelName.toLowerCase()
  for (const { keywords, email } of MODEL_EMAIL_MAP) {
    if (keywords.some(kw => lower.includes(kw))) {
      return email
    }
  }
  return 'noreply@anthropic.com'
}

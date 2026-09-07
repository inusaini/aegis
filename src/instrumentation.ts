// Next.js instrumentation hook — runs once when the server boots.
// 1. Loads saved LLM gateway settings (e.g. 9router) from the DB so the
//    provider is configured before the first request.
// 2. Recovers agent runs interrupted by restarts (spec §9: persist state so
//    runs can be inspected or resumed).
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    try {
      const { db } = await import('./lib/db')
      const { setGatewayConfig } = await import('./server/llm/openai-compat')
      const saved = await db.providerConfig.findUnique({ where: { id: 'default' } })
      if (saved?.enabled && saved.baseUrl) {
        setGatewayConfig({
          baseUrl: saved.baseUrl,
          apiKey: saved.apiKey,
          providerName: saved.providerName,
          defaultModel: saved.defaultModel,
          fastModel: saved.fastModel,
          reasoningModel: saved.reasoningModel,
          codingModel: saved.codingModel,
          embeddingModel: saved.embeddingModel,
        })
      }
    } catch (err) {
      console.warn('[boot] provider config load failed:', err)
    }
    const { bootstrapRecovery } = await import('./server/api-helpers')
    await bootstrapRecovery()
  }
}

// ============================================================
// Provider factory: OpenAI-compatible gateway (9router etc.)
// first, then GLM, then heuristic fallback.
// A run starts with the best available provider and degrades
// gracefully (recorded in the run's event log) if the provider
// fails mid-run.
// ============================================================

import { GLMProvider } from './glm-provider'
import { HeuristicProvider } from './heuristic-provider'
import { OpenAICompatProvider } from './openai-compat'
import type { LLMProvider } from './types'

export * from './types'

const glm = new GLMProvider()
const heuristic = new HeuristicProvider()
const gateway = new OpenAICompatProvider()

/** Best provider available right now (cached availability check). */
let cachedChoice: { provider: LLMProvider; checkedAt: number } | null = null

export async function getProvider(forceFresh = false): Promise<LLMProvider> {
  // test/offline override
  if (process.env.AGENT_PROVIDER === 'heuristic') return heuristic
  if (!forceFresh && cachedChoice && Date.now() - cachedChoice.checkedAt < 60_000) {
    return cachedChoice.provider
  }
  // explicit OpenAI-compatible gateway (9router / OpenRouter / LiteLLM / Ollama…)
  if (gateway.configured && (await gateway.available())) {
    cachedChoice = { provider: gateway, checkedAt: Date.now() }
    return gateway
  }
  if (await glm.available()) {
    cachedChoice = { provider: glm, checkedAt: Date.now() }
    return glm
  }
  cachedChoice = { provider: heuristic, checkedAt: Date.now() }
  return heuristic
}

/** Drop the cached provider choice so the next getProvider() re-probes. */
export function resetProviderCache() {
  cachedChoice = null
  gateway.invalidateProbe()
}

/** Human-readable model label for the run record. */
export function providerModelLabel(provider: LLMProvider): string {
  const label = (provider as any).modelLabel
  if (typeof label === 'string' && label) return label
  if (provider.name === 'glm') return process.env.GLM_MODEL || 'glm-default'
  return 'deterministic'
}

export function getGLMProvider(): GLMProvider {
  return glm
}

export function getHeuristicProvider(): HeuristicProvider {
  return heuristic
}

export function getGatewayProvider(): OpenAICompatProvider {
  return gateway
}

// ============================================================
// OpenAI-compatible gateway provider — works with 9router,
// OpenRouter, LiteLLM, Ollama (/v1), vLLM, and any endpoint
// that speaks the OpenAI chat-completions protocol.
//
// Configuration — DB settings (Provider Settings UI) take priority; env vars
// serve as defaults / headless deployments:
//   LLM_BASE_URL        e.g. http://localhost:20128/v1   (enables the gateway)
//   LLM_API_KEY         gateway master key (sent as Bearer)
//   LLM_PROVIDER_NAME   display label, e.g. "9router"    (default: "gateway")
//   LLM_MODEL           default model for every role
//   LLM_FAST_MODEL      model for the 'fast' role
//   LLM_REASONING_MODEL model for the 'reasoning' role
//   LLM_CODING_MODEL    model for the 'coding' role
//   LLM_EMBEDDING_MODEL model for embeddings (else local deterministic)
//   LLM_TIMEOUT_MS      per-request timeout (default 180000)
//
// If no per-role/default model is configured, the model field is
// omitted so the gateway's default routing applies (9router model
// combos / fallback chains decide).
// ============================================================

import type { ChatOptions, ChatResult, LLMProvider } from './types'
import { LLMError } from './types'
import { embedText } from '../intelligence/semantic'

// ------------------------------------------------------------
// Runtime config: a DB-backed override (user-entered 9router
// settings) beats env vars. Loaded at boot + on save.
// ------------------------------------------------------------

export interface GatewayConfig {
  baseUrl?: string
  apiKey?: string
  providerName?: string
  defaultModel?: string
  fastModel?: string
  reasoningModel?: string
  codingModel?: string
  embeddingModel?: string
}

let runtimeConfig: GatewayConfig | null = null

/** Apply DB-backed settings (called at boot and after every save). */
export function setGatewayConfig(cfg: GatewayConfig | null) {
  runtimeConfig = cfg
}

function cfg(key: keyof GatewayConfig): string | undefined {
  const v = runtimeConfig?.[key]
  if (typeof v === 'string' && v.trim()) return v.trim()
  return undefined
}

/** Model id to send for a role, or undefined to let the gateway decide. */
function roleModel(role: string): string | undefined {
  const byRole: Record<string, string | undefined> = {
    fast: cfg('fastModel') || process.env.LLM_FAST_MODEL,
    reasoning: cfg('reasoningModel') || process.env.LLM_REASONING_MODEL,
    coding: cfg('codingModel') || process.env.LLM_CODING_MODEL,
    embedding: cfg('embeddingModel') || process.env.LLM_EMBEDDING_MODEL,
  }
  return byRole[role] || cfg('defaultModel') || process.env.LLM_MODEL || undefined
}

export class OpenAICompatProvider implements LLMProvider {
  get name(): string {
    return cfg('providerName') || (process.env.LLM_PROVIDER_NAME || 'gateway').trim()
  }
  readonly capabilities = { freeformChat: true }
  /** model label shown in the run view / run record */
  get modelLabel(): string {
    return roleModel('fast') || `${this.name}:default`
  }
  /** total usage across the process, for observability (same shape as GLM) */
  usage = { requests: 0, promptTokens: 0, completionTokens: 0 }

  private timeoutMs = parseInt(process.env.LLM_TIMEOUT_MS || '180000', 10)
  private probeCache: { ok: boolean; checkedAt: number } | null = null

  private get baseUrl(): string {
    return (cfg('baseUrl') || process.env.LLM_BASE_URL || '').trim().replace(/\/+$/, '')
  }

  private get apiKey(): string {
    return (cfg('apiKey') || process.env.LLM_API_KEY || '').trim()
  }

  /** True when the gateway is configured (DB settings or env). */
  get configured(): boolean {
    return this.baseUrl.length > 0
  }

  /** Invalidate the availability cache (after settings change). */
  invalidateProbe() {
    this.probeCache = null
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
    }
  }

  private async checkBaseUrl(): Promise<void> {
    if (!this.configured) throw new LLMError('gateway not configured (no base URL)')
  }

  async available(): Promise<boolean> {
    await this.checkBaseUrl()
    if (this.probeCache && Date.now() - this.probeCache.checkedAt < 60_000) {
      return this.probeCache.ok
    }
    let ok = false
    try {
      const res = await fetch(this.url('/models'), {
        headers: this.headers(),
        signal: AbortSignal.timeout(4000),
      })
      ok = res.ok
    } catch {
      ok = false
    }
    this.probeCache = { ok, checkedAt: Date.now() }
    return ok
  }

  async chat(opts: ChatOptions): Promise<ChatResult> {
    await this.checkBaseUrl()
    const role = opts.role || 'fast'
    const model = roleModel(role)
    const messages = [
      ...(opts.system ? [{ role: 'system' as const, content: opts.system }] : []),
      ...opts.messages,
    ]

    let lastError: unknown = null
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(this.url('/chat/completions'), {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify({
            ...(model ? { model } : {}),
            messages,
            temperature: opts.temperature ?? 0.3,
            ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
            ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
          }),
          signal: AbortSignal.timeout(this.timeoutMs),
        })
        if (!res.ok) {
          const body = await res.text().catch(() => '')
          throw new LLMError(`gateway returned ${res.status}: ${body.slice(0, 300)}`)
        }
        const data: any = await res.json()
        const content: string = data?.choices?.[0]?.message?.content ?? ''
        if (!content) throw new LLMError('empty completion from gateway')
        this.usage.requests++
        const usage = data?.usage
        if (usage) {
          this.usage.promptTokens += Number(usage.prompt_tokens || 0)
          this.usage.completionTokens += Number(usage.completion_tokens || 0)
        }
        return {
          content,
          model: data?.model || model || `${this.name}-default`,
          usage: {
            promptTokens: Number(usage?.prompt_tokens || 0) || undefined,
            completionTokens: Number(usage?.completion_tokens || 0) || undefined,
          },
        }
      } catch (err) {
        lastError = err
        if (attempt < 2) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)))
      }
    }
    throw new LLMError(`${this.name} chat failed after retries: ${(lastError as Error)?.message}`, lastError)
  }

  async embed(texts: string[]): Promise<number[][]> {
    const model = roleModel('embedding')
    // Without an explicit embedding model, keep the local deterministic
    // embedder: vectors stored at index time and query time stay consistent.
    if (!model) return texts.map((t) => embedText(t))
    try {
      const res = await fetch(this.url('/embeddings'), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ model, input: texts }),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      if (!res.ok) throw new LLMError(`gateway embeddings returned ${res.status}`)
      const data: any = await res.json()
      const rows = (data?.data || []) as { embedding: number[]; index: number }[]
      if (rows.length !== texts.length) throw new LLMError('embedding count mismatch')
      return rows.sort((a, b) => a.index - b.index).map((r) => r.embedding)
    } catch (err) {
      // graceful degradation: local vectors so retrieval keeps working
      console.warn(`[llm] gateway embeddings failed, using local embedder: ${(err as Error).message}`)
      return texts.map((t) => embedText(t))
    }
  }
}

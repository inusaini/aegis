// ============================================================
// GLM provider — wraps z-ai-web-dev-sdk behind the LLMProvider
// interface. Config (models, temperature, retries) comes from env
// so providers can be swapped without code changes.
// The SDK has no embeddings endpoint, so embed() delegates to the
// local deterministic embedder.
// ============================================================

import ZAI from 'z-ai-web-dev-sdk'
import type { ChatOptions, ChatResult, LLMProvider } from './types'
import { LLMError } from './types'
import { embedText } from '../intelligence/semantic'

const ROLE_CONFIG: Record<string, { thinking: 'enabled' | 'disabled'; temperature: number; model?: string }> = {
  fast: { thinking: 'disabled', temperature: 0.3 },
  reasoning: { thinking: 'enabled', temperature: 0.2 },
  coding: { thinking: 'disabled', temperature: 0.1 },
  embedding: { thinking: 'disabled', temperature: 0 },
}

export class GLMProvider implements LLMProvider {
  readonly name = 'glm'
  readonly capabilities = { freeformChat: true }
  private zai: Awaited<ReturnType<typeof ZAI.create>> | null = null
  private initPromise: Promise<Awaited<ReturnType<typeof ZAI.create>>> | null = null
  /** total usage across the process, for observability */
  usage = { requests: 0, promptTokens: 0, completionTokens: 0 }

  private async client() {
    if (this.zai) return this.zai
    if (!this.initPromise) {
      this.initPromise = ZAI.create().then((z) => {
        this.zai = z
        return z
      })
    }
    return this.initPromise
  }

  async available(): Promise<boolean> {
    try {
      await this.client()
      return true
    } catch {
      return false
    }
  }

  async chat(opts: ChatOptions): Promise<ChatResult> {
    const role = opts.role || 'fast'
    const conf = ROLE_CONFIG[role] || ROLE_CONFIG.fast
    const model = process.env.GLM_MODEL || conf.model
    const messages = [
      ...(opts.system ? [{ role: 'system' as const, content: opts.system }] : []),
      ...opts.messages,
    ]

    let lastError: unknown = null
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const zai = await this.client()
        const completion = await zai.chat.completions.create({
          ...(model ? { model } : {}),
          messages,
          thinking: { type: conf.thinking },
          temperature: opts.temperature ?? conf.temperature,
          ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
          ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
        })
        const content: string = completion?.choices?.[0]?.message?.content ?? ''
        if (!content) throw new LLMError('empty completion')
        this.usage.requests++
        const usage = completion?.usage
        if (usage) {
          this.usage.promptTokens += Number(usage.prompt_tokens || 0)
          this.usage.completionTokens += Number(usage.completion_tokens || 0)
        }
        return {
          content,
          model: completion?.model || model || 'glm-default',
          usage: {
            promptTokens: Number(usage?.prompt_tokens || 0) || undefined,
            completionTokens: Number(usage?.completion_tokens || 0) || undefined,
          },
        }
      } catch (err) {
        lastError = err
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)))
      }
    }
    throw new LLMError(`GLM chat failed after retries: ${(lastError as Error)?.message}`, lastError)
  }

  async embed(texts: string[]): Promise<number[][]> {
    // SDK lacks an embeddings endpoint — deterministic local vectors
    return texts.map((t) => embedText(t))
  }
}

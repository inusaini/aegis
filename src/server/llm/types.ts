// ============================================================
// LLM abstraction (spec §19): providers expose model roles
// (fast / reasoning / coding / embedding). The rest of the
// system NEVER talks to a vendor SDK directly.
// ============================================================

export type ModelRole = 'fast' | 'reasoning' | 'coding' | 'embedding'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatOptions {
  role?: ModelRole
  system?: string
  messages: ChatMessage[]
  temperature?: number
  maxTokens?: number
  /** ask the provider to return parseable JSON */
  json?: boolean
}

export interface ChatResult {
  content: string
  model: string
  usage?: { promptTokens?: number; completionTokens?: number }
}

export interface LLMProvider {
  readonly name: string
  /** freeformChat=false signals callers to use their deterministic strategy */
  readonly capabilities: { freeformChat: boolean }
  /** can this provider actually serve chat requests right now? */
  available(): Promise<boolean>
  chat(opts: ChatOptions): Promise<ChatResult>
  embed(texts: string[]): Promise<number[][]>
}

export class LLMError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message)
  }
}

/** Extract the first JSON object/array from a model response. */
export function extractJson<T = unknown>(content: string): T | null {
  // strip markdown fences
  const cleaned = content
    .replace(/```(?:json)?/g, '```')
    .split('```')
    .map((s) => s.trim())
    .filter(Boolean)
  const candidates: string[] = [...cleaned, content]
  for (const c of candidates) {
    const start = Math.min(
      ...[c.indexOf('{'), c.indexOf('[')].filter((i) => i >= 0).concat([Infinity])
    )
    if (!isFinite(start)) continue
    const endBrace = c.lastIndexOf('}')
    const endBracket = c.lastIndexOf(']')
    const end = Math.max(endBrace, endBracket)
    if (end <= start) continue
    try {
      return JSON.parse(c.slice(start, end + 1)) as T
    } catch { /* try next candidate */ }
  }
  return null
}

// ============================================================
// Heuristic provider: deterministic offline fallback.
// freeformChat = false — the planner/coder engines detect this
// and use their deterministic template strategies instead of
// prompting. Embeddings use the local vectorizer, so semantic
// retrieval keeps working fully offline.
// ============================================================

import type { ChatOptions, ChatResult, LLMProvider } from './types'
import { LLMError } from './types'
import { embedText } from '../intelligence/semantic'

export class HeuristicProvider implements LLMProvider {
  readonly name = 'heuristic'
  readonly capabilities = { freeformChat: false }

  async available(): Promise<boolean> {
    return true
  }

  async chat(_opts: ChatOptions): Promise<ChatResult> {
    throw new LLMError('heuristic provider does not serve free-form chat; use deterministic strategies')
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => embedText(t))
  }
}

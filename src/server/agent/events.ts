// ============================================================
// Event emission (spec §24): every agent run produces a
// structured event log with timestamps, tool calls, and
// concise action summaries — never private chain-of-thought.
// ============================================================

import { db } from '@/lib/db'

export type EventPhase =
  | 'repository' | 'investigation' | 'impact' | 'plan' | 'approval'
  | 'implementation' | 'verification' | 'fix' | 'review' | 'system'

export type EventType = 'status' | 'info' | 'tool' | 'warning' | 'error' | 'success' | 'approval'

export interface EmitOptions {
  data?: Record<string, unknown>
}

export class RunEventLog {
  constructor(private runId: string) {}

  private seqCache: number | null = null

  private async nextSeq(): Promise<number> {
    if (this.seqCache != null) return ++this.seqCache
    const last = await db.agentEvent.findFirst({
      where: { runId: this.runId },
      orderBy: { seq: 'desc' },
      select: { seq: true },
    })
    this.seqCache = last?.seq ?? 0
    return ++this.seqCache
  }

  async emit(phase: EventPhase, type: EventType, title: string, detail = '', opts: EmitOptions = {}): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const seq = await this.nextSeq()
      try {
        await db.agentEvent.create({
          data: {
            runId: this.runId,
            seq,
            phase,
            type,
            title: title.slice(0, 300),
            detail: detail.slice(0, 4000),
            data: JSON.stringify(opts.data || {}),
          },
        })
        return
      } catch (err: any) {
        if (err?.code === 'P2002') {
          // seq collision (another event-log instance advanced the counter) — re-read and retry
          this.seqCache = null
          continue
        }
        throw err
      }
    }
  }

  tool(phase: EventPhase, tool: string, args: Record<string, unknown>, resultSummary: string, ok = true) {
    return this.emit(phase, 'tool', `${ok ? '✓' : '✗'} ${tool}`, resultSummary, {
      data: { tool, args, ok },
    })
  }

  status(phase: EventPhase, title: string, detail = '') {
    return this.emit(phase, 'status', title, detail)
  }

  success(phase: EventPhase, title: string, detail = '') {
    return this.emit(phase, 'success', title, detail)
  }

  warn(phase: EventPhase, title: string, detail = '') {
    return this.emit(phase, 'warning', title, detail)
  }

  error(phase: EventPhase, title: string, detail = '') {
    return this.emit(phase, 'error', title, detail)
  }
}

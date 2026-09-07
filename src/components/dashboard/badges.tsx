'use client'

import { Badge } from '@/components/ui/badge'
import type { AgentState } from '@/lib/types'

const STATE_STYLES: Record<string, string> = {
  CREATED: 'bg-zinc-500/15 text-zinc-600 dark:text-zinc-300 border-zinc-500/30',
  DISCOVERING: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30',
  UNDERSTANDING: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30',
  IMPACT_ANALYSIS: 'bg-orange-500/15 text-orange-700 dark:text-orange-300 border-orange-500/30',
  PLANNING: 'bg-orange-500/15 text-orange-700 dark:text-orange-300 border-orange-500/30',
  WAITING_FOR_APPROVAL: 'bg-yellow-500/20 text-yellow-800 dark:text-yellow-300 border-yellow-500/40',
  IMPLEMENTING: 'bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-500/30',
  VERIFYING: 'bg-teal-500/15 text-teal-700 dark:text-teal-300 border-teal-500/30',
  FIXING: 'bg-teal-500/15 text-teal-700 dark:text-teal-300 border-teal-500/30',
  FINAL_REVIEW: 'bg-cyan-500/15 text-cyan-700 dark:text-cyan-300 border-cyan-500/30',
  COMPLETED: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30',
  FAILED: 'bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30',
  CANCELLED: 'bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30',
  BLOCKED: 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20',
}

export function StateBadge({ state, pulse }: { state: AgentState | string; pulse?: boolean }) {
  const cls = STATE_STYLES[state] || STATE_STYLES.CREATED
  return (
    <Badge variant="outline" className={`${cls} font-mono text-[11px] tracking-wide ${pulse ? 'animate-pulse' : ''}`}>
      {state.replaceAll('_', ' ')}
    </Badge>
  )
}

export function RiskBadge({ risk }: { risk: string }) {
  const map: Record<string, string> = {
    LOW: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30',
    MEDIUM: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30',
    HIGH: 'bg-orange-500/15 text-orange-700 dark:text-orange-300 border-orange-500/30',
    CRITICAL: 'bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30',
  }
  return (
    <Badge variant="outline" className={`${map[risk] || map.LOW} font-semibold`}>
      {risk} risk
    </Badge>
  )
}

export function TypeBadge({ type }: { type: string }) {
  const map: Record<string, string> = {
    status: 'bg-zinc-500/10 text-zinc-600 dark:text-zinc-400',
    info: 'bg-zinc-500/10 text-zinc-600 dark:text-zinc-400',
    tool: 'bg-teal-500/10 text-teal-700 dark:text-teal-300',
    success: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
    warning: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
    error: 'bg-red-500/10 text-red-700 dark:text-red-300',
    approval: 'bg-yellow-500/20 text-yellow-800 dark:text-yellow-300',
  }
  return <Badge variant="secondary" className={`${map[type] || map.info} text-[10px] px-1.5`}>{type}</Badge>
}

export function MemoryKindBadge({ kind }: { kind: string }) {
  const map: Record<string, string> = {
    verified_fact: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30',
    inferred: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30',
    user_rule: 'bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-500/30',
    assumption: 'bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30',
  }
  const label: Record<string, string> = {
    verified_fact: 'verified fact',
    inferred: 'inferred',
    user_rule: 'user rule',
    assumption: 'assumption',
  }
  return (
    <Badge variant="outline" className={`${map[kind] || map.assumption} text-[10px]`}>
      {label[kind] || kind}
    </Badge>
  )
}

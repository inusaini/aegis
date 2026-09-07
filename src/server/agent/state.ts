// ============================================================
// Agent state machine + state object (spec §9, §10).
// State is persisted in the DB so any run can be inspected or
// resumed after a server restart.
// ============================================================

import type { AgentState } from '@/lib/types'

export const STATE_ORDER: AgentState[] = [
  'CREATED',
  'DISCOVERING',
  'UNDERSTANDING',
  'IMPACT_ANALYSIS',
  'PLANNING',
  'WAITING_FOR_APPROVAL',
  'IMPLEMENTING',
  'VERIFYING',
  'FIXING',
  'FINAL_REVIEW',
  'COMPLETED',
]

export const TERMINAL_STATES: AgentState[] = ['COMPLETED', 'FAILED', 'CANCELLED', 'BLOCKED']

export function isTerminal(state: string): boolean {
  return TERMINAL_STATES.includes(state as AgentState)
}

export function isApprovalGate(state: string): boolean {
  return state === 'WAITING_FOR_APPROVAL'
}

// ---- Agent state object (spec §10) -----------------------------------

export interface RepositoryUnderstanding {
  overview: {
    languages: string[]
    frameworks: string[]
    testFrameworks: string[]
    database: string
    entryPoints: string[]
    services: string[]
  }
  architectureSummary: string
  conventions: string[]
  quirks: string[]
}

export interface HistoricalContextEntry {
  file: string
  commitHash: string
  subject: string
  relevance: string
}

export interface AgentStateObject {
  task: string
  repository: {
    id: string
    source: string
    branch: string
    defaultBranch: string
    path: string
  }
  branch: string
  repository_understanding: RepositoryUnderstanding
  relevant_components: {
    files: { path: string; score: number; reason: string }[]
    symbols: { qualifiedName: string; kind: string }[]
    retrieval: { semantic: number; keyword: number; symbol: number; graph: number; git: number; tests: number }
  }
  dependencies: { local: string[]; external: string[] }
  historical_context: HistoricalContextEntry[]
  impact_analysis: {
    riskLevel: string
    rationale: string
    blastRadius: { direct: number; indirect: number }
    compatibilityConcerns: string[]
  }
  plan: {
    objective: string
    files_to_modify: string[]
    files_to_create: string[]
    tests: string[]
    generated_by: 'llm' | 'heuristic'
  } | null
  approval_status: 'pending' | 'approved' | 'rejected' | 'not_required'
  changes: { file: string; changeType: string; additions: number; deletions: number }[]
  tests: { kind: string; command: string; status: string; fixAttempt: number }[]
  failures: { kind: string; summary: string; classification: string; fixed: boolean }[]
  risks: string[]
  assumptions: string[]
  final_result: {
    summary?: string
    verified?: { label: string; passed: boolean; detail: string }[]
    nextSteps?: string[]
    branch?: string
    commit?: string
  } | null
}

export function initialStateObject(task: string, repo: { id: string; source: string; branch: string; defaultBranch: string; path: string }): AgentStateObject {
  return {
    task,
    repository: repo,
    branch: '',
    repository_understanding: {
      overview: { languages: [], frameworks: [], testFrameworks: [], database: '', entryPoints: [], services: [] },
      architectureSummary: '',
      conventions: [],
      quirks: [],
    },
    relevant_components: { files: [], symbols: [], retrieval: { semantic: 0, keyword: 0, symbol: 0, graph: 0, git: 0, tests: 0 } },
    dependencies: { local: [], external: [] },
    historical_context: [],
    impact_analysis: {
      riskLevel: '',
      rationale: '',
      blastRadius: { direct: 0, indirect: 0 },
      compatibilityConcerns: [],
    },
    plan: null,
    approval_status: 'pending',
    changes: [],
    tests: [],
    failures: [],
    risks: [],
    assumptions: [],
    final_result: null,
  }
}

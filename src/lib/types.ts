// ============================================================
// Shared client/server API types for AEGIS
// ============================================================

export type AgentState =
  | 'CREATED'
  | 'DISCOVERING'
  | 'UNDERSTANDING'
  | 'IMPACT_ANALYSIS'
  | 'PLANNING'
  | 'WAITING_FOR_APPROVAL'
  | 'IMPLEMENTING'
  | 'VERIFYING'
  | 'FIXING'
  | 'FINAL_REVIEW'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'BLOCKED'

export const ACTIVE_STATES: AgentState[] = [
  'CREATED', 'DISCOVERING', 'UNDERSTANDING', 'IMPACT_ANALYSIS',
  'PLANNING', 'IMPLEMENTING', 'VERIFYING', 'FIXING', 'FINAL_REVIEW',
]

export interface ProjectSummary {
  id: string
  name: string
  description: string
  createdAt: string
  repository: {
    id: string
    source: string
    sourceType: string
    branch: string
    analysisStatus: string
    lastIndexedAt: string | null
    fileCount: number
    defaultBranch: string
  } | null
  recentTasks: {
    id: string
    title: string
    status: string
    createdAt: string
    latestRun: { id: string; state: string; startedAt: string; finishedAt: string | null } | null
  }[]
}

export interface RepoOverview {
  languages: { name: string; files: number; loc: number; share: number }[]
  frameworks: string[]
  testFrameworks: string[]
  database: { detected: string; details: string[]; tables: string[]; accessLayers: string[] }
  dependencies: { name: string; version: string; type: string }[]
  importantDirectories: { path: string; purpose: string }[]
  services: string[]
  entryPoints: string[]
  architectureSummary: string
  stats: { files: number; symbols: number; relationships: number; documents: number; commits: number }
}

export interface SystemMapGraph {
  nodes: {
    id: string
    label: string
    layer: 'entry' | 'api' | 'service' | 'data' | 'external' | 'config'
    meta?: { files: number; symbols: number; kind?: string }
  }[]
  edges: { source: string; target: string; kind: string; count: number }[]
  layers: { id: string; label: string }[]
}

export interface RunEvent {
  id: string
  seq: number
  phase: string
  type: string
  title: string
  detail: string
  data: Record<string, unknown>
  createdAt: string
}

export interface PlanView {
  id: string
  status: 'proposed' | 'approved' | 'rejected'
  objective: string
  assumptions: string[]
  filesToModify: string[]
  filesToCreate: string[]
  filesToDelete: string[]
  databaseChanges: string[]
  apiChanges: string[]
  dependencies: string[]
  testsRequired: string[]
  risks: string[]
  rollbackStrategy: string
  narrative?: string
  steps?: { title: string; detail: string }[]
  approvedAt?: string | null
  rejectionReason?: string
}

export interface ImpactView {
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
  filesAffected: { path: string; reason: string }[]
  servicesAffected: string[]
  apisAffected: string[]
  databaseChanges: string[]
  testsAffected: { path: string; reason: string }[]
  compatibilityConcerns: string[]
  evidence: { source: string; detail: string }[]
  blastRadius: { direct: number; indirect: number }
}

export interface ChangeView {
  file: string
  changeType: 'modified' | 'created' | 'deleted'
  additions: number
  deletions: number
  diff: string
}

export interface TestRunView {
  id: string
  kind: string
  command: string
  status: string
  summary: string
  durationMs: number
  fixAttempt: number
  classification: string
  output: string
}

export interface RunView {
  id: string
  taskId: string
  state: AgentState
  branch: string
  provider: string
  model: string
  startedAt: string
  finishedAt: string | null
  error: string
  task: { id: string; title: string; description: string; status: string }
  plan: PlanView | null
  impact: ImpactView | null
  changes: ChangeView[]
  testRuns: TestRunView[]
  finalResult: {
    summary?: string
    verified?: { label: string; passed: boolean; detail: string }[]
    nextSteps?: string[]
  } | null
  tokenUsage: number
}

export interface MemoryView {
  id: string
  kind: 'verified_fact' | 'inferred' | 'user_rule' | 'assumption'
  category: string
  content: string
  source: string
  confidence: number
  createdAt: string
}

export interface AgentActivityPoint {
  seq: number
  phase: string
  type: string
  title: string
  detail: string
  createdAt: string
}

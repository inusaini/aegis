'use client'

// Client-side API layer for the AEGIS dashboard.
//
// Auth strategy: session cookie first (works when the app is a top-level
// site). If the app is embedded in a cross-site iframe, browsers may block
// the third-party cookie — so we also keep the signed session token returned
// by /api/auth/login in localStorage and send it as an Authorization: Bearer
// header on every request. The server accepts either credential.

import type { ProjectSummary, RepoOverview, SystemMapGraph, RunView, RunEvent, MemoryView } from '@/lib/types'

const TOKEN_KEY = 'bfa_token'

export function saveToken(token: string) {
  try { localStorage.setItem(TOKEN_KEY, token) } catch { /* storage unavailable */ }
}
export function clearToken() {
  try { localStorage.removeItem(TOKEN_KEY) } catch { /* storage unavailable */ }
}

/** Headers that authenticate the request when the session cookie is blocked. */
function authHeaders(): Record<string, string> {
  if (typeof window === 'undefined') return {}
  try {
    const token = localStorage.getItem(TOKEN_KEY)
    return token ? { Authorization: `Bearer ${token}` } : {}
  } catch { return {} }
}

/** fetch wrapper that always attaches the bearer token if present. */
function f(url: string, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> || {}), ...authHeaders() }
  return fetch(url, { ...init, headers })
}

async function j<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((body as any).error || `request failed (${res.status})`)
  return body as T
}

type AuthBody = { user: { id: string; email: string; name: string }; token?: string }

/** Persist the bearer token returned by login/register. */
function keepToken(body: AuthBody): AuthBody {
  if (body?.token) saveToken(body.token)
  return body
}

export const api = {
  // ---- auth ----
  me: () => f('/api/auth/me').then((r) => j<{ user: { id: string; email: string; name: string } | null }>(r)),
  login: (email: string, password: string) =>
    f('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) })
      .then((r) => j<AuthBody>(r))
      .then(keepToken),
  register: (email: string, name: string, password: string) =>
    f('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, name, password }) })
      .then((r) => j<AuthBody>(r))
      .then(keepToken),
  logout: () => f('/api/auth/logout', { method: 'POST' }).then((r) => j<{ ok: boolean }>(r)),

  // ---- projects ----
  projects: () => f('/api/projects').then((r) => j<{ projects: ProjectSummary[] }>(r)),
  createProject: (name: string, description: string) =>
    f('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, description }) })
      .then((r) => j<{ project: { id: string } }>(r)),
  project: (id: string) => f(`/api/projects/${id}`).then((r) => j<{ project: any }>(r)),
  deleteProject: (id: string) => f(`/api/projects/${id}`, { method: 'DELETE' }).then((r) => j<{ ok: boolean }>(r)),

  // ---- repositories ----
  connectRepo: (projectId: string, source: string, sourceType: 'remote' | 'local' | 'sample') =>
    f(`/api/projects/${projectId}/repos`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source, sourceType }) })
      .then((r) => j<{ repository: { id: string } }>(r)),
  analyzeRepo: (repoId: string) => f(`/api/repos/${repoId}/analyze`, { method: 'POST' }).then((r) => j<{ ok: boolean }>(r)),
  overview: (repoId: string) =>
    f(`/api/repos/${repoId}/overview`).then((r) => j<{ overview: RepoOverview | null; status: string; progress?: number; progressStep?: string; error?: string; repository?: any }>(r)),
  systemMap: (repoId: string) => f(`/api/repos/${repoId}/system-map`).then((r) => j<SystemMapGraph & { layers: any[] }>(r)),
  searchRepo: (repoId: string, q: string) =>
    f(`/api/repos/${repoId}/search?q=${encodeURIComponent(q)}`).then((r) => j<{ results: { type: string; label: string; path: string; line: number; signature: string }[] }>(r)),

  // ---- tasks & runs ----
  createTask: (projectId: string, description: string) =>
    f(`/api/projects/${projectId}/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ description }) })
      .then((r) => j<{ task: { id: string }; runId: string }>(r)),
  run: (runId: string) => f(`/api/runs/${runId}`).then((r) => j<{ run: RunView; stateData: any }>(r)),
  runEvents: (runId: string, after: number) =>
    f(`/api/runs/${runId}/events?after=${after}`).then((r) => j<{ state: string; events: RunEvent[] }>(r)),
  approve: (runId: string, decision: 'approve' | 'reject', reason?: string) =>
    f(`/api/runs/${runId}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision, reason }) })
      .then((r) => j<{ ok: boolean }>(r)),
  cancelRun: (runId: string) => f(`/api/runs/${runId}/cancel`, { method: 'POST' }).then((r) => j<{ ok: boolean }>(r)),
  commitRun: (runId: string, message?: string) =>
    f(`/api/runs/${runId}/commit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message }) })
      .then((r) => j<{ committed: boolean; hash: string; branch: string }>(r)),

  // ---- memory ----
  memories: (projectId: string) => f(`/api/projects/${projectId}/memories`).then((r) => j<{ memories: MemoryView[] }>(r)),
  addMemory: (projectId: string, content: string, category?: string) =>
    f(`/api/projects/${projectId}/memories`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content, category }) })
      .then((r) => j<{ memory: MemoryView }>(r)),

  // ---- provider settings (LLM gateway, e.g. 9router) ----
  providerSettings: () =>
    f('/api/settings/provider').then((r) => j<{ config: ProviderSettingsView | null; env: { baseUrl: string; providerName: string }; status: ProviderStatusView }>(r)),
  saveProviderSettings: (settings: Partial<ProviderSettingsInput> & { testOnly?: boolean }) =>
    f('/api/settings/provider', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) })
      .then((r) => j<{ saved: boolean; test: { ok: boolean; error: string; status: number; modelCount: number }; applied?: boolean }>(r)),
}

export interface ProviderSettingsView {
  enabled: boolean
  baseUrl: string
  apiKeyMasked: string
  hasApiKey: boolean
  providerName: string
  defaultModel: string
  fastModel: string
  reasoningModel: string
  codingModel: string
  embeddingModel: string
}

export interface ProviderSettingsInput {
  enabled: boolean
  baseUrl: string
  apiKey?: string
  providerName: string
  defaultModel: string
  fastModel: string
  reasoningModel: string
  codingModel: string
  embeddingModel: string
}

export interface ProviderStatusView {
  configured: boolean
  available: boolean
  lastCheckedAt: string | null
  lastCheckOk: boolean
  lastCheckError: string
}

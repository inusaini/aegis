'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTheme } from 'next-themes'
import { Button } from '@/components/ui/button'
import { Moon, Sun, Terminal, LogOut, Plug } from 'lucide-react'
import { api, clearToken } from './api'
import { LoginView } from './login-view'
import { ProjectsView } from './projects-view'
import { ProjectView } from './project-view'
import { RunView } from './run-view'
import { ProviderSettingsDialog } from './provider-settings-dialog'
import type { ProjectSummary } from '@/lib/types'

type View = { kind: 'projects' } | { kind: 'project'; id: string } | { kind: 'run'; id: string; projectId?: string }

export function AppShell() {
  const [user, setUser] = useState<{ id: string; email: string; name: string } | null | undefined>(undefined)
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [view, setView] = useState<View>({ kind: 'projects' })
  const [providerOpen, setProviderOpen] = useState(false)
  const { theme, setTheme } = useTheme()

  useEffect(() => {
    api.me().then((r) => setUser(r.user)).catch(() => setUser(null))
  }, [])

  const loadProjects = useCallback(async () => {
    try {
      const { projects } = await api.projects()
      setProjects(projects)
    } catch { /* unauth */ }
  }, [])

  useEffect(() => {
    let cancelled = false
    if (user) {
      api.projects()
        .then((r) => { if (!cancelled) setProjects(r.projects) })
        .catch(() => { /* unauth */ })
    }
    return () => { cancelled = true }
  }, [user])

  if (user === undefined) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-50 dark:bg-background">
        <div className="h-8 w-8 rounded-lg bg-zinc-900 dark:bg-zinc-100 animate-pulse" />
      </div>
    )
  }

  if (!user) {
    return <LoginView onAuthed={() => { setUser(null); api.me().then((r) => setUser(r.user)) }} />
  }

  return (
    <div className="min-h-screen flex flex-col bg-zinc-50 dark:bg-background">
      {/* header */}
      <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 h-14 flex items-center gap-3">
          <button className="flex items-center gap-2.5" onClick={() => setView({ kind: 'projects' })}>
            <div className="h-7 w-7 rounded-md bg-zinc-900 dark:bg-zinc-100 flex items-center justify-center">
              <Terminal className="h-4 w-4 text-white dark:text-zinc-900" />
            </div>
            <span className="font-semibold tracking-tight hidden sm:block">AEGIS</span>
          </button>
          <span className="text-xs text-muted-foreground hidden md:block ml-2 border-l pl-3">
            Understand first. Change second.
          </span>
          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0"
              onClick={() => setProviderOpen(true)}
              aria-label="LLM provider settings"
              title="Connect your LLM gateway (9router, OpenRouter, …)"
            >
              <Plug className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              aria-label="Toggle theme"
            >
              <Sun className="h-4 w-4 dark:hidden" />
              <Moon className="h-4 w-4 hidden dark:block" />
            </Button>
            <span className="text-xs text-muted-foreground hidden sm:block">{user.email}</span>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 gap-1.5"
              onClick={async () => {
                await api.logout().catch(() => {})
                clearToken()
                setUser(null)
                setView({ kind: 'projects' })
              }}
            >
              <LogOut className="h-3.5 w-3.5" />
              <span className="hidden sm:block">Sign out</span>
            </Button>
          </div>
        </div>
      </header>

      {/* body */}
      <main className="flex-1 mx-auto w-full max-w-7xl px-4 sm:px-6 py-6">
        {view.kind === 'projects' && (
          <ProjectsView
            projects={projects}
            onOpen={(id) => setView({ kind: 'project', id })}
            onCreated={(id) => {
              loadProjects()
              setView({ kind: 'project', id })
            }}
          />
        )}
        {view.kind === 'project' && (
          <ProjectView
            projectId={view.id}
            onBack={() => { loadProjects(); setView({ kind: 'projects' }) }}
            onOpenRun={(runId) => setView({ kind: 'run', id: runId, projectId: view.id })}
          />
        )}
        {view.kind === 'run' && (
          <RunView runId={view.id} onBack={() => view.projectId ? setView({ kind: 'project', id: view.projectId! }) : setView({ kind: 'projects' })} />
        )}
      </main>

      <footer className="border-t py-4">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 text-xs text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
          <span>AEGIS — Brownfield Engineering Agent MVP</span>
          <span className="ml-auto">Tree-sitter indexing · hybrid retrieval · sandboxed execution · approval gates</span>
        </div>
      </footer>

      <ProviderSettingsDialog open={providerOpen} onOpenChange={setProviderOpen} />
    </div>
  )
}

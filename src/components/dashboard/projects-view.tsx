'use client'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { GitBranch, FileCode2, Clock, Plus, ChevronRight, Boxes } from 'lucide-react'
import type { ProjectSummary } from '@/lib/types'
import { StateBadge } from './badges'
import { NewProjectDialog } from './new-project-dialog'

export function ProjectsView({ projects, onOpen, onCreated }: {
  projects: ProjectSummary[]
  onOpen: (id: string) => void
  onCreated: (id: string) => void
}) {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Projects</h1>
          <p className="text-sm text-muted-foreground">Existing codebases under agent supervision.</p>
        </div>
        <NewProjectDialog onCreated={onCreated} />
      </div>

      {projects.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <Boxes className="h-10 w-10 text-muted-foreground mb-3" />
            <p className="font-medium">No projects yet</p>
            <p className="text-sm text-muted-foreground mt-1 max-w-sm">
              Create a project and connect a repository. The built-in sample repo (legacy-shop) is a realistic
              brownfield codebase for trying the agent.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {projects.map((p) => (
            <Card key={p.id} className="group cursor-pointer transition-shadow hover:shadow-md" onClick={() => onOpen(p.id)}>
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="text-lg leading-tight group-hover:underline">{p.name}</CardTitle>
                  {p.repository?.analysisStatus === 'ready' ? (
                    <Badge variant="secondary" className="bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">indexed</Badge>
                  ) : p.repository?.analysisStatus === 'indexing' || p.repository?.analysisStatus === 'analyzing' ? (
                    <Badge variant="secondary" className="bg-amber-500/10 text-amber-700 dark:text-amber-300 animate-pulse">analyzing…</Badge>
                  ) : p.repository?.analysisStatus === 'failed' ? (
                    <Badge variant="secondary" className="bg-red-500/10 text-red-700 dark:text-red-300">analysis failed</Badge>
                  ) : (
                    <Badge variant="secondary">not analyzed</Badge>
                  )}
                </div>
                <CardDescription className="line-clamp-2">{p.description || 'No description'}</CardDescription>
              </CardHeader>
              <CardContent className="text-sm space-y-2">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-muted-foreground">
                  {p.repository ? (
                    <>
                      <span className="inline-flex items-center gap-1"><GitBranch className="h-3.5 w-3.5" />{p.repository.branch || p.repository.defaultBranch}</span>
                      <span className="inline-flex items-center gap-1"><FileCode2 className="h-3.5 w-3.5" />{p.repository.fileCount || 0} files</span>
                      <span className="inline-flex items-center gap-1 font-mono text-xs">{p.repository.sourceType}</span>
                    </>
                  ) : (
                    <span className="text-red-600 dark:text-red-400 text-xs">no repository connected</span>
                  )}
                </div>
                <div className="pt-1">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Recent tasks</p>
                  {p.recentTasks.length === 0 ? (
                    <p className="text-xs text-muted-foreground">none yet</p>
                  ) : (
                    <ul className="mt-1 space-y-1.5">
                      {p.recentTasks.slice(0, 3).map((t) => (
                        <li key={t.id} className="flex items-center justify-between gap-2 text-xs">
                          <span className="truncate font-mono">{t.title}</span>
                          {t.latestRun ? <StateBadge state={t.latestRun.state} /> : <Badge variant="outline" className="text-[10px]">{t.status}</Badge>}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="flex items-center justify-between pt-2 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" />{new Date(p.createdAt).toLocaleDateString()}</span>
                  <Button variant="ghost" size="sm" className="h-6 gap-1 text-xs opacity-0 group-hover:opacity-100">
                    Open <ChevronRight className="h-3 w-3" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}

export function EmptyProjectHint({ onCreate }: { onCreate: () => void }) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center justify-center py-12 text-center">
        <Plus className="h-8 w-8 text-muted-foreground mb-2" />
        <p className="text-sm text-muted-foreground">Create your first project to get started.</p>
        <Button className="mt-4" size="sm" onClick={onCreate}>New project</Button>
      </CardContent>
    </Card>
  )
}

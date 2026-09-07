'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Progress } from '@/components/ui/progress'
import { ArrowLeft, GitBranch, RefreshCw, Map, LayoutDashboard, ListTodo, Brain, Cpu, Clock } from 'lucide-react'
import { api } from './api'
import { OverviewTab } from './overview-tab'
import { SystemMapTab } from './system-map-tab'
import { TasksTab } from './tasks-tab'
import { MemoryTab } from './memory-tab'
import type { MemoryView, RepoOverview, SystemMapGraph } from '@/lib/types'
import { useToast } from '@/hooks/use-toast'

export function ProjectView({ projectId, onBack, onOpenRun }: {
  projectId: string
  onBack: () => void
  onOpenRun: (runId: string) => void
}) {
  const [project, setProject] = useState<any>(null)
  const [overview, setOverview] = useState<RepoOverview | null>(null)
  const [overviewStatus, setOverviewStatus] = useState('')
  const [overviewProgress, setOverviewProgress] = useState(0)
  const [overviewStep, setOverviewStep] = useState('')
  const [overviewError, setOverviewError] = useState('')
  const [repoInfo, setRepoInfo] = useState<any>(null)
  const [map, setMap] = useState<SystemMapGraph | null>(null)
  const { toast } = useToast()

  const loadProject = useCallback(async () => {
    try {
      const { project: p } = await api.project(projectId)
      setProject(p)
    } catch (e: any) {
      toast({ title: 'Failed to load project', description: e.message, variant: 'destructive' })
    }
  }, [projectId, toast])

  const loadOverviewRef = useRef<(repoId: string) => void>(() => {})

  const loadOverview = useCallback(async (repoId: string) => {
    try {
      const res = await api.overview(repoId)
      setOverview(res.overview)
      setOverviewStatus(res.status)
      setOverviewProgress(res.progress || 0)
      setOverviewStep(res.progressStep || '')
      setOverviewError(res.error || '')
      setRepoInfo((res as any).repository || null)
      if (res.status === 'indexing') {
        // keep polling while indexing
        setTimeout(() => loadOverviewRef.current(repoId), 1500)
      } else if (res.status === 'ready' && res.overview) {
        const m = await api.systemMap(repoId)
        setMap(m as any)
        loadProject()
      }
    } catch { /* transient */ }
  }, [loadProject])

  useEffect(() => {
    loadOverviewRef.current = (repoId: string) => { void loadOverview(repoId) }
  }, [loadOverview])

  useEffect(() => {
    const t = setTimeout(() => loadProject(), 0)
    return () => clearTimeout(t)
  }, [loadProject])

  useEffect(() => {
    if (project?.repository?.id) {
      const t = setTimeout(() => loadOverview(project.repository.id), 0)
      return () => clearTimeout(t)
    }
  }, [project?.repository?.id, loadOverview])

  const reanalyze = async () => {
    if (!project?.repository?.id) return
    try {
      await api.analyzeRepo(project.repository.id)
      setOverviewStatus('indexing')
      toast({ title: 'Re-analysis started' })
      loadOverview(project.repository.id)
    } catch (e: any) {
      toast({ title: 'Failed', description: e.message, variant: 'destructive' })
    }
  }

  if (!project) {
    return (
      <div className="space-y-4">
        <div className="rounded-lg border p-4 space-y-2.5 animate-pulse">
          <div className="h-4 w-1/3 bg-muted rounded" />
          <div className="h-3 w-2/3 bg-muted rounded" />
        </div>
      </div>
    )
  }

  const repo = project.repository
  const repoReady = repo?.analysisStatus === 'ready'

  return (
    <div className="space-y-4 max-w-6xl">
      {/* header */}
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onBack}><ArrowLeft className="h-4 w-4" /></Button>
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-bold tracking-tight truncate">{project.name}</h1>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground mt-0.5">
            {repo ? (
              <>
                <span className="font-mono">{repo.source}</span>
                <span className="inline-flex items-center gap-1"><GitBranch className="h-3 w-3" />{repo.branch || repo.defaultBranch}</span>
                <span>{repo.fileCount || 0} files</span>
                {repo.sourceType && <Badge variant="outline" className="text-[10px]">{repo.sourceType}</Badge>}
                {repo.analysisStatus === 'indexing' && <span className="text-amber-600 dark:text-amber-300">{repo.progressStep || 'indexing…'} {repo.progress}%</span>}
                {repo.analysisStatus === 'failed' && <span className="text-red-600 dark:text-red-400">analysis failed</span>}
              </>
            ) : (
              <span className="text-red-600 dark:text-red-400">no repository connected</span>
            )}
          </div>
        </div>
        {repo && (
          <Button variant="outline" size="sm" onClick={reanalyze} disabled={repo.analysisStatus === 'indexing'}>
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${repo.analysisStatus === 'indexing' ? 'animate-spin' : ''}`} />
            {repoReady ? 'Re-analyze' : 'Analyze repository'}
          </Button>
        )}
      </div>

      {repo?.analysisStatus === 'indexing' && (
        <Card>
          <CardContent className="py-3 space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">{repo.progressStep || 'indexing repository'}</span>
              <span className="font-mono text-xs">{repo.progress}%</span>
            </div>
            <Progress value={repo.progress} />
          </CardContent>
        </Card>
      )}

      {/* tabs */}
      <Tabs defaultValue="overview">
        <TabsList className="w-full justify-start flex-wrap h-auto">
          <TabsTrigger value="overview" className="gap-1.5 text-xs sm:text-sm"><LayoutDashboard className="h-3.5 w-3.5" />Overview</TabsTrigger>
          <TabsTrigger value="map" className="gap-1.5 text-xs sm:text-sm"><Map className="h-3.5 w-3.5" />System map</TabsTrigger>
          <TabsTrigger value="tasks" className="gap-1.5 text-xs sm:text-sm"><ListTodo className="h-3.5 w-3.5" />Tasks</TabsTrigger>
          <TabsTrigger value="memory" className="gap-1.5 text-xs sm:text-sm"><Brain className="h-3.5 w-3.5" />Memory</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4">
          <OverviewTab
            overview={overview}
            status={overviewStatus || repo?.analysisStatus || 'pending'}
            progress={overviewProgress}
            progressStep={overviewStep}
            error={overviewError}
            onReanalyze={reanalyze}
            repoInfo={repoInfo}
          />
        </TabsContent>

        <TabsContent value="map" className="mt-4">
          <SystemMapTab nodes={map?.nodes || []} edges={map?.edges || []} />
        </TabsContent>

        <TabsContent value="tasks" className="mt-4">
          <TasksTab
            projectId={projectId}
            tasks={project.tasks || []}
            repoReady={repoReady}
            onTaskStarted={loadProject}
            onOpenRun={onOpenRun}
          />
        </TabsContent>

        <TabsContent value="memory" className="mt-4">
          <MemoryTab
            projectId={projectId}
            memories={(project.memories || []) as MemoryView[]}
            onAdded={loadProject}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}

'use client'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Button } from '@/components/ui/button'
import { Languages, Database, Package, FolderTree, TestTube2, DoorOpen, ScrollText, RefreshCw, AlertTriangle, Layers } from 'lucide-react'
import type { RepoOverview } from '@/lib/types'

export function OverviewTab({ overview, status, progress, progressStep, error, onReanalyze, repoInfo }: {
  overview: RepoOverview | null
  status: string
  progress?: number
  progressStep?: string
  error?: string
  onReanalyze: () => void
  repoInfo?: any
}) {
  if (status === 'indexing' || status === 'analyzing') {
    return (
      <Card>
        <CardContent className="py-12 space-y-4">
          <div className="flex items-center gap-3">
            <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" />
            <div>
              <p className="font-medium">Repository analysis in progress</p>
              <p className="text-sm text-muted-foreground">{progressStep || 'working…'}</p>
            </div>
            <span className="ml-auto text-sm font-mono text-muted-foreground">{progress ?? 0}%</span>
          </div>
          <Progress value={progress ?? 0} />
          <p className="text-xs text-muted-foreground">
            Indexing files, extracting symbols with Tree-sitter, building the relationship graph, embedding documents and git history.
          </p>
        </CardContent>
      </Card>
    )
  }

  if (status === 'failed') {
    return (
      <Card className="border-red-500/40">
        <CardContent className="py-10 space-y-3">
          <div className="flex items-center gap-2 text-red-600 dark:text-red-400">
            <AlertTriangle className="h-5 w-5" />
            <p className="font-medium">Repository analysis failed</p>
          </div>
          <p className="text-sm text-muted-foreground font-mono break-all">{error || 'unknown error'}</p>
          <Button size="sm" variant="outline" onClick={onReanalyze}>
            <RefreshCw className="h-4 w-4 mr-2" />Retry analysis
          </Button>
        </CardContent>
      </Card>
    )
  }

  if (!overview) {
    return (
      <Card>
        <CardContent className="py-10 text-center">
          <p className="text-sm text-muted-foreground">Repository not analyzed yet.</p>
          <Button className="mt-4" size="sm" onClick={onReanalyze}>
            <RefreshCw className="h-4 w-4 mr-2" />Analyze repository
          </Button>
        </CardContent>
      </Card>
    )
  }

  const maxFiles = Math.max(...overview.languages.map((l) => l.files), 1)

  return (
    <div className="space-y-4">
      {/* architecture summary */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base"><ScrollText className="h-4 w-4" />Architecture summary</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm leading-relaxed">{overview.architectureSummary}</p>
          {repoInfo && (
            <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
              <span>branch <code className="font-mono">{repoInfo.branch}</code></span>
              <span>{repoInfo.fileCount} files</span>
              {repoInfo.sizeKb ? <span>{repoInfo.sizeKb} KB</span> : null}
              <span>HEAD <code className="font-mono">{String(repoInfo.headCommit || '').slice(0, 8)}</code></span>
              {repoInfo.lastIndexedAt && <span>indexed {new Date(repoInfo.lastIndexedAt).toLocaleString()}</span>}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        {/* languages */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base"><Languages className="h-4 w-4" />Languages</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {overview.languages.slice(0, 6).map((l) => (
              <div key={l.name} className="space-y-1">
                <div className="flex justify-between text-sm">
                  <span className="font-mono">{l.name}</span>
                  <span className="text-muted-foreground">{l.files} files · {l.loc.toLocaleString()} loc</span>
                </div>
                <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                  <div className="h-full rounded-full bg-emerald-600 dark:bg-emerald-400" style={{ width: `${(l.files / maxFiles) * 100}%` }} />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* database */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base"><Database className="h-4 w-4" />Database</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p className="font-medium">{overview.database.detected}</p>
            {overview.database.tables.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {overview.database.tables.map((t) => (
                  <Badge key={t} variant="secondary" className="font-mono text-xs">{t}</Badge>
                ))}
              </div>
            )}
            {overview.database.details.slice(0, 3).map((d, i) => (
              <p key={i} className="text-xs text-muted-foreground">{d}</p>
            ))}
            {overview.database.accessLayers.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Access layers: <span className="font-mono">{overview.database.accessLayers.slice(0, 4).join(', ')}</span>
              </p>
            )}
          </CardContent>
        </Card>

        {/* entry + services */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base"><DoorOpen className="h-4 w-4" />Entry points &amp; services</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {overview.entryPoints.length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Entry points</p>
                <div className="flex flex-wrap gap-1.5 mt-1">
                  {overview.entryPoints.map((e) => <Badge key={e} variant="outline" className="font-mono text-xs">{e}</Badge>)}
                </div>
              </div>
            )}
            {overview.services.length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mt-2">Services / modules</p>
                <div className="flex flex-wrap gap-1.5 mt-1">
                  {overview.services.map((s) => <Badge key={s} variant="secondary" className="font-mono text-xs">{s}</Badge>)}
                </div>
              </div>
            )}
            {overview.frameworks.length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mt-2">Frameworks</p>
                <div className="flex flex-wrap gap-1.5 mt-1">
                  {overview.frameworks.map((f) => <Badge key={f} variant="outline" className="text-xs">{f}</Badge>)}
                </div>
              </div>
            )}
            {overview.testFrameworks.length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mt-2">Test frameworks</p>
                <div className="flex flex-wrap gap-1.5 mt-1">
                  {overview.testFrameworks.map((t) => (
                    <Badge key={t} variant="outline" className="text-xs bg-teal-500/10 text-teal-700 dark:text-teal-300 border-teal-500/30">
                      <TestTube2 className="h-3 w-3 mr-1" />{t}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* important directories */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base"><FolderTree className="h-4 w-4" />Important directories</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {overview.importantDirectories.slice(0, 10).map((d) => (
              <div key={d.path} className="flex items-baseline justify-between gap-3 text-sm">
                <span className="font-mono text-xs truncate">{d.path}</span>
                <span className="text-xs text-muted-foreground truncate">{d.purpose}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {/* dependencies */}
      {overview.dependencies.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base"><Package className="h-4 w-4" />Dependencies</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-1.5">
              {overview.dependencies.map((d) => (
                <Badge key={`${d.name}:${d.version}`} variant={d.type === 'dev' ? 'outline' : 'secondary'} className="font-mono text-xs">
                  {d.name}@{d.version}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* stats */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-x-8 gap-y-2 py-4 text-sm">
          <span className="inline-flex items-center gap-2"><Layers className="h-4 w-4 text-muted-foreground" /><b>{overview.stats.files}</b> files</span>
          <span><b>{overview.stats.symbols}</b> symbols</span>
          <span><b>{overview.stats.commits}</b> commits indexed</span>
          <Button size="sm" variant="outline" className="ml-auto" onClick={onReanalyze}>
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" />Re-analyze
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}

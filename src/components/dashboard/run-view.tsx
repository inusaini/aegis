'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  ArrowLeft, GitBranch, Cpu, Clock, XCircle, GitCommitHorizontal, CheckCircle2,
  Wrench, Search, Lightbulb, AlertTriangle, ShieldCheck, ListChecks, Activity,
} from 'lucide-react'
import type { AgentState, RunEvent, RunView, TestRunView } from '@/lib/types'
import { StateBadge, TypeBadge } from './badges'
import { ImpactPanel } from './impact-panel'
import { PlanPanel } from './plan-panel'
import { DiffViewer } from './diff-viewer'
import { api } from './api'
import { useToast } from '@/hooks/use-toast'

const ACTIVE_STATES = ['CREATED', 'DISCOVERING', 'UNDERSTANDING', 'IMPACT_ANALYSIS', 'PLANNING', 'IMPLEMENTING', 'VERIFYING', 'FIXING', 'FINAL_REVIEW', 'WAITING_FOR_APPROVAL']

const PHASE_ICONS: Record<string, any> = {
  repository: Search,
  investigation: Search,
  impact: AlertTriangle,
  plan: ListChecks,
  approval: CheckCircle2,
  implementation: Wrench,
  verification: ShieldCheck,
  fix: Wrench,
  review: Activity,
  system: Cpu,
}

export function RunView({ runId, onBack }: { runId: string; onBack: () => void }) {
  const [run, setRun] = useState<RunView | null>(null)
  const [events, setEvents] = useState<RunEvent[]>([])
  const [state, setState] = useState<string>('CREATED')
  const [busy, setBusy] = useState(false)
  const lastSeq = useRef(0)
  const { toast } = useToast()

  const refreshRun = useCallback(async () => {
    try {
      const { run: r } = await api.run(runId)
      setRun(r)
      setState(r.state)
    } catch (e: any) {
      console.error('run fetch failed', e)
    }
  }, [runId])

  // initial load + refresh loop
  useEffect(() => {
    refreshRun()
  }, [refreshRun])

  // event polling — continues while the run is active, stops on terminal states
  const stateRef = useRef<string>('CREATED')
  useEffect(() => { stateRef.current = state }, [state])

  useEffect(() => {
    let stopped = false
    let timer: any = null

    const poll = async () => {
      try {
        const res = await api.runEvents(runId, lastSeq.current)
        if (stopped) return
        setState(res.state)
        stateRef.current = res.state
        if (res.events.length > 0) {
          setEvents((prev) => [...prev, ...res.events])
          lastSeq.current = res.events[res.events.length - 1].seq
          if (['WAITING_FOR_APPROVAL', 'COMPLETED', 'FAILED', 'IMPLEMENTING'].includes(res.state)) {
            void refreshRun()
          }
        }
      } catch { /* transient */ }
      if (!stopped && ACTIVE_STATES.includes(stateRef.current)) {
        timer = setTimeout(poll, 1500)
      } else if (!stopped) {
        // terminal: one final refresh, then stop
        void refreshRun()
      }
    }
    poll()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }, [runId, refreshRun])

  // when terminal, do a final run refresh (once)
  const terminalRef = useRef<string | null>(null)
  useEffect(() => {
    if (state && !ACTIVE_STATES.includes(state) && terminalRef.current !== state) {
      terminalRef.current = state
      refreshRun()
    }
  }, [state, refreshRun])

  async function cancel() {
    setBusy(true)
    try {
      await api.cancelRun(runId)
      toast({ title: 'Run cancelled' })
      refreshRun()
    } catch (e: any) {
      toast({ title: 'Cancel failed', description: e.message, variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  async function commit() {
    setBusy(true)
    try {
      const res = await api.commitRun(runId)
      if (res.committed) {
        toast({ title: `Committed as ${res.hash}`, description: `on branch ${res.branch}` })
      } else {
        toast({ title: 'Nothing to commit', description: 'the working tree is clean' })
      }
      refreshRun()
    } catch (e: any) {
      toast({ title: 'Commit failed', description: e.message, variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  if (!run && events.length === 0) {
    return (
      <div className="space-y-4">
        <Skeleton />
        <Skeleton />
      </div>
    )
  }

  const isActive = ACTIVE_STATES.includes(state)
  const waiting = state === 'WAITING_FOR_APPROVAL'

  return (
    <div className="space-y-4 max-w-5xl">
      {/* header */}
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onBack}><ArrowLeft className="h-4 w-4" /></Button>
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold truncate">{run?.task.title || 'Agent run'}</h1>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground mt-0.5">
            {run?.provider && <span className="inline-flex items-center gap-1"><Cpu className="h-3 w-3" />{run.provider} provider</span>}
            {run?.branch && <span className="inline-flex items-center gap-1"><GitBranch className="h-3 w-3" /><code className="font-mono">{run.branch}</code></span>}
            {run?.startedAt && <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" />started {new Date(run.startedAt).toLocaleTimeString()}</span>}
            {run?.tokenUsage ? <span>{run.tokenUsage} tokens</span> : null}
          </div>
        </div>
        <StateBadge state={state} pulse={isActive && state !== 'WAITING_FOR_APPROVAL'} />
        {isActive && state !== 'WAITING_FOR_APPROVAL' && (
          <Button variant="outline" size="sm" onClick={cancel} disabled={busy}><XCircle className="h-3.5 w-3.5 mr-1.5" />Cancel</Button>
        )}
        {state === 'COMPLETED' && run?.changes.length ? (
          <Button size="sm" onClick={commit} disabled={busy}>
            <GitCommitHorizontal className="h-4 w-4 mr-2" />Commit changes
          </Button>
        ) : null}
      </div>

      {run?.error && (
        <div className="rounded-md border border-red-500/40 bg-red-500/5 p-3 text-sm text-red-700 dark:text-red-300">
          <p className="font-medium">Run error</p>
          <p className="font-mono text-xs mt-1">{run.error}</p>
        </div>
      )}

      {/* plan + impact + diff tabs */}
      {run && (run.plan || run.changes.length > 0 || run.impact) && (
        <Tabs defaultValue={waiting ? 'plan' : 'diff'} className="w-full">
          <TabsList className="w-full justify-start flex-wrap h-auto">
            <TabsTrigger value="plan" className="data-[state=active]:bg-background text-xs gap-1.5">
              <ListChecks className="h-3.5 w-3.5" />Plan {run.plan?.status === 'approved' ? '✓' : ''}
            </TabsTrigger>
            <TabsTrigger value="impact" className="text-xs gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5" />Impact
            </TabsTrigger>
            <TabsTrigger value="diff" className="text-xs gap-1.5">
              <Wrench className="h-3.5 w-3.5" />Diff {run.changes.length ? `(${run.changes.length})` : ''}
            </TabsTrigger>
            <TabsTrigger value="verification" className="text-xs gap-1.5">
              <ShieldCheck className="h-3.5 w-3.5" />Verification {run.testRuns.length ? `(${run.testRuns.length})` : ''}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="plan" className="mt-3">
            {run.plan ? (
              <PlanPanel
                runId={runId}
                plan={run.plan}
                riskLevel={run.impact?.riskLevel || 'LOW'}
                waiting={waiting}
                onDecision={() => { refreshRun(); void 0 }}
              />
            ) : (
              <p className="text-sm text-muted-foreground">The plan appears when the agent reaches the planning phase.</p>
            )}
          </TabsContent>

          <TabsContent value="impact" className="mt-3">
            {run.impact ? <ImpactPanel impact={run.impact} /> : (
              <p className="text-sm text-muted-foreground">Impact analysis appears after the investigation phase.</p>
            )}
          </TabsContent>

          <TabsContent value="diff" className="mt-3">
            <DiffViewer changes={run.changes} />
          </TabsContent>

          <TabsContent value="verification" className="mt-3">
            <VerificationPanel testRuns={run.testRuns} finalResult={run.finalResult} />
          </TabsContent>
        </Tabs>
      )}

      {/* live timeline */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Activity className="h-4 w-4" />Agent activity
            {isActive && <span className="text-xs text-muted-foreground font-normal animate-pulse">live</span>}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Timeline events={events} />
        </CardContent>
      </Card>

      {/* final result */}
      {run?.finalResult?.summary && (
        <Card className={state === 'COMPLETED' ? 'border-emerald-500/40' : 'border-red-500/40'}>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <CheckCircle2 className={`h-4 w-4 ${state === 'COMPLETED' ? 'text-emerald-600' : 'text-red-600'}`} />
              Final result
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm leading-relaxed">{run.finalResult.summary}</p>
            {run.finalResult.verified && run.finalResult.verified.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">What was verified</p>
                {run.finalResult.verified.map((v) => (
                  <div key={v.label} className="flex items-start gap-2 text-sm">
                    {v.passed ? <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400 mt-0.5 shrink-0" /> : <XCircle className="h-4 w-4 text-red-600 dark:text-red-400 mt-0.5 shrink-0" />}
                    <div>
                      <span className="font-mono text-xs font-medium">{v.label}</span>
                      <p className="text-xs text-muted-foreground">{v.detail}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {run.finalResult.nextSteps && (
              <div className="text-xs text-muted-foreground space-y-0.5 pt-2 border-t">
                <p className="font-medium uppercase tracking-wide text-[10px] mb-1">Next steps</p>
                {run.finalResult.nextSteps.map((s) => <p key={s}>— {s}</p>)}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function Timeline({ events }: { events: RunEvent[] }) {
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [events.length])

  if (events.length === 0) {
    return <p className="text-sm text-muted-foreground">Waiting for the first agent event…</p>
  }

  return (
    <div className="space-y-0 max-h-[520px] overflow-y-auto pr-2">
      {events.map((e) => {
        const Icon = PHASE_ICONS[e.phase] || Lightbulb
        const isApproval = e.type === 'approval'
        return (
          <div key={e.seq} className="flex gap-3 relative pb-3.5">
            {/* vertical line */}
            <div className="absolute left-[13px] top-6 bottom-0 w-px bg-border" />
            <div className={`h-6 w-6 rounded-full flex items-center justify-center shrink-0 z-10 ${
              e.type === 'error' ? 'bg-red-500/15 text-red-600 dark:text-red-400'
                : e.type === 'success' ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                  : isApproval ? 'bg-yellow-500/20 text-yellow-700 dark:text-yellow-300'
                    : e.type === 'warning' ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
                      : 'bg-muted text-muted-foreground'
            }`}>
              <Icon className="h-3.5 w-3.5" />
            </div>
            <div className="min-w-0 flex-1 -mt-0.5">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-medium">{e.title}</p>
                <TypeBadge type={e.type} />
                <span className="text-[10px] text-muted-foreground ml-auto font-mono shrink-0">
                  {new Date(e.createdAt).toLocaleTimeString()}
                </span>
              </div>
              {e.detail && <p className="text-xs text-muted-foreground mt-0.5 break-words line-clamp-4">{e.detail}</p>}
            </div>
          </div>
        )
      })}
      <div ref={endRef} />
    </div>
  )
}

function VerificationPanel({ testRuns, finalResult }: { testRuns: TestRunView[]; finalResult: any }) {
  if (testRuns.length === 0) {
    return <p className="text-sm text-muted-foreground">Verification runs appear once implementation begins.</p>
  }

  return (
    <div className="space-y-2">
      {testRuns.map((t) => (
        <div key={t.id} className="rounded-lg border p-3 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={t.status === 'passed' ? 'secondary' : 'destructive'} className="text-xs">
              {t.status === 'passed' ? '✓ passed' : t.status}
            </Badge>
            <span className="font-mono text-xs">{t.command || '(none)'}</span>
            <Badge variant="outline" className="text-[10px] ml-auto">{t.kind}</Badge>
            {t.fixAttempt > 0 && <Badge variant="outline" className="text-[10px]">fix attempt {t.fixAttempt}</Badge>}
            {t.classification && (
              <Badge variant="outline" className={`text-[10px] ${
                t.classification === 'agent_caused' ? 'border-red-500/40 text-red-700 dark:text-red-300'
                  : t.classification === 'pre_existing' ? 'border-amber-500/40 text-amber-700 dark:text-amber-300'
                    : 'border-teal-500/40 text-teal-700 dark:text-teal-300'
              }`}>
                {t.classification.replaceAll('_', ' ')}
              </Badge>
            )}
            <span className="text-xs text-muted-foreground">{(t.durationMs / 1000).toFixed(1)}s</span>
          </div>
          {t.summary && t.summary !== 'passed' && (
            <pre className="text-[11px] font-mono whitespace-pre-wrap text-muted-foreground max-h-32 overflow-y-auto">{t.summary.slice(0, 1500)}</pre>
          )}
        </div>
      ))}
    </div>
  )
}

function Skeleton() {
  return (
    <div className="rounded-lg border p-4 space-y-2.5 animate-pulse">
      <div className="h-4 w-1/3 bg-muted rounded" />
      <div className="h-3 w-2/3 bg-muted rounded" />
      <div className="h-3 w-1/2 bg-muted rounded" />
    </div>
  )
}

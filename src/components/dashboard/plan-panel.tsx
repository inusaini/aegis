'use client'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { CheckCircle2, XCircle, ShieldAlert, ClipboardList, FilePen, FilePlus2, FileMinus, TestTube2, Undo2, ArrowRight } from 'lucide-react'
import type { PlanView } from '@/lib/types'
import { RiskBadge } from './badges'
import { useToast } from '@/hooks/use-toast'
import { api } from './api'
import { useState } from 'react'

export function PlanPanel({ runId, plan, riskLevel, waiting }: {
  runId: string
  plan: PlanView
  riskLevel: string
  waiting: boolean
  onDecision: () => void
}) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const { toast } = useToast()

  async function decide(decision: 'approve' | 'reject') {
    setBusy(true)
    try {
      await api.approve(runId, decision, reason || undefined)
      toast({
        title: decision === 'approve' ? 'Plan approved' : 'Plan rejected',
        description: decision === 'approve' ? 'The agent is implementing in an isolated workspace.' : 'The run was cancelled — nothing was changed.',
      })
      onDecision()
    } catch (e: any) {
      toast({ title: 'Decision failed', description: e.message, variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className={waiting ? 'border-yellow-500/50 shadow-sm' : ''}>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <ClipboardList className="h-4 w-4" />Implementation plan
          </CardTitle>
          <RiskBadge risk={riskLevel} />
          <Badge variant={plan.status === 'approved' ? 'default' : plan.status === 'rejected' ? 'destructive' : 'secondary'} className="text-xs">
            {plan.status}
          </Badge>
          {waiting && (
            <span className="text-xs text-yellow-700 dark:text-yellow-300 animate-pulse font-medium">
              awaiting your approval
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <p className="text-sm font-medium">{plan.objective}</p>
          {plan.narrative && <p className="text-sm text-muted-foreground mt-1.5 leading-relaxed">{plan.narrative}</p>}
        </div>

        <div className="grid gap-3 sm:grid-cols-2 text-sm">
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1"><FilePen className="h-3 w-3" />Files to modify</p>
            {plan.filesToModify.length === 0 ? <p className="text-xs text-muted-foreground">none</p> :
              plan.filesToModify.map((f) => <p key={f} className="font-mono text-xs truncate">{f}</p>)}
          </div>
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1"><FilePlus2 className="h-3 w-3" />Files to create</p>
            {plan.filesToCreate.length === 0 ? <p className="text-xs text-muted-foreground">none</p> :
              plan.filesToCreate.map((f) => <p key={f} className="font-mono text-xs truncate">{f}</p>)}
          </div>
          {plan.filesToDelete.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1"><FileMinus className="h-3 w-3" />Files to delete</p>
              {plan.filesToDelete.map((f) => <p key={f} className="font-mono text-xs truncate">{f}</p>)}
            </div>
          )}
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">API changes</p>
            {plan.apiChanges.length === 0 ? <p className="text-xs text-muted-foreground">none</p> :
              plan.apiChanges.map((a) => <p key={a} className="font-mono text-xs">{a}</p>)}
          </div>
          {plan.databaseChanges.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Database changes</p>
              {plan.databaseChanges.map((d) => <p key={d} className="text-xs">{d}</p>)}
            </div>
          )}
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1"><TestTube2 className="h-3 w-3" />Tests required</p>
            {plan.testsRequired.map((t) => <p key={t} className="font-mono text-xs truncate">{t}</p>)}
          </div>
        </div>

        {plan.assumptions.length > 0 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Assumptions</p>
            <ul className="text-xs space-y-0.5 list-disc list-inside text-muted-foreground">
              {plan.assumptions.map((a) => <li key={a}>{a}</li>)}
            </ul>
          </div>
        )}

        {plan.risks.length > 0 && (
          <Alert>
            <ShieldAlert className="h-4 w-4" />
            <AlertTitle>Risks</AlertTitle>
            <AlertDescription>
              <ul className="text-xs space-y-1 list-disc list-inside">
                {plan.risks.map((r) => <li key={r}>{r}</li>)}
              </ul>
            </AlertDescription>
          </Alert>
        )}

        {plan.rollbackStrategy && (
          <div className="flex items-start gap-2 text-xs text-muted-foreground">
            <Undo2 className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <p><span className="font-medium">Rollback:</span> {plan.rollbackStrategy}</p>
          </div>
        )}

        {plan.steps && plan.steps.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Steps</p>
            {plan.steps.map((s, i) => (
              <div key={i} className="flex items-start gap-2 text-sm">
                <span className="text-xs font-mono text-muted-foreground mt-0.5">{i + 1}.</span>
                <div>
                  <p className="text-xs font-medium">{s.title}</p>
                  <p className="text-xs text-muted-foreground">{s.detail}</p>
                </div>
              </div>
            ))}
          </div>
        )}

        {waiting && (
          <div className="space-y-3 pt-2 border-t">
            <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Optional feedback (required context for rejection)" />
            <div className="flex gap-2">
              <Button onClick={() => decide('approve')} disabled={busy} className="bg-emerald-700 hover:bg-emerald-600">
                <CheckCircle2 className="h-4 w-4 mr-2" />Approve plan
              </Button>
              <Button variant="destructive" onClick={() => decide('reject')} disabled={busy}>
                <XCircle className="h-4 w-4 mr-2" />Reject
              </Button>
            </div>
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <ArrowRight className="h-3 w-3" />Approval gates the implementation: nothing in the repository changes until you approve.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

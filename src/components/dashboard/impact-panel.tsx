'use client'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Radio, Database, Webhook, FlaskConical, AlertTriangle, Target } from 'lucide-react'
import type { ImpactView } from '@/lib/types'
import { RiskBadge } from './badges'

export function ImpactPanel({ impact }: { impact: ImpactView }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="flex items-center gap-2 text-base"><Radio className="h-4 w-4" />Impact analysis</CardTitle>
          <RiskBadge risk={impact.riskLevel} />
          <span className="text-xs text-muted-foreground ml-auto font-mono">
            blast radius: {impact.blastRadius.direct} direct · {impact.blastRadius.indirect} transitive
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">{(impact as any).rationale || ''}</p>

        <div className="grid gap-3 sm:grid-cols-2 text-sm">
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1"><Target className="h-3 w-3" />Files affected</p>
            {impact.filesAffected?.slice(0, 10).map((f) => (
              <div key={f.path} className="text-xs">
                <span className="font-mono">{f.path}</span>
                <p className="text-muted-foreground text-[11px]">{f.reason}</p>
              </div>
            ))}
          </div>
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1"><FlaskConical className="h-3 w-3" />Tests affected</p>
            {impact.testsAffected?.length === 0 ? <p className="text-xs text-muted-foreground">none detected</p> :
              impact.testsAffected?.slice(0, 10).map((t) => (
                <div key={t.path} className="text-xs">
                  <span className="font-mono">{t.path}</span>
                  <p className="text-muted-foreground text-[11px]">{t.reason}</p>
                </div>
              ))}
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 text-sm">
          {impact.apisAffected?.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1"><Webhook className="h-3 w-3" />APIs affected</p>
              {impact.apisAffected.slice(0, 8).map((a) => <p key={a} className="text-xs font-mono">{a}</p>)}
            </div>
          )}
          {impact.databaseChanges?.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1"><Database className="h-3 w-3" />Database touchpoints</p>
              {impact.databaseChanges.slice(0, 6).map((d) => <p key={d} className="text-xs">{d}</p>)}
            </div>
          )}
        </div>

        {impact.compatibilityConcerns?.length > 0 && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 space-y-1.5">
            <p className="text-xs font-medium flex items-center gap-1 text-amber-700 dark:text-amber-300">
              <AlertTriangle className="h-3.5 w-3.5" />Compatibility concerns (evidence-backed)
            </p>
            {impact.compatibilityConcerns.map((c) => <p key={c} className="text-xs">{c}</p>)}
          </div>
        )}

        {impact.evidence?.length > 0 && (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground font-medium">Evidence trail ({impact.evidence.length})</summary>
            <ul className="mt-1.5 space-y-1 list-disc list-inside text-muted-foreground">
              {impact.evidence.map((e, i) => <li key={i}><span className="font-mono text-[10px] uppercase">{e.source}</span> — {e.detail}</li>)}
            </ul>
          </details>
        )}
      </CardContent>
    </Card>
  )
}

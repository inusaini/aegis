'use client'

import { useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Brain, Plus } from 'lucide-react'
import type { MemoryView } from '@/lib/types'
import { MemoryKindBadge } from './badges'
import { api } from './api'

export function MemoryTab({ projectId, memories, onAdded }: {
  projectId: string
  memories: MemoryView[]
  onAdded: () => void
}) {
  const [content, setContent] = useState('')
  const [busy, setBusy] = useState(false)
  const { } = useState('')

  async function add() {
    if (content.trim().length < 5) return
    setBusy(true)
    try {
      await api.addMemory(projectId, content.trim(), 'rule')
      setContent('')
      onAdded()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold flex items-center gap-2"><Brain className="h-4 w-4" />Project memory</h2>
        <p className="text-sm text-muted-foreground">
          Durable knowledge the agent reuses: verified facts from the index, inferred conventions, git-documented constraints, and your rules.
          Provenance is labeled — model-generated statements are never silently treated as truth.
        </p>
      </div>

      <Card>
        <CardContent className="py-3 space-y-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Add a team rule</p>
          <Textarea rows={2} value={content} onChange={(e) => setContent(e.target.value)} placeholder="e.g. Never touch src/lib/legacyIds.js — the reporting ETL depends on the integer ID scheme" />
          <div className="flex justify-end">
            <Button size="sm" variant="outline" onClick={add} disabled={busy || content.trim().length < 5}>
              <Plus className="h-3.5 w-3.5 mr-1.5" />Add rule
            </Button>
          </div>
        </CardContent>
      </Card>

      {memories.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Memories appear after the first agent run (architecture facts, quirks, compatibility constraints) or when you add rules.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-2 md:grid-cols-2">
          {memories.map((m) => (
            <Card key={m.id} className="py-3">
              <CardContent className="space-y-1.5 px-4">
                <div className="flex items-center gap-2 flex-wrap">
                  <MemoryKindBadge kind={m.kind} />
                  <Badge variant="outline" className="text-[10px]">{m.category}</Badge>
                  <span className="text-[10px] text-muted-foreground ml-auto">{Math.round(m.confidence * 100)}% confidence · {m.source}</span>
                </div>
                <p className="text-sm leading-snug">{m.content}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}

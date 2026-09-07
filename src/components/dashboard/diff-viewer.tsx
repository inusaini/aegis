'use client'

import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ChevronDown, ChevronRight, FilePlus2, FilePen, FileMinus } from 'lucide-react'
import type { ChangeView } from '@/lib/types'

interface DiffLine { type: 'add' | 'del' | 'ctx' | 'hunk'; text: string }

function parseDiff(diff: string): DiffLine[] {
  const out: DiffLine[] = []
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) out.push({ type: 'hunk', text: line })
    else if (line.startsWith('+') && !line.startsWith('+++')) out.push({ type: 'add', text: line })
    else if (line.startsWith('-') && !line.startsWith('---')) out.push({ type: 'del', text: line })
    else if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')) continue
    else out.push({ type: 'ctx', text: line })
  }
  return out
}

export function DiffViewer({ changes }: { changes: ChangeView[] }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  if (changes.length === 0) {
    return <p className="text-sm text-muted-foreground py-6 text-center">No changes produced in this run.</p>
  }

  const toggle = (file: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(file)) next.delete(file)
      else next.add(file)
      return next
    })
  }

  return (
    <div className="space-y-3">
      {changes.map((c) => {
        const lines = parseDiff(c.diff)
        const isCollapsed = collapsed.has(c.file)
        return (
          <div key={c.file} className="rounded-lg border overflow-hidden">
            <button
              className="w-full flex items-center gap-2 px-3 py-2 bg-muted/50 hover:bg-muted transition-colors text-left"
              onClick={() => toggle(c.file)}
            >
              {isCollapsed ? <ChevronRight className="h-4 w-4 shrink-0" /> : <ChevronDown className="h-4 w-4 shrink-0" />}
              {c.changeType === 'created' ? <FilePlus2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                : c.changeType === 'deleted' ? <FileMinus className="h-4 w-4 text-red-600 dark:text-red-400" />
                : <FilePen className="h-4 w-4 text-amber-600 dark:text-amber-400" />}
              <span className="font-mono text-xs truncate">{c.file}</span>
              <Badge variant="outline" className="ml-auto text-[10px] shrink-0">{c.changeType}</Badge>
              <span className="text-xs text-emerald-600 dark:text-emerald-400 shrink-0">+{c.additions}</span>
              <span className="text-xs text-red-600 dark:text-red-400 shrink-0">-{c.deletions}</span>
            </button>
            {!isCollapsed && (
              <div className="overflow-x-auto text-xs font-mono max-h-[420px] overflow-y-auto">
                {lines.length === 0 && <p className="px-3 py-2 text-muted-foreground">(new file)</p>}
                {lines.map((l, i) => (
                  <div
                    key={i}
                    className={
                      l.type === 'add' ? 'bg-emerald-500/10 text-emerald-900 dark:text-emerald-200 px-2 whitespace-pre'
                        : l.type === 'del' ? 'bg-red-500/10 text-red-900 dark:text-red-200 px-2 whitespace-pre'
                        : l.type === 'hunk' ? 'bg-muted text-muted-foreground px-2 whitespace-pre'
                        : 'px-2 text-muted-foreground whitespace-pre'
                    }
                  >
                    {l.text || ' '}
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

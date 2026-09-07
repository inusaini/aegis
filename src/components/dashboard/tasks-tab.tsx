'use client'

import { useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { Play, Sparkles, Clock } from 'lucide-react'
import { api } from './api'
import { StateBadge } from './badges'
import { useToast } from '@/hooks/use-toast'

interface TaskItem {
  id: string
  title: string
  description: string
  status: string
  createdAt: string
  runs: { id: string; state: string; startedAt: string; finishedAt: string | null }[]
  latestRun?: { id: string; state: string; startedAt: string; finishedAt: string | null } | null
}

const EXAMPLES = [
  'Add a product search API endpoint for searching products by name',
  'Fix the race condition in payment processing that causes double refunds',
  'Change customer IDs from integers to UUIDs',
  'Add OAuth login to the application',
]

export function TasksTab({ projectId, tasks, repoReady, onTaskStarted, onOpenRun }: {
  projectId: string
  tasks: TaskItem[]
  repoReady: boolean
  onTaskStarted: () => void
  onOpenRun: (runId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const { toast } = useToast()

  async function submit() {
    setBusy(true)
    setError('')
    try {
      if (description.trim().length < 10) throw new Error('describe the task in at least 10 characters')
      const { runId } = await api.createTask(projectId, description.trim())
      toast({ title: 'Agent run started', description: 'The agent is investigating the repository. Follow the live timeline.' })
      setOpen(false)
      setDescription('')
      onTaskStarted()
      onOpenRun(runId)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Engineering tasks</h2>
          <p className="text-sm text-muted-foreground">Describe a change — the agent investigates first, then plans, then asks for approval.</p>
        </div>
        <Button size="sm" disabled={!repoReady} onClick={() => setOpen(true)} title={repoReady ? '' : 'repository must be analyzed first'}>
          <Play className="h-4 w-4 mr-2" />New task
        </Button>
      </div>

      {tasks.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Sparkles className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">No tasks yet — describe an engineering task and watch the agent work.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {tasks.map((t) => {
            const latest = t.runs?.[0]
            return (
              <Card key={t.id} className="py-3 cursor-pointer transition-colors hover:bg-accent/40" onClick={() => latest && onOpenRun(latest.id)}>
                <CardContent className="flex items-center gap-4 px-4 py-0">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium truncate">{t.title}</p>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5">
                      <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" />{new Date(t.createdAt).toLocaleString()}</span>
                      <span>{t.runs.length} run{t.runs.length > 1 ? 's' : ''}</span>
                      {t.status && <Badge variant="outline" className="text-[10px]">{t.status}</Badge>}
                    </div>
                  </div>
                  {latest ? <StateBadge state={latest.state} /> : null}
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>New engineering task</DialogTitle>
            <DialogDescription>
              The agent will investigate the repository, analyze impact, and propose a plan for your approval before touching any code.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="e.g. Add a product search API endpoint for searching products by name"
          />
          <div className="flex flex-wrap gap-1.5">
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                className="text-xs text-left px-2 py-1 rounded-md border bg-muted/50 hover:bg-muted transition-colors"
                onClick={() => setDescription(ex)}
              >
                {ex.length > 52 ? ex.slice(0, 52) + '…' : ex}
              </button>
            ))}
          </div>
          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
          <DialogFooter>
            <Button onClick={submit} disabled={busy}>
              <Play className="h-4 w-4 mr-2" />{busy ? 'Starting…' : 'Start agent run'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

'use client'

import { useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { FolderPlus } from 'lucide-react'
import { api } from './api'
import { useToast } from '@/hooks/use-toast'

export function NewProjectDialog({ onCreated }: { onCreated: (projectId: string) => void }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [repoType, setRepoType] = useState<'sample' | 'local' | 'remote'>('sample')
  const [repoSource, setRepoSource] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const { toast } = useToast()

  async function create() {
    setBusy(true)
    setError('')
    try {
      if (name.trim().length < 2) throw new Error('project name too short')
      const { project } = await api.createProject(name.trim(), description.trim())
      await api.connectRepo(project.id, repoSource.trim(), repoType)
      toast({ title: 'Project created', description: 'Repository analysis started in the background.' })
      setOpen(false)
      setName('')
      setDescription('')
      onCreated(project.id)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <FolderPlus className="h-4 w-4 mr-2" />
          New project
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create project</DialogTitle>
          <DialogDescription>A project holds one repository and its engineering tasks.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Project name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. payments-service" />
          </div>
          <div className="space-y-1.5">
            <Label>Description (optional)</Label>
            <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What is this codebase?" />
          </div>
          <div className="space-y-1.5">
            <Label>Connect repository</Label>
            <Select value={repoType} onValueChange={(v: any) => setRepoType(v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="sample">Built-in sample repo (legacy-shop)</SelectItem>
                <SelectItem value="local">Local path on server</SelectItem>
                <SelectItem value="remote">Remote git URL</SelectItem>
              </SelectContent>
            </Select>
            {repoType !== 'sample' && (
              <Input
                className="mt-2 font-mono text-sm"
                value={repoSource}
                onChange={(e) => setRepoSource(e.target.value)}
                placeholder={repoType === 'remote' ? 'https://github.com/org/repo.git' : '/absolute/path/to/repo'}
              />
            )}
            {repoType === 'sample' && (
              <p className="text-xs text-muted-foreground mt-1">
                legacy-shop: a 2015-era Node order system with legacy workarounds, race conditions, tests and 15 commits of history.
              </p>
            )}
          </div>
          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        </div>
        <DialogFooter>
          <Button onClick={create} disabled={busy}>
            {busy ? 'Creating…' : 'Create & analyze'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

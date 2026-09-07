'use client'

// Provider settings dialog: connect an OpenAI-compatible LLM gateway
// (9router, OpenRouter, LiteLLM, Ollama /v1, vLLM…). The saved config
// takes priority over env vars and is applied to new agent runs
// immediately — no server restart needed.

import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { Plug, Check, X, Loader2, Eye } from 'lucide-react'
import { api, type ProviderSettingsInput } from './api'
import { useToast } from '@/hooks/use-toast'

const PLACEHOLDERS: ProviderSettingsInput = {
  enabled: true,
  baseUrl: 'http://localhost:20128/v1',
  apiKey: '',
  providerName: '9router',
  defaultModel: '',
  fastModel: '',
  reasoningModel: '',
  codingModel: '',
  embeddingModel: '',
}

export function ProviderSettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [form, setForm] = useState<ProviderSettingsInput>({ ...PLACEHOLDERS, baseUrl: '' })
  const [keyMasked, setKeyMasked] = useState('')
  const [status, setStatus] = useState<{ available: boolean; lastCheckError: string } | null>(null)
  const [busy, setBusy] = useState<'test' | 'save' | null>(null)
  const [probe, setProbe] = useState<{ ok: boolean; error: string; modelCount: number } | null>(null)
  const [error, setError] = useState('')
  const { toast } = useToast()

  useEffect(() => {
    if (!open) return
    setProbe(null)
    setError('')
    api.providerSettings().then(({ config, status }) => {
      if (config) {
        setForm({
          enabled: config.enabled,
          baseUrl: config.baseUrl,
          apiKey: '',
          providerName: config.providerName || '9router',
          defaultModel: config.defaultModel,
          fastModel: config.fastModel,
          reasoningModel: config.reasoningModel,
          codingModel: config.codingModel,
          embeddingModel: config.embeddingModel,
        })
        setKeyMasked(config.hasApiKey ? config.apiKeyMasked : '')
      } else {
        setForm({ ...PLACEHOLDERS, baseUrl: '' })
        setKeyMasked('')
      }
      setStatus({ available: status.available, lastCheckError: status.lastCheckError })
    }).catch((e) => setError(e.message))
  }, [open])

  function set<K extends keyof ProviderSettingsInput>(key: K, value: ProviderSettingsInput[K]) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  async function runAction(kind: 'test' | 'save') {
    setBusy(kind)
    setError('')
    setProbe(null)
    try {
      const res = await api.saveProviderSettings({ ...form, testOnly: kind === 'test' })
      setProbe(res.test)
      if (kind === 'save') {
        if (res.test.ok) {
          toast({ title: 'Gateway connected', description: `9router endpoint reachable — ${res.test.modelCount} models listed. New runs now use it.` })
        } else {
          toast({ title: 'Saved, but probe failed', description: res.test.error || 'endpoint did not respond — runs will fall back to GLM', variant: 'destructive' })
        }
        onOpenChange(false)
      } else if (res.test.ok) {
        toast({ title: 'Connection OK', description: `${res.test.modelCount} models listed by the gateway.` })
      }
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Plug className="h-4 w-4" /> LLM provider — OpenAI-compatible gateway
          </DialogTitle>
          <DialogDescription>
            Route agent runs through your own gateway (9router, OpenRouter, LiteLLM, Ollama, vLLM…). Saved settings apply to new runs immediately.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex items-center justify-between rounded-lg border p-3">
            <div className="space-y-0.5">
              <div className="text-sm font-medium flex items-center gap-2">
                Use my gateway
                {status && (
                  <Badge variant="outline" className="text-[10px] gap-1">
                    {status.available ? <><Check className="h-3 w-3 text-green-600" /> reachable</> : <><X className="h-3 w-3 text-red-500" /> not reachable</>}
                  </Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground">When off (or unreachable), runs fall back to GLM, then to the offline deterministic engine.</p>
            </div>
            <Switch checked={form.enabled} onCheckedChange={(v) => set('enabled', v)} />
          </div>

          <div className="grid gap-3 sm:grid-cols-[1fr_160px]">
            <div className="space-y-1.5">
              <Label htmlFor="gw-url">Base URL</Label>
              <Input id="gw-url" placeholder="http://localhost:20128/v1" value={form.baseUrl} onChange={(e) => set('baseUrl', e.target.value)} />
              <p className="text-xs text-muted-foreground">Your 9router endpoint, usually <code className="font-mono">http://localhost:20128/v1</code></p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="gw-name">Label</Label>
              <Input id="gw-name" placeholder="9router" value={form.providerName} onChange={(e) => set('providerName', e.target.value)} />
              <p className="text-xs text-muted-foreground">Shown on runs</p>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="gw-key">API key {keyMasked && <span className="text-muted-foreground font-normal">· saved: <code className="font-mono">{keyMasked}</code></span>}</Label>
            <div className="relative">
              <Input id="gw-key" type="password" placeholder="master key (leave blank to keep the saved one)" value={form.apiKey} onChange={(e) => set('apiKey', e.target.value)} className="pr-9" />
              <Eye className="h-4 w-4 absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
            </div>
            <p className="text-xs text-muted-foreground">Sent as <code className="font-mono">Authorization: Bearer …</code> — stored server-side only, never shown again in full.</p>
          </div>

          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Models per role (optional — leave blank to use your gateway&apos;s default routing / combos)</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="m-default">Default</Label>
                <Input id="m-default" placeholder="e.g. my-main-model" value={form.defaultModel} onChange={(e) => set('defaultModel', e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="m-fast">Fast (search / classify)</Label>
                <Input id="m-fast" placeholder="small, quick model" value={form.fastModel} onChange={(e) => set('fastModel', e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="m-reasoning">Reasoning (planning)</Label>
                <Input id="m-reasoning" placeholder="strong reasoning model" value={form.reasoningModel} onChange={(e) => set('reasoningModel', e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="m-coding">Coding (implementation)</Label>
                <Input id="m-coding" placeholder="code-tuned model" value={form.codingModel} onChange={(e) => set('codingModel', e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="m-embed">Embedding (optional)</Label>
                <Input id="m-embed" placeholder="blank = local deterministic" value={form.embeddingModel} onChange={(e) => set('embeddingModel', e.target.value)} />
              </div>
            </div>
          </div>

          {probe && (
            <div className={`text-xs rounded-md border p-2.5 flex items-start gap-2 ${probe.ok ? 'border-green-300 bg-green-50 dark:bg-green-950/40 text-green-800 dark:text-green-300' : 'border-red-300 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300'}`}>
              {probe.ok ? <Check className="h-4 w-4 mt-0.5 shrink-0" /> : <X className="h-4 w-4 mt-0.5 shrink-0" />}
              <span>{probe.ok ? `Endpoint reachable — ${probe.modelCount} models listed.` : probe.error || 'probe failed'}</span>
            </div>
          )}
          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => runAction('test')} disabled={busy !== null || !form.baseUrl}>
            {busy === 'test' ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
            Test connection
          </Button>
          <Button onClick={() => runAction('save')} disabled={busy !== null}>
            {busy === 'save' ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
            Save &amp; activate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

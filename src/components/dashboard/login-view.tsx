'use client'

import { useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Terminal, LogIn, UserPlus } from 'lucide-react'
import { api } from './api'

export function LoginView({ onAuthed }: { onAuthed: () => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('demo@brownfield.dev')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('demo1234')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit() {
    setBusy(true)
    setError('')
    try {
      if (mode === 'login') await api.login(email, password)
      else await api.register(email, name, password)
      onAuthed()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-zinc-50 dark:bg-background p-4">
      <div className="flex items-center gap-3 mb-8">
        <div className="h-11 w-11 rounded-lg bg-zinc-900 dark:bg-zinc-100 flex items-center justify-center">
          <Terminal className="h-6 w-6 text-white dark:text-zinc-900" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">AEGIS</h1>
          <p className="text-sm text-muted-foreground">Brownfield Engineering Agent · Understand first. Change second.</p>
        </div>
      </div>

      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{mode === 'login' ? 'Sign in' : 'Create account'}</CardTitle>
          <CardDescription>
            {mode === 'login' ? 'Use the demo account or your own.' : 'New users get a fresh workspace.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
          </div>
          {mode === 'register' && (
            <div className="space-y-1.5">
              <Label htmlFor="name">Name</Label>
              <Input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" />
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
          </div>
          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
          <Button className="w-full" onClick={submit} disabled={busy}>
            {mode === 'login' ? <LogIn className="h-4 w-4 mr-2" /> : <UserPlus className="h-4 w-4 mr-2" />}
            {busy ? 'Working…' : mode === 'login' ? 'Sign in' : 'Create account'}
          </Button>
          <Button variant="ghost" className="w-full text-sm" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
            {mode === 'login' ? 'No account? Register' : 'Have an account? Sign in'}
          </Button>
          <p className="text-xs text-center text-muted-foreground">
            demo account: <code className="font-mono">demo@brownfield.dev / demo1234</code>
          </p>
        </CardContent>
      </Card>
    </div>
  )
}

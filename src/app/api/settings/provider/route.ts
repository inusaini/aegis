import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { withAuth } from '@/server/api-helpers'
import { setGatewayConfig } from '@/server/llm/openai-compat'
import { resetProviderCache, getGatewayProvider } from '@/server/llm'

/**
 * GET /api/settings/provider — current gateway config (API key masked).
 */
export async function GET() {
  return withAuth(async () => {
    const saved = await db.providerConfig.findUnique({ where: { id: 'default' } })
    const maskedKey = saved?.apiKey
      ? saved.apiKey.length > 8
        ? `${saved.apiKey.slice(0, 4)}…${saved.apiKey.slice(-4)} (${saved.apiKey.length} chars)`
        : '•••'
      : ''
    const gw = getGatewayProvider()
    return {
      config: saved
        ? {
            enabled: saved.enabled,
            baseUrl: saved.baseUrl,
            apiKeyMasked: maskedKey,
            hasApiKey: saved.apiKey.length > 0,
            providerName: saved.providerName,
            defaultModel: saved.defaultModel,
            fastModel: saved.fastModel,
            reasoningModel: saved.reasoningModel,
            codingModel: saved.codingModel,
            embeddingModel: saved.embeddingModel,
          }
        : null,
      env: {
        baseUrl: process.env.LLM_BASE_URL || '',
        providerName: process.env.LLM_PROVIDER_NAME || '',
      },
      status: {
        configured: gw.configured,
        available: gw.configured ? await gw.available() : false,
        lastCheckedAt: saved?.lastCheckedAt?.toISOString() || null,
        lastCheckOk: saved?.lastCheckOk || false,
        lastCheckError: saved?.lastCheckError || '',
      },
    }
  })
}

/**
 * PUT /api/settings/provider — save + validate gateway settings.
 * Body: { enabled, baseUrl, apiKey?, providerName?, defaultModel?, fastModel?,
 *         reasoningModel?, codingModel?, embeddingModel?, testOnly? }
 * If apiKey is omitted the stored key is kept (so the UI can round-trip masked).
 * testOnly=true probes without persisting.
 */
export async function PUT(req: Request) {
  return withAuth(async (user) => {
    const body = await req.json().catch(() => ({}))
    const saved = await db.providerConfig.findUnique({ where: { id: 'default' } })

    const baseUrl = String(body?.baseUrl ?? saved?.baseUrl ?? '').trim().replace(/\/+$/, '')
    const apiKeyRaw = body?.apiKey === undefined || body?.apiKey === null ? saved?.apiKey : String(body.apiKey)
    const apiKey = (apiKeyRaw || '').trim()
    const enabled = body?.enabled === undefined ? (saved?.enabled ?? Boolean(baseUrl)) : Boolean(body.enabled)
    const providerName = String(body?.providerName ?? saved?.providerName ?? '').trim()
    const models = {
      defaultModel: String(body?.defaultModel ?? saved?.defaultModel ?? '').trim(),
      fastModel: String(body?.fastModel ?? saved?.fastModel ?? '').trim(),
      reasoningModel: String(body?.reasoningModel ?? saved?.reasoningModel ?? '').trim(),
      codingModel: String(body?.codingModel ?? saved?.codingModel ?? '').trim(),
      embeddingModel: String(body?.embeddingModel ?? saved?.embeddingModel ?? '').trim(),
    }

    if (enabled && !baseUrl) return NextResponse.json({ error: 'base URL required to enable the gateway' }, { status: 400 })
    if (baseUrl && !/^https?:\/\//.test(baseUrl)) return NextResponse.json({ error: 'base URL must start with http:// or https://' }, { status: 400 })

    // probe the gateway with the would-be settings before persisting
    let probe = { ok: false, error: '', status: 0, modelCount: 0 }
    if (enabled && baseUrl) {
      try {
        const res = await fetch(`${baseUrl}/models`, {
          headers: { ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
          signal: AbortSignal.timeout(6000),
        })
        probe.status = res.status
        if (res.ok) {
          const data: any = await res.json().catch(() => null)
          probe.modelCount = Array.isArray(data?.data) ? data.data.length : 0
          probe.ok = true
        } else {
          probe.error = `gateway responded ${res.status}`
        }
      } catch (err: any) {
        probe.error = err?.name === 'TimeoutError' ? 'connection timed out (6s)' : String(err?.message || err)
      }
    }

    if (body?.testOnly) {
      return { test: probe, saved: false }
    }

    await db.providerConfig.upsert({
      where: { id: 'default' },
      create: {
        id: 'default', enabled, baseUrl, apiKey, providerName, ...models,
        lastCheckedAt: new Date(), lastCheckOk: probe.ok, lastCheckError: probe.error.slice(0, 300),
      },
      update: {
        enabled, baseUrl, apiKey, providerName, ...models,
        lastCheckedAt: new Date(), lastCheckOk: probe.ok, lastCheckError: probe.error.slice(0, 300),
      },
    })
    await db.auditLog.create({
      data: {
        userId: user.id,
        action: 'settings.provider',
        target: 'default',
        metadata: JSON.stringify({ enabled, baseUrl, providerName, probeOk: probe.ok }),
      },
    })

    // apply immediately: runtime config + fresh provider probe
    setGatewayConfig(enabled ? { baseUrl, apiKey, providerName, ...models } : null)
    resetProviderCache()

    return { saved: true, test: probe, applied: true }
  })
}

export const dynamic = 'force-dynamic'

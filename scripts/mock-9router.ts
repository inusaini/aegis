// Mock 9router gateway: a minimal OpenAI-compatible server used by
// the 9router E2E test. Implements the endpoints the agent uses:
//   GET  /v1/models
//   POST /v1/chat/completions
//   POST /v1/embeddings
// Records every request (path, auth header, model, prompt) so the
// test can assert the agent actually routed through the gateway.

import http from 'http'

export interface MockRequest {
  method: string
  path: string
  auth: string
  model: string
  promptChars: number
  wantsJson: boolean
  at: number
}

export function startMock9router(port = 20129): Promise<{ server: http.Server; requests: MockRequest[]; stop: () => Promise<void> }> {
  const requests: MockRequest[] = []

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      const path = (req.url || '').split('?')[0]
      const auth = req.headers.authorization || ''

      const json = (code: number, obj: unknown) => {
        res.writeHead(code, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(obj))
      }

      if (req.method === 'GET' && path === '/v1/models') {
        return json(200, {
          object: 'list',
          data: [
            { id: 'mock-fast', object: 'model' },
            { id: 'mock-reasoning', object: 'model' },
            { id: 'mock-coding', object: 'model' },
          ],
        })
      }

      if (req.method === 'POST' && path === '/v1/chat/completions') {
        let parsed: any = {}
        try { parsed = JSON.parse(body) } catch { /* ignore */ }
        const prompt: string = (parsed.messages || []).map((m: any) => m?.content || '').join('\n')
        requests.push({
          method: 'POST',
          path,
          auth,
          model: parsed.model || '(gateway-default)',
          promptChars: prompt.length,
          wantsJson: parsed.response_format?.type === 'json_object',
          at: Date.now(),
        })

        // The planner prompt names the PlanSchema fields; answer with a
        // valid plan so the LLM strategy is exercised end-to-end.
        const isPlanner = /files_to_modify/.test(prompt) && /rollback_strategy/.test(prompt)
        const content = isPlanner
          ? JSON.stringify({
              objective: 'Add a product search API endpoint for searching products by name',
              assumptions: [
                'The gateway route is a mock; this plan validates LLM-through-gateway planning',
                'Products are served by src/routes/products.js and src/services/productService.js',
              ],
              files_to_modify: ['src/routes/products.js', 'src/services/productService.js'],
              files_to_create: [],
              files_to_delete: [],
              database_changes: [],
              api_changes: ['GET /api/products/search?q=<name>'],
              dependencies: [],
              tests_required: ['node --test tests/products.test.js'],
              risks: ['Additive change only — no existing route signature is modified'],
              rollback_strategy: 'git revert the single commit on the agent branch',
              narrative: 'Plan produced by the mock 9router gateway to validate provider integration.',
              steps: [
                { title: 'Add search handler', detail: 'Extend products router with a query-parameter search route' },
                { title: 'Add service search', detail: 'Add a name-filtering function to productService' },
                { title: 'Verify', detail: 'Run the product test suite' },
              ],
            })
          : 'Acknowledged. The mock gateway returns this plain text for non-planning roles.'

        return json(200, {
          id: `chatcmpl-mock-${requests.length}`,
          object: 'chat.completion',
          model: parsed.model || 'mock-gateway-default',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: Math.ceil(prompt.length / 4), completion_tokens: 64, total_tokens: 0 },
        })
      }

      if (req.method === 'POST' && path === '/v1/embeddings') {
        let parsed: any = {}
        try { parsed = JSON.parse(body) } catch { /* ignore */ }
        const inputs: string[] = Array.isArray(parsed.input) ? parsed.input : [parsed.input]
        requests.push({
          method: 'POST', path, auth, model: parsed.model || '(none)',
          promptChars: 0, wantsJson: false, at: Date.now(),
        })
        return json(200, {
          object: 'list',
          data: inputs.map((_, i) => ({ object: 'embedding', index: i, embedding: [0.1, 0.2, 0.3] })),
          model: parsed.model || 'mock-embedding',
        })
      }

      return json(404, { error: { message: `no route: ${req.method} ${path}` } })
    })
  })

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({
        server,
        requests,
        stop: () => new Promise<void>((r) => server.close(() => r())),
      })
    })
  })
}

// Standalone mode: `bun scripts/mock-9router.ts 20129`
if (process.argv[1] && process.argv[1].includes('mock-9router')) {
  const port = parseInt(process.argv[2] || '20129', 10)
  startMock9router(port).then(({ server }) => {
    console.log(`mock 9router gateway listening on http://127.0.0.1:${port}/v1`)
    process.on('SIGINT', () => server.close(() => process.exit(0)))
  })
}

// ============================================================
// Coding agent (spec §15): READ -> UNDERSTAND -> PATCH ->
// INSPECT DIFF. Two strategies:
//  - LLM: full file contents + plan -> unified diff -> git apply
//  - Heuristic: anchored edit scripts grounded in the plan
// All modifications flow through the tool gateway (logged).
// ============================================================

import fs from 'fs'
import path from 'path'
import type { LLMProvider } from '../llm'
import type { PlanSchema, TaskAnalysis } from './planner'
import { analyzeTask } from './planner'
import type { ToolContext, ToolResult } from './tools'
import { invokeTool } from './tools'
import type { RunEventLog } from './events'
import type { RetrievalResult } from '../intelligence/retrieval'

export interface CodingOutcome {
  ok: boolean
  strategy: 'llm' | 'heuristic'
  filesChanged: string[]
  patchLog: string
}

const MAX_CONTENT_PER_FILE = 12_000

function readWorkspaceFile(wsPath: string, rel: string): string | null {
  try {
    const abs = path.join(wsPath, rel)
    if (!abs.startsWith(path.resolve(wsPath))) return null
    return fs.readFileSync(abs, 'utf8').slice(0, MAX_CONTENT_PER_FILE)
  } catch {
    return null
  }
}

// ------------------------------------------------------------
// LLM coding strategy
// ------------------------------------------------------------

function buildPatchPrompt(task: string, plan: PlanSchema, files: { path: string; content: string }[]): { system: string; user: string } {
  const system = `You are the coding engine of a brownfield engineering agent. You receive an approved plan and the current contents of the files to modify. You produce a unified diff that implements the plan with MINIMAL changes.

RULES:
- Produce ONLY a unified diff (git format: --- a/path, +++ b/path, @@ hunks). No prose, no markdown fences.
- Path headers must use repo-relative paths exactly as given.
- Do NOT reformat, reorder, or "improve" unrelated code. Smallest safe diff wins.
- Preserve legacy comments and workarounds that the plan says to keep.
- New files: use /dev/null as the --- side.
- Keep code style consistent with the surrounding file (indentation, quotes, naming).`

  const fileBlocks = files.map((f) => `=== FILE: ${f.path} ===\n${f.content}`).join('\n\n')
  const user = `TASK: ${task}

APPROVED PLAN:
${JSON.stringify({ objective: plan.objective, files_to_modify: plan.files_to_modify, files_to_create: plan.files_to_create, api_changes: plan.api_changes, risks: plan.risks.slice(0, 3) }, null, 2)}

CURRENT FILE CONTENTS:
${fileBlocks}

Produce the unified diff now.`
  return { system, user }
}

async function llmImplement(
  provider: LLMProvider,
  ctx: ToolContext,
  task: string,
  plan: PlanSchema,
  events: RunEventLog
): Promise<CodingOutcome> {
  const targets = [...plan.files_to_modify.slice(0, 5), ...plan.files_to_create.slice(0, 3)]
  const files = targets
    .map((rel) => ({ path: rel, content: readWorkspaceFile(ctx.workspacePath, rel) ?? '' }))
    .filter((f) => f.content || plan.files_to_create.includes(f.path))

  // files_to_create have no content yet — seed an empty content block for context
  for (const rel of plan.files_to_create) {
    if (!files.some((f) => f.path === rel)) files.push({ path: rel, content: '(new file — create from scratch)' })
  }

  let lastError = ''
  for (let attempt = 0; attempt < 3; attempt++) {
    const { system, user } = buildPatchPrompt(task, plan, files)
    const result = await provider.chat({
      role: 'coding',
      system: attempt === 0 ? system : system + `\n\nNOTE: your previous patch failed to apply:\n${lastError}\nFix the patch so it applies cleanly against the file contents above.`,
      messages: [{ role: 'user', content: user }],
      temperature: 0.1,
      maxTokens: 4000,
    })
    await events.emit('implementation', 'info', `Patch draft ${attempt + 1} received from model`, `${result.content.length} chars`, {
      data: { model: result.model, attempt: attempt + 1, usage: result.usage },
    })
    const patchResult = await invokeTool(ctx, 'apply_patch', { patch: result.content })
    if (patchResult.ok) {
      // inspect the diff
      const diff = await invokeTool(ctx, 'git_diff', {})
      const filesChanged = diff.output.split('\n').filter((l) => /^diff --git/.test(l)).map((l) => l.split(' b/')[1])
      return { ok: true, strategy: 'llm', filesChanged, patchLog: `applied on attempt ${attempt + 1}` }
    }
    lastError = patchResult.output.slice(0, 400)
    await events.warn('implementation', `Patch ${attempt + 1} failed validation`, lastError.slice(0, 300))
  }

  // Full-file strategy: models are far more reliable producing complete files
  // than exact unified diffs. Ask for complete updated files as JSON.
  const fullFileOutcome = await llmFullFileImplement(provider, ctx, task, plan, events)
  if (fullFileOutcome.ok) return fullFileOutcome

  return { ok: false, strategy: 'llm', filesChanged: [], patchLog: `patch application failed after 3 attempts: ${lastError.slice(0, 300)}` }
}

async function llmFullFileImplement(
  provider: LLMProvider,
  ctx: ToolContext,
  task: string,
  plan: PlanSchema,
  events: RunEventLog
): Promise<CodingOutcome> {
  try {
    const targets = [...plan.files_to_modify.slice(0, 4), ...plan.files_to_create.slice(0, 2)]
    const files = targets
      .map((rel) => {
        const content = readWorkspaceFile(ctx.workspacePath, rel)
        return content != null ? { path: rel, content, exists: true } : { path: rel, content: '', exists: false }
      })
      .filter((f) => f.exists || plan.files_to_create.includes(f.path))

    const system = `You are the coding engine of a brownfield engineering agent. Diff-based patching failed, so you will now produce COMPLETE updated files. Respond ONLY with a JSON object mapping file paths to complete file contents: {"<path>": "<entire new file content>"}. Preserve all unchanged code exactly. Keep style consistent. Never drop legacy comments or workarounds that the plan says to keep.`
    const user = `TASK: ${task}

APPROVED PLAN: ${plan.objective}
Files to modify: ${plan.files_to_modify.join(', ')}
Files to create: ${plan.files_to_create.join(', ')}

CURRENT FILE CONTENTS (produce complete updated versions):
${files.map((f) => `=== ${f.path}${f.exists ? '' : ' (NEW FILE)'} ===\n${f.content || '(create from scratch)'}`).join('\n\n')}

Respond with the JSON object now. Escape newlines in the JSON strings properly.`

    const result = await provider.chat({
      role: 'coding',
      system,
      messages: [{ role: 'user', content: user }],
      temperature: 0.1,
      maxTokens: 8000,
      json: true,
    })
    await events.emit('implementation', 'info', 'Full-file rewrite requested from model', `${result.content.length} chars`, {
      data: { strategy: 'full-file', model: result.model },
    })
    const { extractJson } = await import('../llm')
    const parsed = extractJson<Record<string, string>>(result.content)
    if (!parsed || typeof parsed !== 'object') {
      await events.warn('implementation', 'Full-file response not parseable JSON', String(result.content).slice(0, 200))
      return { ok: false, strategy: 'llm', filesChanged: [], patchLog: 'full-file response not JSON' }
    }

    const filesChanged: string[] = []
    const rejectedFiles: { rel: string; dropped: string[] }[] = []
    for (const [rel, content] of Object.entries(parsed)) {
      if (typeof content !== 'string' || content.length < 5) continue
      // brownfield guard: full rewrites must not silently drop legacy markers
      const original = readWorkspaceFile(ctx.workspacePath, rel) || ''
      if (original) {
        const legacyLines = original.split('\n').filter((l) => /DO NOT REMOVE|HACK|INC-\d+|workaround|deprecated|known issue|frozen contract/i.test(l) && l.trim().length > 10)
        const dropped = legacyLines.filter((l) => !content.includes(l.trim().replace(/\s+/g, ' ').slice(0, 60)))
        if (dropped.length > 0) {
          await events.warn('implementation', `Rewrite of ${rel} rejected: would remove legacy markers`, dropped.slice(0, 3).join(' | ').slice(0, 300))
          rejectedFiles.push({ rel, dropped })
          continue
        }
      }
      const tool = plan.files_to_create.includes(rel) ? 'create_file' : 'write_file'
      const res = await invokeTool(ctx, tool as any, { path: rel, content })
      if (res.ok) {
        filesChanged.push(rel)
        await events.emit('implementation', 'success', `Wrote complete file: ${rel}`, `${content.split('\n').length} lines`)
      } else {
        await events.warn('implementation', `Writing ${rel} failed`, res.output.slice(0, 200))
      }
    }

    // one correction pass for files rejected by the legacy guard
    if (rejectedFiles.length > 0) {
      await events.emit('implementation', 'info', `Requesting corrected rewrites for ${rejectedFiles.length} file(s)`, 'model must preserve the flagged legacy markers')
      const corrected = await requestCorrectedRewrite(provider, ctx, rejectedFiles, events)
      for (const [rel, content] of Object.entries(corrected)) {
        const tool = plan.files_to_create.includes(rel) ? 'create_file' : 'write_file'
        const res = await invokeTool(ctx, tool as any, { path: rel, content })
        if (res.ok) {
          filesChanged.push(rel)
          await events.emit('implementation', 'success', `Corrected rewrite applied: ${rel}`, 'legacy markers preserved this time')
        }
      }
    }
    if (filesChanged.length === 0) {
      return { ok: false, strategy: 'llm', filesChanged: [], patchLog: 'full-file strategy produced no writable files' }
    }
    const diff = await invokeTool(ctx, 'git_diff', {})
    return {
      ok: diff.output.trim() !== '' && diff.output !== '(no changes)',
      strategy: 'llm',
      filesChanged,
      patchLog: `full-file rewrite applied to ${filesChanged.length} file(s)`,
    }
  } catch (err: any) {
    await events.warn('implementation', 'Full-file strategy error', String(err?.message).slice(0, 300))
    return { ok: false, strategy: 'llm', filesChanged: [], patchLog: String(err?.message || err).slice(0, 300) }
  }
}

/** Ask the model to redo rejected rewrites, explicitly listing the legacy lines it must keep. */
async function requestCorrectedRewrite(
  provider: LLMProvider,
  ctx: ToolContext,
  rejectedFiles: { rel: string; dropped: string[] }[],
  events: RunEventLog
): Promise<Record<string, string>> {
  try {
    const system = `You are the coding engine of a brownfield engineering agent. Your previous rewrite of files was REJECTED because it removed lines that are documented legacy constraints in this repository. Produce the complete corrected file contents that INCLUDE those exact lines (and surrounding comments). Respond ONLY with JSON: {"<path>": "<complete corrected file>"}.`
    const user = rejectedFiles
      .map(({ rel, dropped }) => {
        const original = readWorkspaceFile(ctx.workspacePath, rel) || ''
        return `=== FILE: ${rel} (current, unmodified) ===\n${original}\n\nMANDATORY LINES YOU REMOVED (must be present in your output):\n${dropped.map((d) => '  ' + d.trim()).join('\n')}`
      })
      .join('\n\n')

    const result = await provider.chat({
      role: 'coding',
      system,
      messages: [{ role: 'user', content: user }],
      temperature: 0.1,
      maxTokens: 8000,
      json: true,
    })
    const { extractJson } = await import('../llm')
    const parsed = extractJson<Record<string, string>>(result.content)
    if (!parsed || typeof parsed !== 'object') return {}
    // re-verify the guard before returning
    const out: Record<string, string> = {}
    for (const { rel, dropped } of rejectedFiles) {
      const content = parsed[rel]
      if (typeof content !== 'string') continue
      const stillMissing = dropped.filter((l) => !content.includes(l.trim().replace(/\s+/g, ' ').slice(0, 60)))
      if (stillMissing.length > 0) {
        void events
        continue // still dropping markers — leave rejected
      }
      out[rel] = content
    }
    return out
  } catch {
    return {}
  }
}

// ------------------------------------------------------------
// Heuristic coding strategy — anchored edit scripts
// ------------------------------------------------------------

async function heuristicImplement(
  ctx: ToolContext,
  task: string,
  plan: PlanSchema,
  retrieval: RetrievalResult,
  events: RunEventLog
): Promise<CodingOutcome> {
  const analysis: TaskAnalysis = analyzeTask(task, retrieval)
  const filesChanged: string[] = []
  const log: string[] = []

  const track = (res: ToolResult, label: string) => {
    log.push(`${label}: ${res.output.slice(0, 120)}`)
    if (res.ok) filesChanged.push(label)
    return res
  }

  if (analysis.type === 'add_endpoint') {
    await events.emit('implementation', 'status', 'Applying deterministic endpoint pattern', `domain=${analysis.domain}`)
    const serviceFile = plan.files_to_modify.find((f) => f.includes(analysis.domain) && /services?\//.test(f)) || plan.files_to_modify[0]
    const routeFile = plan.files_to_modify.find((f) => /\/routes?\//.test(f)) || plan.files_to_modify[1]
    const entryFile = plan.files_to_modify.find((f) => /^(src\/)?(app|index|server|main)\./.test(f)) || plan.files_to_modify[2]

    // 1. service: add search<Entity> method before the return-object closer
    if (serviceFile) {
      const content = readWorkspaceFile(ctx.workspacePath, serviceFile) || ''
      const closer = findReturnObjectCloser(content)
      if (closer) {
        const method = renderSearchMethod(analysis, content)
        const res = track(await invokeTool(ctx, 'edit_file', {
          path: serviceFile,
          edits: [{ find: closer, replace: `${method}\n${closer}` }],
        }), `service:${serviceFile}`)
        void res
      } else {
        log.push(`service:${serviceFile}: could not find return-object anchor`)
      }
    }

    // 2. route handler
    if (routeFile) {
      const content = readWorkspaceFile(ctx.workspacePath, routeFile) || ''
      const anchor = findExportsCloser(content)
      if (anchor) {
        const handler = renderSearchRouteHandler(analysis)
        track(await invokeTool(ctx, 'edit_file', {
          path: routeFile,
          edits: [{ find: anchor, replace: `${handler}\n${anchor}` }],
        }), `route:${routeFile}`)
      }
    }

    // 3. entry dispatch — insert before the /:id route for this domain
    if (entryFile) {
      const content = readWorkspaceFile(ctx.workspacePath, entryFile) || ''
      const idLine = content.split('\n').find((l) => l.includes(`${analysis.domain}s`) && l.includes('getById'))
      if (idLine) {
        const dispatch = `      if (parts[1] === 'search' && parts.length === 2 && req.method === 'GET') return routes.${analysis.domain}s.search(req, res, url);\n`
        track(await invokeTool(ctx, 'edit_file', {
          path: entryFile,
          edits: [{ find: idLine, replace: dispatch + idLine }],
        }), `entry:${entryFile}`)
      } else {
        log.push(`entry:${entryFile}: no /:id dispatch anchor found for ${analysis.domain}s`)
      }
    }

    // 4. test file
    const testPath = plan.files_to_create[0] || `tests/${analysis.domain}-search.test.js`
    track(await invokeTool(ctx, 'create_file', {
      path: testPath,
      content: renderSearchTest(analysis, serviceFile),
    }), `test:${testPath}`)
  } else if (analysis.type === 'fix_race') {
    await events.emit('implementation', 'status', 'Applying deterministic race-fix pattern', 'per-order lock around the read-modify-write section')
    const serviceFile = plan.files_to_modify[0]
    if (serviceFile) {
      const content = readWorkspaceFile(ctx.workspacePath, serviceFile) || ''
      const dbAnchor = content.match(/const db = createDatabase\(dbDir\);\n/)?.[0]
      const refundSig = content.split('\n').find((l) => /async processRefund\(/.test(l))
      if (dbAnchor && refundSig) {
        const lockBlock = renderLockBlock()
        const wrapper = renderRefundWrapper(refundSig)
        const res = await invokeTool(ctx, 'edit_file', {
          path: serviceFile,
          edits: [
            { find: dbAnchor, replace: dbAnchor + lockBlock },
            { find: refundSig, replace: wrapper },
          ],
        })
        track(res, `service:${serviceFile}`)
      } else {
        log.push(`service:${serviceFile}: anchors not found (db=${!!dbAnchor}, refund=${!!refundSig})`)
      }
    }
    const testPath = plan.files_to_create[0] || 'tests/payment-race.test.js'
    track(await invokeTool(ctx, 'create_file', {
      path: testPath,
      content: renderRaceTest(serviceFile),
    }), `test:${testPath}`)
  } else {
    // generic: cannot synthesize code deterministically for unknown task shapes
    await events.warn('implementation', 'Deterministic coder cannot handle this task type', 'task type: ' + analysis.type + ' — an LLM provider is required for free-form implementation')
    return { ok: false, strategy: 'heuristic', filesChanged: [], patchLog: 'no deterministic pattern for task type ' + analysis.type }
  }

  const ok = filesChanged.length >= 2
  const diff = await invokeTool(ctx, 'git_diff', {})
  return {
    ok: ok && diff.output.trim() !== '' && diff.output !== '(no changes)',
    strategy: 'heuristic',
    filesChanged,
    patchLog: log.join('\n'),
  }
}

// ---- anchor finders ----

function findReturnObjectCloser(content: string): string | null {
  // factory pattern: `  };\n}` closing the returned service object
  // use a context-rich two-line anchor so substring collisions can't occur
  const m = [...content.matchAll(/\n([ \t]*\};\n[ \t]*\}\n)/g)]
  return m.length ? '\n' + m[m.length - 1][1] : null
}

function findExportsCloser(content: string): string | null {
  const m = content.match(/^(\s*)\};\s*$/gm)
  const last = m ? m[m.length - 1] : null
  return last || null
}

// ---- code renderers (matching legacy-shop's style) ----

function renderSearchMethod(a: TaskAnalysis, serviceContent: string): string {
  const entity = a.entity
  // find the actual list method in the service (e.g. listProducts)
  const listMethod = serviceContent.match(/\b(list[A-Z][A-Za-z]*)\s*\(/)?.[1] || `list${cap(a.domain)}s`
  return `    search${cap(entity)}(query) {
      const q = String(query || '').toLowerCase();
      return this.${listMethod}().filter((item) => {
        const name = String(item.name || '').toLowerCase();
        const sku = String(item.sku || item.id || '').toLowerCase();
        return name.includes(q) || sku.includes(q);
      });
    },`
}

function renderSearchRouteHandler(a: TaskAnalysis): string {
  return `  search(req, res, url) {
    const query = (url && url.searchParams && url.searchParams.get('q')) || '';
    const results = service().search${cap(a.entity)}(query);
    json(res, 200, { ${a.domain}s: results });
  },`
}

function renderSearchTest(a: TaskAnalysis, serviceFile: string): string {
  const rel = serviceFile ? serviceFile.replace(/^src\//, '../src/') : '../src/services/' + a.domain + 'Service'
  return `'use strict';
// Agent-generated tests for the ${a.domain} search endpoint.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { create${cap(a.domain)}Service } = require('${rel}');

function makeTempDbDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-shop-search-'));
  const products = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'products.json'), 'utf8')
  );
  fs.writeFileSync(path.join(dir, 'products.json'), JSON.stringify(products));
  return dir;
}

test('search${cap(a.entity)} matches by name, case-insensitive', () => {
  const svc = create${cap(a.domain)}Service(makeTempDbDir());
  const results = svc.search${cap(a.entity)}('mechanical');
  assert.ok(results.length >= 1);
  assert.ok(results.every((p) => p.name.toLowerCase().includes('mechanical')));
});

test('search${cap(a.entity)} matches by sku', () => {
  const svc = create${cap(a.domain)}Service(makeTempDbDir());
  const results = svc.search${cap(a.entity)}('KB-100');
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].sku, 'KB-100');
});

test('search${cap(a.entity)} returns empty array when nothing matches', () => {
  const svc = create${cap(a.domain)}Service(makeTempDbDir());
  const results = svc.search${cap(a.entity)}('zzz-no-such-thing');
  assert.deepStrictEqual(results, []);
});
`
}

function renderLockBlock(): string {
  return `
    // serialize refunds per order to close the read-modify-write race
    // (known issue since 2021; see README and paymentService header)
    const refundLocks = new Map();
    function withRefundLock(orderId, fn) {
      const prev = refundLocks.get(orderId) || Promise.resolve();
      const run = prev.then(fn, fn);
      refundLocks.set(orderId, run.then(() => {}, () => {}));
      return run;
    }
`
}

function renderRefundWrapper(originalSignature: string): string {
  return `${originalSignature}
      return withRefundLock(orderId, () => this._processRefundLocked(orderId, amountCents));
    },

    async _processRefundLocked(orderId, amountCents) {`
}

function renderRaceTest(serviceFile: string): string {
  const rel = serviceFile ? serviceFile.replace(/^src\//, '../src/') : '../src/services/paymentService'
  return `'use strict';
// Agent-generated regression test: concurrent refunds must not double-count.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { createPaymentService } = require('${rel}');

function makeTempDbDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-shop-race-'));
}

test('concurrent refunds for the same order do not double-count', async () => {
  const svc = createPaymentService(makeTempDbDir());
  await Promise.all([
    svc.processRefund(6001, 1000),
    svc.processRefund(6001, 1000),
    svc.processRefund(6001, 500),
  ]);
  assert.strictEqual(svc.totalRefunded(6001), 2500);
});

test('sequential refunds still accumulate exactly', async () => {
  const svc = createPaymentService(makeTempDbDir());
  await svc.processRefund(6002, 100);
  await svc.processRefund(6002, 200);
  assert.strictEqual(svc.totalRefunded(6002), 300);
});

test('the legacy gateway retry workaround is preserved', async () => {
  // charge exercises callGateway, which contains the retry block (INC-2231)
  const svc = createPaymentService(makeTempDbDir());
  const result = await svc.charge(7001, 100);
  assert.ok(result.txId.startsWith('vms-'));
});
`
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

// ------------------------------------------------------------
// Entry point
// ------------------------------------------------------------

export async function implement(
  provider: LLMProvider,
  ctx: ToolContext,
  task: string,
  plan: PlanSchema,
  retrieval: RetrievalResult,
  events: RunEventLog
): Promise<CodingOutcome> {
  await events.emit('implementation', 'status', 'Reading target files before patching', `${plan.files_to_modify.length} to modify, ${plan.files_to_create.length} to create`)
  // READ phase — pull each target through the tool gateway so it is logged
  for (const rel of plan.files_to_modify.slice(0, 5)) {
    await invokeTool(ctx, 'open_file', { path: rel })
  }

  let outcome: CodingOutcome
  if (provider.capabilities.freeformChat) {
    try {
      outcome = await llmImplement(provider, ctx, task, plan, events)
      if (outcome.ok) return outcome
      await events.warn('implementation', 'LLM patching failed — trying deterministic strategy', outcome.patchLog.slice(0, 300))
      const heuristic = await heuristicImplement(ctx, task, plan, retrieval, events)
      if (heuristic.ok) return heuristic
      return outcome
    } catch (err: any) {
      await events.warn('implementation', 'LLM coder error', String(err?.message).slice(0, 300))
      outcome = await heuristicImplement(ctx, task, plan, retrieval, events)
      return outcome
    }
  }
  outcome = await heuristicImplement(ctx, task, plan, retrieval, events)
  return outcome
}

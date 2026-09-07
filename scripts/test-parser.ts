// Smoke test for the symbol parser against the sample repo.
const path = require('path')
const fs = require('fs')
const REPO = path.join(__dirname, '..', 'sample-repos', 'legacy-shop')

async function main() {
  const { parseCodeFile } = await import('../src/server/intelligence/parsers')
  const targets = [
    'src/services/paymentService.js',
    'src/app.js',
    'src/db/database.js',
    'src/routes/products.js',
  ]
  for (const rel of targets) {
    const content = fs.readFileSync(path.join(REPO, rel), 'utf8')
    const parsed = parseCodeFile(rel, content, 'javascript')
    console.log(`\n=== ${rel} ===`)
    console.log('symbols:', parsed.symbols.map((s) => `${s.kind} ${s.qualifiedName} L${s.lineStart} exported=${s.exported} doc="${s.docComment.slice(0, 50).replace(/\n/g, ' ')}"`).join('\n  '))
    console.log('imports:', JSON.stringify(parsed.imports))
    console.log('calls:', [...new Set(parsed.calls.map((c) => c.name))].slice(0, 20).join(', '))
    console.log('dbTables:', JSON.stringify(parsed.dbTables))
    console.log('routes:', JSON.stringify(parsed.routes))
    console.log('exports:', parsed.exports.join(', '))
  }
}
main().catch((e) => { console.error(e); process.exit(1) })

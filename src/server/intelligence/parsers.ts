// ============================================================
// Per-language symbol & relationship extraction.
//
// Primary engine: Tree-sitter (JS/TS/TSX/Python). A regex fallback
// covers route/DB/import patterns for everything else.
// Adding a language = register a grammar in tree-sitter-loader.ts +
// (optionally) a walker here; the rest of the pipeline is language-agnostic.
// ============================================================

import { createParser } from './tree-sitter-loader'

export type SymbolKind =
  | 'class' | 'function' | 'method' | 'interface' | 'type' | 'const'
  | 'route' | 'table' | 'variable'

export interface ExtractedSymbol {
  name: string
  kind: SymbolKind
  qualifiedName: string // "<filePath>::<scope>.<name>"
  lineStart: number
  lineEnd: number
  signature: string
  exported: boolean
  docComment: string
  metadata: { parent?: string; params?: string[] }
}

export interface ImportSpec { specifier: string; line: number }

export interface CallSite { name: string; line: number; context: string }

export interface DbAccess { table: string; access: 'reads' | 'writes'; line: number }

export interface RouteDef { method: string; path: string; line: number }

export interface ParsedFile {
  symbols: ExtractedSymbol[]
  imports: ImportSpec[]
  exports: string[]
  calls: CallSite[]
  dbTables: DbAccess[]
  routes: RouteDef[]
}

function firstLine(text: string, max = 120): string {
  const line = text.split('\n')[0].trim()
  return line.length > max ? line.slice(0, max) + '…' : line
}

/** Comment immediately preceding a node (same parent). */
function precedingDoc(parent: any, node: any): string {
  if (!parent) return ''
  const siblings = parent.children || []
  const idx = siblings.indexOf(node)
  if (idx <= 0) return ''
  const lines: string[] = []
  // walk backwards over contiguous comment nodes
  for (let i = idx - 1; i >= 0; i--) {
    const sib = siblings[i]
    if (sib.type !== 'comment') {
      // blank lines are okay (decorations between), anything else stops us
      if (sib.type === 'decorator') continue
      break
    }
    const gap = node.startPosition.row - sib.endPosition.row
    if (gap > 2) break
    lines.unshift(sib.text.replace(/^\s*(\/\/|\/\*+|\*+|#)\s?/gm, '').replace(/\*\/\s*$/, '').trim())
  }
  return lines.join('\n').slice(0, 600)
}

// ------------------------------------------------------------
// JavaScript / TypeScript / TSX
// ------------------------------------------------------------

function walkJs(
  node: any,
  ctx: {
    filePath: string
    parent: any
    scope: string[]
    result: ParsedFile
    exportDepth: number
    fnDepth: number
    inModuleExports: boolean
  }
) {
  if (!node) return
  const type: string = node.type

  if (type === 'import_statement') {
    const source = node.children.find((c: any) => c.type === 'string')
    if (source) ctx.result.imports.push({ specifier: stripQuotes(source.text), line: node.startPosition.row + 1 })
    return
  }

  if (type === 'export_statement') {
    const decl = node.children.find((c: any) =>
      ['function_declaration', 'class_declaration', 'lexical_declaration', 'variable_declaration', 'interface_declaration', 'type_alias_declaration'].includes(c.type)
    )
    if (decl) {
      walkJs(decl, { ...ctx, parent: node, exportDepth: ctx.exportDepth + 1 })
      return
    }
    for (const c of node.children) {
      if (c.type === 'export_specifier') {
        const nameNode = c.childForFieldName ? c.childForFieldName('name') : null
        if (nameNode) ctx.result.exports.push(nameNode.text)
      }
      if (c.type === 'identifier' && node.children.some((x: any) => x.type === 'default')) {
        ctx.result.exports.push(c.text)
      }
    }
    return
  }

  if (type === 'call_expression') {
    const fn = node.childForFieldName?.('function')
    if (fn) {
      let name = ''
      if (fn.type === 'identifier') name = fn.text
      else if (fn.type === 'member_expression') {
        const prop = fn.childForFieldName?.('property') || fn.children.find((c: any) => c.type === 'property_identifier')
        name = prop ? prop.text : ''
      }
      if (name && !isBuiltin(name)) {
        ctx.result.calls.push({ name, line: node.startPosition.row + 1, context: ctx.scope[ctx.scope.length - 1] || '' })
      }
    }
    // require('x') is an import
    if (fn?.type === 'identifier' && fn.text === 'require') {
      const argsNode = node.childForFieldName?.('arguments')
      const arg = (argsNode?.children || node.children).find((c: any) => c.type === 'string')
      if (arg) ctx.result.imports.push({ specifier: stripQuotes(arg.text), line: node.startPosition.row + 1 })
    }
    for (const child of node.children || []) {
      walkJs(child, { ...ctx, parent: node, fnDepth: ctx.fnDepth + (fn?.type === 'arrow_function' || fn?.type === 'function_expression' ? 1 : 0) })
    }
    return
  }

  const symbolKinds: Record<string, SymbolKind> = {
    class_declaration: 'class',
    function_declaration: 'function',
    interface_declaration: 'interface',
    type_alias_declaration: 'type',
  }

  if (symbolKinds[type] && node.childForFieldName?.('name')) {
    const nameNode = node.childForFieldName('name')
    const name = nameNode.text
    const kind = symbolKinds[type]
    const parentName = ctx.scope[ctx.scope.length - 1] || ''
    const qualified = `${ctx.filePath}::${parentName ? parentName + '.' : ''}${name}`
    ctx.result.symbols.push({
      name,
      kind: kind === 'function' && parentName ? 'method' : kind,
      qualifiedName: qualified,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      signature: firstLine(node.text),
      exported: ctx.exportDepth > 0,
      docComment: precedingDoc(ctx.parent, node),
      metadata: { parent: parentName || undefined, params: extractParams(node) },
    })
    if (ctx.exportDepth > 0) ctx.result.exports.push(name)
    const body = node.childForFieldName?.('body')
    if (body) walkJs(body, { ...ctx, parent: node, scope: [name], exportDepth: 0, fnDepth: ctx.fnDepth + 1 })
    return
  }

  if (type === 'method_definition' && node.childForFieldName?.('name')) {
    const name = node.childForFieldName('name').text
    const parentName = ctx.scope[ctx.scope.length - 1] || ''
    const qualified = `${ctx.filePath}::${parentName ? parentName + '.' : ''}${name}`
    ctx.result.symbols.push({
      name,
      kind: 'method',
      qualifiedName: qualified,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      signature: firstLine(node.text),
      exported: false,
      docComment: precedingDoc(ctx.parent, node),
      metadata: { parent: parentName || undefined, params: extractParams(node) },
    })
    const body = node.childForFieldName?.('body')
    if (body) walkJs(body, { ...ctx, parent: node, scope: [...ctx.scope, name], exportDepth: 0, fnDepth: ctx.fnDepth + 1 })
    return
  }

  if (type === 'assignment_expression') {
    const lhs = node.childForFieldName?.('left')
    const rhs = node.childForFieldName?.('right')
    const isExports = lhs && (lhs.text === 'module.exports' || lhs.text.startsWith('exports.'))
    if (lhs && isExports && lhs.text.includes('.')) {
      // exports.foo = ... — single named export
      ctx.result.exports.push(lhs.text.split('.').pop())
    }
    if (rhs) walkJs(rhs, { ...ctx, parent: node, inModuleExports: isExports || ctx.inModuleExports })
    return
  }

  // const foo = () => {...} / require() / plain consts
  if (type === 'variable_declarator') {
    const nameNode = node.childForFieldName?.('name')
    const value = node.childForFieldName?.('value')
    if (nameNode && value) {
      if (value.type === 'call_expression') {
        const fn = value.childForFieldName?.('function')
        const argsNode = value.childForFieldName?.('arguments')
        const arg = (argsNode?.children || value.children).find((c: any) => c.type === 'string')
        if (fn?.type === 'identifier' && fn.text === 'require' && arg) {
          ctx.result.imports.push({ specifier: stripQuotes(arg.text), line: node.startPosition.row + 1 })
          if (nameNode.type === 'object_pattern' || nameNode.type === 'array_pattern') return
        }
      }
      const isFn = ['arrow_function', 'function_expression', 'function'].includes(value.type)
      const isClass = value.type === 'class'
      // keep consts only at module top-level or when function/class-valued
      const atModuleLevel = ctx.scope.length === 0 && ctx.fnDepth === 0
      if ((isFn || isClass || atModuleLevel) && nameNode.type === 'identifier') {
        const qualified = `${ctx.filePath}::${nameNode.text}`
        ctx.result.symbols.push({
          name: nameNode.text,
          kind: isFn ? 'function' : isClass ? 'class' : 'const',
          qualifiedName: qualified,
          lineStart: node.startPosition.row + 1,
          lineEnd: node.endPosition.row + 1,
          signature: firstLine(`${nameNode.text} = ${firstLine(value.text, 60)}`),
          exported: ctx.exportDepth > 0,
          docComment: precedingDoc(ctx.parent, node),
          metadata: {},
        })
        if (ctx.exportDepth > 0) ctx.result.exports.push(nameNode.text)
      }
      if (isFn || isClass) {
        walkJs(value, { ...ctx, parent: node, scope: [nameNode.text], exportDepth: 0, fnDepth: ctx.fnDepth + 1 })
      } else {
        walkJs(value, { ...ctx, parent: node, fnDepth: ctx.fnDepth + 1 })
      }
    }
    return
  }

  if (type === 'pair' || type === 'pair_property') {
    if (ctx.inModuleExports) {
      const key = node.childForFieldName?.('key') || node.children.find((c: any) => c.type === 'property_identifier' || c.type === 'identifier')
      if (key && /^[A-Za-z_$][\w$]*$/.test(key.text)) ctx.result.exports.push(key.text)
    }
    for (const child of node.children || []) walkJs(child, { ...ctx, parent: node })
    return
  }

  if (type === 'shorthand_property_identifier' && ctx.inModuleExports) {
    ctx.result.exports.push(node.text)
    return
  }

  // anonymous function bodies: track depth so locals are not treated as symbols
  if (type === 'arrow_function' || type === 'function_expression' || type === 'function') {
    const body = node.childForFieldName?.('body')
    if (body) walkJs(body, { ...ctx, parent: node, fnDepth: ctx.fnDepth + 1 })
    return
  }

  for (const child of node.children || []) {
    walkJs(child, { ...ctx, parent: node })
  }
}

function extractParams(node: any): string[] {
  const paramsNode = node.childForFieldName?.('parameters')
  if (!paramsNode) return []
  return (paramsNode.children || [])
    .filter((p: any) => p.type.includes('identifier') || p.type === 'shorthand_property_identifier_pattern')
    .map((p: any) => p.text)
}

// ------------------------------------------------------------
// Python
// ------------------------------------------------------------

function walkPy(node: any, ctx: { filePath: string; parent: any; scope: string[]; result: ParsedFile }) {
  if (!node) return
  const type: string = node.type

  if (type === 'import_statement') {
    for (const c of node.children) {
      if (c.type === 'dotted_name') ctx.result.imports.push({ specifier: c.text, line: node.startPosition.row + 1 })
      if (c.type === 'aliased_import' && c.children[0]?.type === 'dotted_name')
        ctx.result.imports.push({ specifier: c.children[0].text, line: node.startPosition.row + 1 })
    }
  }

  if (type === 'import_from_statement') {
    const mod = node.children.find((c: any) => c.type === 'dotted_name' || c.type === 'relative_import')
    if (mod) {
      const names = node.children.filter((c: any) => c.type === 'dotted_name' && c !== mod)
      const importedNames = names.length ? names.map((n: any) => n.text).join(',') : '*'
      ctx.result.imports.push({
        specifier: `${mod.text.includes('.') ? mod.text : mod.text}:${importedNames}`,
        line: node.startPosition.row + 1,
      })
    }
  }

  if (type === 'function_definition' && node.childForFieldName?.('name')) {
    const name = node.childForFieldName('name').text
    const parentName = ctx.scope[ctx.scope.length - 1] || ''
    const qualified = `${ctx.filePath}::${parentName ? parentName + '.' : ''}${name}`
    const params = (node.childForFieldName?.('parameters')?.children || [])
      .filter((p: any) => p.type === 'identifier')
      .map((p: any) => p.text)
    ctx.result.symbols.push({
      name,
      kind: parentName ? 'method' : 'function',
      qualifiedName: qualified,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      signature: firstLine(node.text),
      exported: !parentName,
      docComment: pythonDocstring(node) || precedingDoc(ctx.parent, node),
      metadata: { parent: parentName || undefined, params },
    })
    const body = node.childForFieldName?.('body')
    if (body) walkPy(body, { ...ctx, parent: node, scope: [...ctx.scope, name] })
    return
  }

  if (type === 'class_definition' && node.childForFieldName?.('name')) {
    const name = node.childForFieldName('name').text
    const qualified = `${ctx.filePath}::${name}`
    const bases = (node.childForFieldName?.('superclasses')?.text || '').replace(/[[\]()]/g, '')
    ctx.result.symbols.push({
      name,
      kind: 'class',
      qualifiedName: qualified,
      lineStart: node.startPosition.row + 1,
      lineEnd: node.endPosition.row + 1,
      signature: firstLine(node.text),
      exported: true,
      docComment: pythonDocstring(node) || precedingDoc(ctx.parent, node),
      metadata: { parent: bases || undefined },
    })
    const body = node.childForFieldName?.('body')
    if (body) walkPy(body, { ...ctx, parent: node, scope: [name] })
    return
  }

  if (type === 'call') {
    const fn = node.childForFieldName?.('function')
    if (fn) {
      let name = fn.text
      if (fn.type === 'attribute') {
        name = fn.childForFieldName?.('attribute')?.text || fn.text.split('.').pop() || ''
      }
      if (name && !isBuiltin(name)) {
        ctx.result.calls.push({ name, line: node.startPosition.row + 1, context: ctx.scope[ctx.scope.length - 1] || '' })
      }
    }
  }

  for (const child of node.children || []) {
    walkPy(child, { ...ctx, parent: node })
  }
}

function pythonDocstring(node: any): string {
  const body = node.childForFieldName?.('body')
  if (!body) return ''
  const first = body.children?.find((c: any) => c.type === 'expression_statement')
  if (!first) return ''
  const str = first.children?.find((c: any) => c.type === 'string')
  if (!str) return ''
  return stripQuotes(str.text).trim().slice(0, 600)
}

// ------------------------------------------------------------
// Regex fallback (routes, DB access, module.exports, SQL strings)
// ------------------------------------------------------------

const ROUTE_RE = /\b(?:app|router|server|api|fastify)\.(get|post|put|patch|delete|all)\s*\(\s*['"`]([^'"`]+)['"`]/gi
const DB_RW_RE = /\.(read|write|findOne|findAll|insert|update|remove|query)\s*\(\s*['"`]([a-zA-Z0-9_-]+)['"`]/g
const SQL_RE = /\b(SELECT\s+.+?\s+FROM|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+([a-zA-Z_][a-zA-Z0-9_.]*)/gi
const MODULE_EXPORTS_RE = /module\.exports\s*=\s*\{([^}]*)\}/s
const EXPORT_PROP_RE = /exports\.([A-Za-z_$][\w$]*)\s*=/g
const FS_JSON_RE = /(?:readFileSync|writeFileSync|readFile|writeFile)\s*\(\s*[^)]*?([a-zA-Z0-9_-]+\.json)/g

function stripQuotes(s: string): string {
  return s.replace(/^['"`]|['"`]$/g, '')
}

const BUILTINS = new Set([
  'require', 'console', 'log', 'error', 'warn', 'JSON', 'stringify', 'parse',
  'Object', 'keys', 'values', 'entries', 'assign', 'Array', 'isArray', 'from',
  'map', 'filter', 'reduce', 'forEach', 'find', 'push', 'slice', 'splice',
  'indexOf', 'includes', 'join', 'concat', 'length', 'String', 'Number',
  'Boolean', 'parseInt', 'parseFloat', 'Promise', 'then', 'catch', 'all',
  'setTimeout', 'setInterval', 'clearTimeout', 'Date', 'now', 'Math', 'random',
  'floor', 'ceil', 'round', 'min', 'max', 'abs', 'Buffer', 'process', 'env',
  'module', 'exports', 'path', 'join', 'dirname', 'resolve', 'fs', 'readFileSync',
  'writeFileSync', 'existsSync', 'mkdirSync', 'crypto', 'createHash', 'createHmac',
  'print', 'len', 'range', 'str', 'int', 'float', 'dict', 'list', 'set', 'tuple',
  'enumerate', 'zip', 'isinstance', 'getattr', 'setattr', 'super', 'type', 'self',
])

function isBuiltin(name: string): boolean {
  return BUILTINS.has(name) || name.startsWith('_')
}

function scanRegexPatterns(filePath: string, content: string, result: ParsedFile, lang: string) {
  // HTTP routes (express-style)
  if (lang === 'javascript' || lang === 'typescript' || lang === 'tsx') {
    let m: RegExpExecArray | null
    ROUTE_RE.lastIndex = 0
    while ((m = ROUTE_RE.exec(content))) {
      result.routes.push({ method: m[1].toUpperCase(), path: m[2], line: content.slice(0, m.index).split('\n').length })
    }
    // module.exports = { a, b, c }
    const me = content.match(MODULE_EXPORTS_RE)
    if (me) {
      for (const part of me[1].split(',')) {
        const name = part.split(':')[0].trim().replace(/^(\w+)\s+as\s+\w+$/, '$1')
        if (/^[A-Za-z_$][\w$]*$/.test(name)) result.exports.push(name)
      }
    }
    EXPORT_PROP_RE.lastIndex = 0
    while ((m = EXPORT_PROP_RE.exec(content))) {
      result.exports.push(m[1])
    }
  }

  // JSON-store / ORM-ish table access: db.read('users'), repo.findOne('users')...
  let m: RegExpExecArray | null
  DB_RW_RE.lastIndex = 0
  while ((m = DB_RW_RE.exec(content))) {
    const access = ['read', 'findOne', 'findAll', 'query'].includes(m[1]) ? 'reads' : 'writes'
    result.dbTables.push({ table: m[2], access, line: content.slice(0, m.index).split('\n').length })
  }

  // raw SQL table references
  SQL_RE.lastIndex = 0
  while ((m = SQL_RE.exec(content))) {
    result.dbTables.push({ table: m[2], access: /INSERT|UPDATE|DELETE/i.test(m[1]) ? 'writes' : 'reads', line: content.slice(0, m.index).split('\n').length })
  }

  // direct JSON data file access
  FS_JSON_RE.lastIndex = 0
  while ((m = FS_JSON_RE.exec(content))) {
    result.dbTables.push({ table: m[1].replace(/\.json$/, ''), access: /write/i.test(m[0]) ? 'writes' : 'reads', line: content.slice(0, m.index).split('\n').length })
  }
}

// ------------------------------------------------------------
// Entry point
// ------------------------------------------------------------

export function parseCodeFile(filePath: string, content: string, language: string): ParsedFile {
  const result: ParsedFile = { symbols: [], imports: [], exports: [], calls: [], dbTables: [], routes: [] }

  // tree-sitter pass
  const parser = createParser(language)
  if (parser) {
    try {
      const tree = parser.parse(content)
      const root = tree.rootNode
      if (language === 'python') {
        walkPy(root, { filePath, parent: null, scope: [], result })
      } else {
        walkJs(root, { filePath, parent: null, scope: [], result, exportDepth: 0, fnDepth: 0, inModuleExports: false })
      }
    } catch (err: any) {
      console.warn(`[intelligence] tree-sitter parse failed for ${filePath}: ${err?.message}`)
    }
  } else {
    regexFallbackSymbols(filePath, content, result)
  }

  // regex passes (routes, db, exports) — cheap and supplement tree-sitter
  try {
    scanRegexPatterns(filePath, content, result, language)
  } catch (err: any) {
    console.warn(`[intelligence] regex scan failed for ${filePath}: ${err?.message}`)
  }

  // dedupe imports (specifier+line) and exports (valid identifier names only)
  const seenImport = new Set<string>()
  result.imports = result.imports.filter((im) => {
    const key = `${im.specifier}:${im.line}`
    if (seenImport.has(key)) return false
    seenImport.add(key)
    return true
  })
  result.exports = [...new Set(result.exports)].filter((e) => /^[A-Za-z_$][\w$]*$/.test(e) && !['exports', 'module', 'default'].includes(e))
  // mark exported symbols mentioned in export lists
  for (const sym of result.symbols) {
    if (!sym.exported && result.exports.includes(sym.name)) sym.exported = true
  }
  // dedupe symbols by qualifiedName
  const seenSym = new Set<string>()
  result.symbols = result.symbols.filter((s) => {
    if (seenSym.has(s.qualifiedName)) return false
    seenSym.add(s.qualifiedName)
    return true
  })
  // dedupe calls (name+line)
  const seenCall = new Set<string>()
  result.calls = result.calls.filter((c) => {
    const key = `${c.name}:${c.line}`
    if (seenCall.has(key)) return false
    seenCall.add(key)
    return true
  })
  return result
}

/** Minimal symbol extraction for languages without tree-sitter grammars registered. */
function regexFallbackSymbols(filePath: string, content: string, result: ParsedFile) {
  const lines = content.split('\n')
  const patterns: { re: RegExp; kind: SymbolKind }[] = [
    { re: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: 'class' },
    { re: /^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, kind: 'function' },
    { re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>/, kind: 'function' },
    { re: /^\s*(?:export\s+)?def\s+([A-Za-z_][\w]*)\s*\(/, kind: 'function' },
    { re: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: 'interface' },
    { re: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/, kind: 'type' },
  ]
  lines.forEach((line, i) => {
    for (const { re, kind } of patterns) {
      const m = line.match(re)
      if (m) {
        const name = m[1]
        result.symbols.push({
          name,
          kind,
          qualifiedName: `${filePath}::${name}`,
          lineStart: i + 1,
          lineEnd: i + 1,
          signature: firstLine(line),
          exported: /^\s*export/.test(line),
          docComment: '',
          metadata: {},
        })
        break
      }
    }
  })
  // regex import fallback
  const importRes: RegExp[] = [
    /^\s*import\s+.*from\s+['"]([^'"]+)['"]/gm,
    /^\s*const\s+\w+\s*=\s*require\(['"]([^'"]+)['"]\)/gm,
    /^\s*import\s+['"]([^'"]+)['"]/gm,
  ]
  for (const re of importRes) {
    let m: RegExpExecArray | null
    re.lastIndex = 0
    while ((m = re.exec(content))) {
      result.imports.push({ specifier: m[1], line: content.slice(0, m.index).split('\n').length })
    }
  }
}

// Lazy Tree-sitter grammar loading. Native modules are kept external in
// next.config.ts (serverExternalPackages) and loaded via createRequire so the
// bundler never touches them. Adding a new language = register grammar here.

import { createRequire } from 'node:module'

const nodeRequire = createRequire(import.meta.url)

type Grammar = unknown

let cached: Record<string, Grammar> | null = null
let loadError: string | null = null

function requireNative(name: string): any {
  return nodeRequire(name)
}

export function getGrammars(): Record<string, Grammar> {
  if (cached) return cached
  if (loadError) return {}
  try {
    const Parser = requireNative('tree-sitter')
    const JS = requireNative('tree-sitter-javascript')
    const TS = requireNative('tree-sitter-typescript')
    const PY = requireNative('tree-sitter-python')
    cached = {
      javascript: JS,
      typescript: (TS as any).typescript ?? (TS as any).default?.typescript,
      tsx: (TS as any).tsx ?? (TS as any).default?.tsx,
      python: PY,
    }
  } catch (err: any) {
    loadError = `tree-sitter unavailable: ${err?.message}`
    console.warn('[intelligence] falling back to regex parsing:', loadError)
    cached = {}
  }
  return cached
}

export function createParser(language: string): any | null {
  const grammars = getGrammars() as Record<string, any>
  const grammar = grammars[language]
  if (!grammar) return null
  try {
    const Parser = requireNative('tree-sitter')
    const parser = new Parser()
    parser.setLanguage(grammar)
    return parser
  } catch (err: any) {
    console.warn(`[intelligence] parser init failed for ${language}:`, err?.message)
    return null
  }
}

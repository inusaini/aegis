'use client'

import { useMemo, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Network } from 'lucide-react'

const LAYER_ORDER = ['entry', 'api', 'service', 'config', 'data', 'external', 'tests']
const LAYER_LABELS: Record<string, string> = {
  entry: 'Entry points',
  api: 'API / routes',
  service: 'Services',
  config: 'Config',
  data: 'Data',
  external: 'External',
  tests: 'Tests',
}
const LAYER_COLORS: Record<string, string> = {
  entry: '#0d9488', // teal-600
  api: '#d97706', // amber-600
  service: '#7c3aed', // violet-600
  config: '#525252', // zinc-600
  data: '#059669', // emerald-600
  external: '#b91c1c', // red-700
  tests: '#0891b2', // cyan-600
}

interface MapNode { id: string; label: string; layer: string; meta?: { files?: number; symbols?: number } }
interface MapEdge { source: string; target: string; kind: string; count: number }

export function SystemMapTab({ nodes, edges }: { nodes: MapNode[]; edges: MapEdge[] }) {
  const [hover, setHover] = useState<string | null>(null)

  const layout = useMemo(() => {
    if (!nodes.length) return null
    const width = 1100
    const nodeMap = new Map<string, { x: number; y: number; node: MapNode }>()
    const layers = LAYER_ORDER.filter((l) => nodes.some((n) => n.layer === l))

    layers.forEach((layer, li) => {
      const layerNodes = nodes.filter((n) => n.layer === layer)
      const rowY = 50 + li * 110
      const spacing = Math.min(190, width / Math.max(layerNodes.length, 1))
      const startX = Math.max(60, (width - spacing * (layerNodes.length - 1)) / 2)
      layerNodes.forEach((n, i) => {
        nodeMap.set(n.id, { x: startX + i * spacing, y: rowY, node: n })
      })
    })

    const height = 90 + layers.length * 110
    return { nodeMap, width, height, layers }
  }, [nodes, edges])

  if (!nodes.length) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <Network className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">System map appears after repository analysis.</p>
        </CardContent>
      </Card>
    )
  }
  if (!layout) return null

  const { nodeMap, width, height, layers } = layout
  const adjacent = (id: string) => {
    const out = new Set(edges.filter((e) => e.source === id).map((e) => e.target))
    const inn = new Set(edges.filter((e) => e.target === id).map((e) => e.source))
    return { out, inn }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Network className="h-4 w-4" />System map
            <span className="text-xs font-normal text-muted-foreground ml-2">
              {nodes.length} modules · {edges.length} dependency edges · hover to highlight
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <svg viewBox={`0 0 ${width} ${height}`} className="min-w-[880px] w-full" role="img" aria-label="Repository system map">
              {/* layer labels */}
              {layers.map((layer, li) => (
                <text key={layer} x={12} y={54 + li * 110} className="fill-muted-foreground" fontSize={10} fontWeight={600}>
                  {LAYER_LABELS[layer] || layer}
                </text>
              ))}

              {/* edges */}
              {edges.map((e, i) => {
                const s = nodeMap.get(e.source)
                const t = nodeMap.get(e.target)
                if (!s || !t) return null
                const active = hover === e.source || hover === e.target
                const midY = (s.y + t.y) / 2
                const path = `M ${s.x} ${s.y + 16} C ${s.x} ${midY}, ${t.x} ${midY}, ${t.x} ${t.y - 16}`
                return (
                  <path
                    key={i}
                    d={path}
                    fill="none"
                    stroke={active ? '#0d9488' : 'currentColor'}
                    className={active ? 'opacity-100' : 'opacity-15'}
                    strokeWidth={active ? 2 : 1.2}
                  />
                )
              })}

              {/* nodes */}
              {[...nodeMap.entries()].map(([id, { x, y, node }]) => {
                const color = LAYER_COLORS[node.layer] || '#525252'
                const active = hover === id
                const { out, inn } = adjacent(id)
                const dim = hover && !active && !out.has(hover) && !inn.has(hover)
                const label = node.label.length > 18 ? node.label.slice(0, 17) + '…' : node.label
                return (
                  <g
                    key={id}
                    transform={`translate(${x}, ${y})`}
                    onMouseEnter={() => setHover(id)}
                    onMouseLeave={() => setHover(null)}
                    className="cursor-pointer"
                    opacity={dim ? 0.35 : 1}
                  >
                    <rect
                      x={-58} y={-16} width={116} height={32} rx={7}
                      fill={active ? color : `${color}22`}
                      stroke={color}
                      strokeWidth={active ? 2 : 1.2}
                    />
                    <text textAnchor="middle" y={5} fontSize={11} fontWeight={600} fill={active ? '#fff' : color} className="font-mono">
                      {label}
                    </text>
                    {node.meta?.files ? (
                      <text textAnchor="middle" y={-22} fontSize={9} className="fill-muted-foreground">
                        {node.meta.files} file{node.meta.files > 1 ? 's' : ''}
                      </text>
                    ) : null}
                  </g>
                )
              })}
            </svg>
          </div>
          <div className="flex flex-wrap gap-2 pt-2">
            {layers.map((l) => (
              <Badge key={l} variant="outline" className="text-xs" style={{ color: LAYER_COLORS[l], borderColor: `${LAYER_COLORS[l]}55` }}>
                {LAYER_LABELS[l] || l}
              </Badge>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

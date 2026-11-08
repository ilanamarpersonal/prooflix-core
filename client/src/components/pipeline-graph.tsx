import { useMemo } from "react"

import { STATUS_STYLE } from "@/components/status-badge"
import { TaskActionsMenu, type TaskAction } from "@/components/task-actions-menu"
import { TaskTypeIcon } from "@/components/task-type-icon"
import type { GraphEdge, GraphNode, RunStatus } from "@/lib/types"
import { cn } from "@/lib/utils"

const NODE_W = 208
const NODE_H = 64
const GAP_X = 64
const GAP_Y = 16
const PAD = 8

export type { TaskAction }

interface Placed extends GraphNode {
  x: number
  y: number
}

/** Left-to-right layered layout: a node's column is its longest path from a root. */
function layout(nodes: GraphNode[], edges: GraphEdge[]) {
  const deps = new Map<string, string[]>(nodes.map((n) => [n.key, []]))
  for (const e of edges) deps.get(e.target)?.push(e.source)

  const level = new Map<string, number>()
  const visiting = new Set<string>()
  const levelOf = (key: string): number => {
    if (level.has(key)) return level.get(key)!
    if (visiting.has(key)) return 0 // cycle guard; the server rejects cycles anyway
    visiting.add(key)
    const l = Math.max(-1, ...(deps.get(key) ?? []).map(levelOf)) + 1
    visiting.delete(key)
    level.set(key, l)
    return l
  }
  nodes.forEach((n) => levelOf(n.key))

  const columns: GraphNode[][] = []
  for (const n of nodes) (columns[level.get(n.key)!] ??= []).push(n)

  const placed = new Map<string, Placed>()
  columns.forEach((col, ci) =>
    col.forEach((n, ri) =>
      placed.set(n.key, { ...n, x: PAD + ci * (NODE_W + GAP_X), y: PAD + ri * (NODE_H + GAP_Y) }),
    ),
  )
  const rows = Math.max(1, ...columns.map((c) => c.length))
  return {
    placed,
    width: PAD * 2 + columns.length * NODE_W + Math.max(0, columns.length - 1) * GAP_X,
    height: PAD * 2 + rows * NODE_H + (rows - 1) * GAP_Y,
  }
}

export function PipelineGraph({
  nodes,
  edges,
  statuses,
  selected,
  onSelect,
  actions,
}: {
  nodes: GraphNode[]
  edges: GraphEdge[]
  statuses?: Record<string, RunStatus>
  selected?: string | null
  onSelect?: (key: string) => void
  /** The entries of each task's ⋯ menu (open details, source code, sub-pipeline …). */
  actions?: (node: GraphNode) => TaskAction[]
}) {
  const { placed, width, height } = useMemo(() => layout(nodes, edges), [nodes, edges])

  return (
    <div className="bg-muted/30 overflow-auto rounded-lg border p-2">
      <div className="relative" style={{ width, height }}>
        <svg className="absolute inset-0" width={width} height={height} aria-hidden>
          <defs>
            <marker
              id="arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto"
            >
              <path d="M0,0 L10,5 L0,10 z" className="fill-muted-foreground/60" />
            </marker>
          </defs>
          {edges.map((e) => {
            const s = placed.get(e.source)
            const t = placed.get(e.target)
            if (!s || !t) return null
            const x1 = s.x + NODE_W
            const y1 = s.y + NODE_H / 2
            const x2 = t.x - 2
            const y2 = t.y + NODE_H / 2
            const mid = (x1 + x2) / 2
            return (
              <path
                key={`${e.source}->${e.target}`}
                d={`M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`}
                className="stroke-muted-foreground/50 fill-none"
                strokeWidth={1.5}
                markerEnd="url(#arrow)"
              />
            )
          })}
        </svg>

        {[...placed.values()].map((n) => {
          const status = statuses?.[n.key]
          const tone = status ? STATUS_STYLE[status] : null
          return (
            <div
              key={n.key}
              role="button"
              tabIndex={0}
              onClick={() => onSelect?.(n.key)}
              onKeyDown={(ev) => ev.key === "Enter" && onSelect?.(n.key)}
              className={cn(
                "bg-card absolute flex cursor-pointer items-center gap-2 rounded-lg border px-3 shadow-xs transition-shadow hover:shadow-md",
                selected === n.key && "ring-ring ring-2",
                tone && "border-l-4",
                tone?.className,
              )}
              style={{ left: n.x, top: n.y, width: NODE_W, height: NODE_H }}
            >
              <TaskTypeIcon type={n.type} className="text-muted-foreground size-4 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="text-foreground truncate text-sm font-medium">{n.key}</div>
                <div className="text-muted-foreground truncate text-xs">
                  {n.type === "pipeline" ? `↳ ${n.pipeline}` : (n.description ?? n.type)}
                </div>
              </div>
              {tone && (
                <tone.icon className={cn("size-4 shrink-0", status === "RUNNING" && "animate-spin")} />
              )}
              {actions && <TaskActionsMenu taskKey={n.key} actions={actions(n)} className="-mr-1.5 size-6" />}
            </div>
          )
        })}
      </div>
    </div>
  )
}

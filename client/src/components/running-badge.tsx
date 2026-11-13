import { Link } from "react-router"
import { Loader2 } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { TERMINAL_STATUSES, type Run } from "@/lib/types"
import { cn, formatDateTime } from "@/lib/utils"

export const isRunActive = (r: Run) => !TERMINAL_STATUSES.includes(r.status)

/** Runs still going, grouped by pipeline id (newest first, as the runs list is). */
export function activeRunsByPipeline(runs: Run[] | undefined): Map<string, Run[]> {
  const out = new Map<string, Run[]>()
  for (const r of runs ?? []) {
    if (!isRunActive(r)) continue
    const list = out.get(r.pipeline) ?? []
    list.push(r)
    out.set(r.pipeline, list)
  }
  return out
}

/** "running" with a spinner, linking to the newest active run; nothing when none are going. */
export function RunningBadge({ runs, className }: { runs: Run[] | undefined; className?: string }) {
  if (!runs?.length) return null
  const newest = runs[0]
  const label = runs.length > 1 ? `${runs.length} running` : newest.status === "PENDING" ? "starting" : "running"
  return (
    <Badge
      variant="outline"
      className={cn("text-status-running border-status-running/40 bg-status-running/10 gap-1", className)}
      asChild
    >
      <Link
        to={`/runs/${newest.id}`}
        title={`Run ${newest.id}, started ${formatDateTime(newest.started_at ?? newest.created_at)}${
          newest.depth > 0 ? " (as a sub-pipeline)" : ""
        }`}
      >
        <Loader2 className="animate-spin" />
        {label}
      </Link>
    </Badge>
  )
}

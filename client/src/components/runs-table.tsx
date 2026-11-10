import { Link } from "react-router"
import { AlarmClock, CornerDownRight, MousePointerClick } from "lucide-react"

import { Pager } from "@/components/pager"
import { StatusBadge } from "@/components/status-badge"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { Run } from "@/lib/types"
import { usePagination } from "@/lib/use-pagination"
import { cn, formatDateTime, formatDuration } from "@/lib/utils"

export function RunsTable({
  runs,
  loading,
  showPipeline = true,
  pageSize = 25,
  fill = false,
}: {
  runs?: Run[]
  loading?: boolean
  showPipeline?: boolean
  pageSize?: number
  /** on md+ screens, stretch to the parent's height and scroll inside it */
  fill?: boolean
}) {
  const pager = usePagination(runs, pageSize)
  if (loading) return <Skeleton className="h-40 w-full" />
  if (!runs?.length) {
    return <p className="text-muted-foreground py-8 text-center text-sm">No runs yet.</p>
  }
  return (
    <div className={cn(fill && "flex min-h-0 flex-col md:h-full")}>
      <Table containerClassName={cn("max-h-[60vh] overflow-y-auto", fill && "md:max-h-none md:min-h-0 md:flex-1")}>
        <TableHeader className="bg-card sticky top-0 z-10 shadow-[inset_0_-1px_0_var(--border)]">
          <TableRow>
            <TableHead>Run</TableHead>
            {showPipeline && <TableHead>Pipeline</TableHead>}
            <TableHead>Status</TableHead>
            <TableHead>Trigger</TableHead>
            <TableHead>Started</TableHead>
            <TableHead>Duration</TableHead>
            <TableHead>Tasks</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {pager.items.map((run) => {
            const tasks = Object.values(run.tasks)
            const done = tasks.filter((t) => t.status === "SUCCEEDED").length
            return (
              <TableRow key={run.id}>
                <TableCell>
                  <Link to={`/runs/${run.id}`} className="font-mono text-sm hover:underline">
                    {run.id}
                  </Link>
                </TableCell>
                {showPipeline && (
                  <TableCell>
                    <Link to={`/pipelines/${run.pipeline}`} className="hover:underline">
                      {run.pipeline_name ?? run.pipeline}
                    </Link>
                  </TableCell>
                )}
                <TableCell>
                  <StatusBadge status={run.status} />
                </TableCell>
                <TableCell className="text-muted-foreground text-xs">
                  <TriggerLabel run={run} />
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {formatDateTime(run.started_at ?? run.created_at)}
                </TableCell>
                <TableCell className="text-muted-foreground">{formatDuration(run.started_at, run.ended_at)}</TableCell>
                <TableCell className="text-muted-foreground">
                  {done}/{tasks.length}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
      <Pager pagination={pager} label="runs" />
    </div>
  )
}

/** What started a run: the schedule, a person, or a parent pipeline. */
function TriggerLabel({ run }: { run: Run }) {
  if (run.trigger === "schedule")
    return (
      <span className="inline-flex items-center gap-1" title={`due ${formatDateTime(run.scheduled_for)}`}>
        <AlarmClock className="text-primary size-3.5" /> scheduled
      </span>
    )
  if (run.trigger === "pipeline" || run.parent_run_id)
    return (
      <span className="inline-flex items-center gap-1">
        <CornerDownRight className="size-3.5" /> sub-pipeline
      </span>
    )
  return (
    <span className="inline-flex items-center gap-1">
      <MousePointerClick className="size-3.5" /> manual
    </span>
  )
}

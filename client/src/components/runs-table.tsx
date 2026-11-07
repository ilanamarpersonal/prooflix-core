import { Link } from "react-router"

import { StatusBadge } from "@/components/status-badge"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { Run } from "@/lib/types"
import { formatDateTime, formatDuration } from "@/lib/utils"

export function RunsTable({
  runs,
  loading,
  showPipeline = true,
}: {
  runs?: Run[]
  loading?: boolean
  showPipeline?: boolean
}) {
  if (loading) return <Skeleton className="h-40 w-full" />
  if (!runs?.length) {
    return <p className="text-muted-foreground py-8 text-center text-sm">No runs yet.</p>
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Run</TableHead>
          {showPipeline && <TableHead>Pipeline</TableHead>}
          <TableHead>Status</TableHead>
          <TableHead>Started</TableHead>
          <TableHead>Duration</TableHead>
          <TableHead>Tasks</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map((run) => {
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
              <TableCell className="text-muted-foreground">{formatDateTime(run.started_at ?? run.created_at)}</TableCell>
              <TableCell className="text-muted-foreground">{formatDuration(run.started_at, run.ended_at)}</TableCell>
              <TableCell className="text-muted-foreground">
                {done}/{tasks.length}
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

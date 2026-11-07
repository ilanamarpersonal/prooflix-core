import { Link } from "react-router"
import { ArrowUpRight } from "lucide-react"

import { JsonView } from "@/components/json-view"
import { StatusBadge } from "@/components/status-badge"
import { TaskTypeIcon } from "@/components/task-type-icon"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import type { TaskRun } from "@/lib/types"
import { formatDateTime, formatDuration } from "@/lib/utils"

export function TaskRunPanel({ task }: { task: TaskRun }) {
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <TaskTypeIcon type={task.type} /> {task.key}
          <StatusBadge status={task.status} />
        </CardTitle>
        <CardDescription>
          {task.type === "pipeline" ? `Sub-pipeline ${task.pipeline}` : `${task.type} task`}
          {task.max_attempts > 1 && ` · attempt ${task.attempt} of ${task.max_attempts}`}
          {" · "}
          {formatDateTime(task.started_at)} · {formatDuration(task.started_at, task.ended_at)}
        </CardDescription>
        {task.child_run_id && (
          <CardAction>
            <Button variant="outline" size="sm" asChild>
              <Link to={`/runs/${task.child_run_id}`}>
                Open sub-run <ArrowUpRight />
              </Link>
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="grid min-w-0 gap-4 [&>*]:min-w-0">
        {task.error && (
          <div>
            <h4 className="mb-1 text-sm font-medium">Error</h4>
            <JsonView value={task.error} className="text-status-failed whitespace-pre-wrap" />
          </div>
        )}
        <div>
          <h4 className="mb-1 text-sm font-medium">Output</h4>
          <JsonView value={task.output} />
        </div>
        <div>
          <h4 className="mb-1 text-sm font-medium">Logs</h4>
          {task.logs.length ? (
            <JsonView value={task.logs.join("\n")} className="max-h-96" />
          ) : (
            <span className="text-muted-foreground text-sm">No log lines</span>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

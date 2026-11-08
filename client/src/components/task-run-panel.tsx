import { Link } from "react-router"
import { Loader2 } from "lucide-react"

import { StatusBadge } from "@/components/status-badge"
import { TaskActionsMenu, type TaskAction } from "@/components/task-actions-menu"
import { TaskTypeIcon } from "@/components/task-type-icon"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import type { RunTree, TaskRun } from "@/lib/types"
import { formatDateTime, formatDuration } from "@/lib/utils"

// Lines Prooflix writes itself (see server/prooflix/engine/executor.py), not task output.
const ENGINE_LINE =
  /^(Calling \S+:\S+|\$ .*|Started sub-pipeline '.*' as run \w+|Sub-pipeline run \w+ succeeded|Retry attempt \d+ of \d+|ERROR .*)$/

/** What a task printed: log lines without timestamps and without Prooflix's own lines. */
export function printedLines(task: TaskRun): string[] {
  return task.logs
    .map((line) => line.replace(/^\d\d:\d\d:\d\d /, ""))
    .filter((line) => !ENGINE_LINE.test(line))
}

/** Plain text of a value: strings as they are, other values as short readable text. */
export function plainText(value: unknown): string {
  if (value === null || value === undefined) return ""
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (Array.isArray(value)) return value.map(plainText).join(", ")
  return Object.entries(value as Record<string, unknown>)
    .map(([k, v]) => `${k}: ${plainText(v)}`)
    .join(", ")
}

function Printout({ task }: { task: TaskRun }) {
  const running = task.status === "RUNNING" || task.status === "PENDING"
  const lines = printedLines(task)
  if (!lines.length) {
    return (
      <div className="text-muted-foreground flex items-center gap-2 text-sm">
        {running ? (
          <>
            <Loader2 className="size-4 animate-spin" /> Waiting for output…
          </>
        ) : (
          "No output"
        )}
      </div>
    )
  }
  return (
    <pre className="max-h-[28rem] overflow-auto rounded-md bg-zinc-950 p-3 font-mono text-sm leading-relaxed whitespace-pre-wrap text-zinc-100">
      {lines.join("\n")}
      {running && <Loader2 className="mt-1 size-3.5 animate-spin text-zinc-500" />}
    </pre>
  )
}

export function TaskRunPanel({
  task,
  childRun,
  actions,
}: {
  task: TaskRun
  childRun?: RunTree
  /** entries of the ⋯ menu on the right of the task's header */
  actions?: TaskAction[]
}) {
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
        {actions && actions.length > 0 && (
          <CardAction>
            <TaskActionsMenu taskKey={task.key} actions={actions} />
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="grid min-w-0 gap-4 [&>*]:min-w-0">
        {task.error && <p className="text-status-failed text-sm whitespace-pre-wrap">{task.error}</p>}

        {/* A sub-pipeline's output is what its own tasks printed */}
        {childRun ? (
          <div className="grid gap-3">
            {Object.values(childRun.tasks).map((t) => (
              <div key={t.key} className="grid gap-2">
                <div className="flex items-center gap-2 text-sm">
                  <TaskTypeIcon type={t.type} />
                  <span className="font-medium">{t.key}</span>
                  <StatusBadge status={t.status} />
                  {t.child_run_id && (
                    <Link
                      to={`/runs/${t.child_run_id}`}
                      className="text-muted-foreground ml-auto text-xs hover:underline"
                    >
                      open sub-run
                    </Link>
                  )}
                </div>
                {t.error && <p className="text-status-failed text-sm whitespace-pre-wrap">{t.error}</p>}
                <Printout task={t} />
              </div>
            ))}
          </div>
        ) : (
          <Printout task={task} />
        )}
      </CardContent>
    </Card>
  )
}

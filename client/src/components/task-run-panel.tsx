import { Link } from "react-router"
import { ArrowUpRight, Loader2 } from "lucide-react"

import { JsonView } from "@/components/json-view"
import { StatusBadge } from "@/components/status-badge"
import { TaskTypeIcon } from "@/components/task-type-icon"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import type { RunTree, TaskRun } from "@/lib/types"
import { formatDateTime, formatDuration } from "@/lib/utils"

/** Log lines are "HH:MM:SS message"; show the time dimmed next to the text. */
function Printout({ task }: { task: TaskRun }) {
  const running = task.status === "RUNNING" || task.status === "PENDING"
  if (!task.logs.length) {
    return (
      <div className="text-muted-foreground flex items-center gap-2 text-sm">
        {running ? (
          <>
            <Loader2 className="size-4 animate-spin" /> Waiting for output…
          </>
        ) : (
          "No printout"
        )}
      </div>
    )
  }
  return (
    <pre className="max-h-[28rem] overflow-auto rounded-md bg-zinc-950 p-3 font-mono text-xs leading-relaxed text-zinc-100">
      {task.logs.map((line, i) => {
        const m = /^(\d\d:\d\d:\d\d) (.*)$/s.exec(line)
        return (
          <div key={i} className="whitespace-pre-wrap">
            {m ? (
              <>
                <span className="text-zinc-500 select-none">{m[1]} </span>
                {m[2]}
              </>
            ) : (
              line
            )}
          </div>
        )
      })}
      {running && <Loader2 className="mt-1 size-3.5 animate-spin text-zinc-500" />}
    </pre>
  )
}

export function TaskRunPanel({ task, childRun }: { task: TaskRun; childRun?: RunTree }) {
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
          <h4 className="mb-1 text-sm font-medium">Printout</h4>
          <Printout task={task} />
        </div>

        {/* A sub-pipeline's own tasks, each with its printout */}
        {childRun && (
          <div className="grid gap-3">
            <h4 className="text-sm font-medium">
              Tasks in {childRun.pipeline_name ?? childRun.pipeline}
            </h4>
            {Object.values(childRun.tasks).map((t) => (
              <div key={t.key} className="rounded-md border p-3">
                <div className="mb-2 flex items-center gap-2 text-sm">
                  <TaskTypeIcon type={t.type} />
                  <span className="font-medium">{t.key}</span>
                  <StatusBadge status={t.status} />
                  {t.child_run_id && (
                    <Link to={`/runs/${t.child_run_id}`} className="text-muted-foreground ml-auto text-xs hover:underline">
                      open sub-run
                    </Link>
                  )}
                </div>
                {t.error && <p className="text-status-failed mb-2 font-mono text-xs">{t.error}</p>}
                <Printout task={t} />
              </div>
            ))}
          </div>
        )}

        <div>
          <h4 className="mb-1 text-sm font-medium">Output</h4>
          <JsonView value={task.output} />
        </div>
      </CardContent>
    </Card>
  )
}

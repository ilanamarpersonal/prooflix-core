import { useEffect, useRef, useState } from "react"
import { ArrowDownToLine, Loader2 } from "lucide-react"

import { STATUS_STYLE } from "@/components/status-badge"
import { printedLines } from "@/components/task-run-panel"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { TERMINAL_STATUSES, type RunTree, type TaskRun } from "@/lib/types"
import { cn } from "@/lib/utils"

interface Section {
  task: TaskRun
  depth: number // 0 for the run's own tasks, 1 for a sub-pipeline's, ...
  id: string
}

// tasks that started first come first; ones not started yet keep the pipeline's order, at the end
const byStart = (a: TaskRun, b: TaskRun) =>
  a.started_at && b.started_at ? (a.started_at < b.started_at ? -1 : 1) : a.started_at ? -1 : b.started_at ? 1 : 0

/** Every task of a run in the order they ran, each sub-pipeline's tasks right after the task that called it. */
function sections(run: RunTree, depth = 0): Section[] {
  return Object.values(run.tasks)
    .sort(byStart)
    .flatMap((task) => {
      const child = task.child_run_id ? run.children.find((c) => c.id === task.child_run_id) : undefined
      return [{ task, depth, id: `${run.id}/${task.key}` }, ...(child ? sections(child, depth + 1) : [])]
    })
}

const NEAR_BOTTOM_PX = 40

/**
 * What every task of a run printed, in one place and updating live: while the run
 * is going it keeps the newest line in view, unless you scroll up to read.
 */
export function RunOutput({ run }: { run: RunTree }) {
  const live = !TERMINAL_STATUSES.includes(run.status)
  const all = sections(run)
  const box = useRef<HTMLDivElement>(null)
  const [follow, setFollow] = useState(true)
  const size = all.reduce((n, s) => n + s.task.logs.length + (s.task.status === "RUNNING" ? 1 : 0), 0)

  useEffect(() => {
    const el = box.current
    if (el && live && follow) el.scrollTop = el.scrollHeight
  }, [size, live, follow, all.length])

  const onScroll = () => {
    const el = box.current
    if (el) setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX)
  }

  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Output
          {live && (
            <span className="text-status-running flex items-center gap-1 text-xs font-normal">
              <Loader2 className="size-3.5 animate-spin" /> live
            </span>
          )}
        </CardTitle>
        <CardDescription>What each task printed, in the order they ran. Click a task above to see only its own.</CardDescription>
        {live && !follow && (
          <CardAction>
            <Button variant="outline" size="sm" onClick={() => setFollow(true)}>
              <ArrowDownToLine /> Follow
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent>
        <div
          ref={box}
          onScroll={onScroll}
          className="max-h-[32rem] overflow-auto rounded-md bg-zinc-950 p-3 font-mono text-sm leading-relaxed text-zinc-100"
          aria-live="polite"
        >
          {all.map(({ task, depth, id }) => {
            const started = !!task.started_at
            const running = task.status === "RUNNING"
            const lines = printedLines(task)
            const Icon = STATUS_STYLE[task.status].icon
            return (
              <section key={id} style={{ paddingLeft: depth * 20 }} className="mb-3 last:mb-0">
                <div className={cn("flex items-center gap-1.5 text-xs", started ? "text-zinc-400" : "text-zinc-600")}>
                  <Icon className={cn("size-3.5", STATUS_STYLE[task.status].className.split(" ")[0], running && "animate-spin")} />
                  <span className="font-semibold text-zinc-200">{task.key}</span>
                  <span>
                    {task.type === "pipeline" ? `sub-pipeline ${task.pipeline}` : task.type} · {task.status.toLowerCase()}
                  </span>
                </div>
                {task.error && <div className="whitespace-pre-wrap text-red-400">{task.error}</div>}
                {lines.length > 0 && <div className="whitespace-pre-wrap">{lines.join("\n")}</div>}
                {running && task.type !== "pipeline" && (
                  <div className="flex items-center gap-1.5 text-zinc-500">
                    <Loader2 className="size-3.5 animate-spin" /> {lines.length ? "" : "waiting for output…"}
                  </div>
                )}
              </section>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}

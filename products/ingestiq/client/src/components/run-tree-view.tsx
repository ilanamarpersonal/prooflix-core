import { Link } from "react-router"

import { STATUS_STYLE } from "@/components/status-badge"
import { TaskTypeIcon } from "@/components/task-type-icon"
import type { RunTree } from "@/lib/types"
import { cn } from "@/lib/utils"

/** Nested view of a run, its tasks and every sub-pipeline run below them. */
export function RunTreeView({ tree, currentRunId }: { tree: RunTree; currentRunId: string }) {
  return (
    <ul className="text-sm">
      <RunNode tree={tree} currentRunId={currentRunId} />
    </ul>
  )
}

function StatusIcon({ status }: { status: RunTree["status"] }) {
  const { icon: Icon, className } = STATUS_STYLE[status]
  return <Icon className={cn("size-3.5 shrink-0", className, status === "RUNNING" && "animate-spin")} />
}

function RunNode({ tree, currentRunId }: { tree: RunTree; currentRunId: string }) {
  const childByTask = new Map(tree.children.map((c) => [c.parent_task_key, c]))
  return (
    <li>
      <Link
        to={`/runs/${tree.id}`}
        className={cn(
          "hover:bg-accent flex items-center gap-1.5 rounded px-1.5 py-1",
          tree.id === currentRunId && "bg-accent font-medium",
        )}
      >
        <StatusIcon status={tree.status} />
        <span className="truncate">{tree.pipeline_name ?? tree.pipeline}</span>
        <span className="text-muted-foreground ml-auto font-mono text-xs">{tree.id.slice(0, 6)}</span>
      </Link>
      <ul className="border-border ml-3 border-l pl-2">
        {Object.values(tree.tasks).map((task) => {
          const child = childByTask.get(task.key)
          return (
            <li key={task.key}>
              <div className="text-muted-foreground flex items-center gap-1.5 px-1.5 py-0.5">
                <StatusIcon status={task.status} />
                <TaskTypeIcon type={task.type} className="size-3.5" />
                <span className="truncate">{task.key}</span>
              </div>
              {child && (
                <ul className="ml-3 pl-2">
                  <RunNode tree={child} currentRunId={currentRunId} />
                </ul>
              )}
            </li>
          )
        })}
      </ul>
    </li>
  )
}

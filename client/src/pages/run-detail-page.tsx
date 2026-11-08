import { useMemo, useState } from "react"
import { Link, Navigate, useNavigate, useParams } from "react-router"
import { Ban, List, RotateCw } from "lucide-react"

import { ErrorAlert } from "@/components/error-alert"
import { JsonView } from "@/components/json-view"
import { PageHeader } from "@/components/page-header"
import { PipelineGraph } from "@/components/pipeline-graph"
import { RunTreeView } from "@/components/run-tree-view"
import { StatusBadge } from "@/components/status-badge"
import { TaskRunPanel } from "@/components/task-run-panel"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { useCancelRun, usePipelines, useRunTree, useStartRun } from "@/lib/api"
import { TERMINAL_STATUSES, type GraphEdge, type GraphNode, type RunStatus } from "@/lib/types"
import { formatDateTime, formatDuration } from "@/lib/utils"

export function RunDetailPage() {
  const { runId = "" } = useParams()
  const navigate = useNavigate()
  const { data: run, isLoading, error } = useRunTree(runId)
  const cancel = useCancelRun()
  const rerun = useStartRun()
  const [picked, setPicked] = useState<string | null>(null)
  const pipelines = usePipelines()

  const graph = useMemo(() => {
    const tasks = Object.values(run?.tasks ?? {})
    const nodes: GraphNode[] = tasks.map((t) => ({
      key: t.key,
      type: t.type,
      pipeline: t.pipeline,
    }))
    const edges: GraphEdge[] = tasks.flatMap((t) => t.depends_on.map((d) => ({ source: d, target: t.key })))
    const statuses = Object.fromEntries(tasks.map((t) => [t.key, t.status])) as Record<string, RunStatus>
    return { nodes, edges, statuses }
  }, [run])

  if (isLoading || pipelines.isLoading) return <Skeleton className="h-96 w-full" />
  // A run of a pipeline that is no longer in the workspace: back to the pipelines list.
  if (run && pipelines.data && !pipelines.data.some((p) => p.id === run.pipeline)) {
    return <Navigate to="/pipelines" replace />
  }
  if (error || !run) return <ErrorAlert title="Could not load run" error={error} />

  const active = !TERMINAL_STATUSES.includes(run.status)
  const tasks = Object.values(run.tasks)
  // Default selection: the running task, else the first failed one, else the
  // task that started last, so its printout is shown without a click.
  const lastStarted = [...tasks]
    .filter((t) => t.started_at)
    .sort((a, b) => (a.started_at! < b.started_at! ? 1 : -1))[0]
  const selectedKey =
    picked ??
    tasks.find((t) => t.status === "RUNNING")?.key ??
    tasks.find((t) => t.status === "FAILED")?.key ??
    lastStarted?.key ??
    tasks[0]?.key ??
    null
  const selected = selectedKey ? run.tasks[selectedKey] : undefined

  return (
    <>
      <PageHeader
        eyebrow={
          run.parent_run_id ? (
            <>
              <Link to={`/runs/${run.parent_run_id}`} className="hover:underline">
                Parent run {run.parent_run_id}
              </Link>
              {" › task "}
              <span className="font-mono">{run.parent_task_key}</span>
            </>
          ) : (
            <Link to="/runs" className="hover:underline">
              Runs
            </Link>
          )
        }
        title={
          <span className="flex items-center gap-3">
            <Link to={`/pipelines/${run.pipeline}`} className="hover:underline">
              {run.pipeline_name ?? run.pipeline}
            </Link>
            <StatusBadge status={run.status} />
          </span>
        }
        description={
          <>
            Run <span className="font-mono">{run.id}</span> · started {formatDateTime(run.started_at)} ·{" "}
            {formatDuration(run.started_at, run.ended_at)}
            {run.depth > 0 && ` · nesting depth ${run.depth}`}
          </>
        }
        actions={
          <>
            <Button variant="outline" asChild>
              <Link to="/pipelines">
                <List /> All pipelines
              </Link>
            </Button>
            {active ? (
              <Button variant="outline" onClick={() => cancel.mutate(run.id)} disabled={cancel.isPending}>
                <Ban /> Cancel
              </Button>
            ) : (
              run.depth === 0 && (
                <Button
                  variant="outline"
                  disabled={rerun.isPending}
                  onClick={() =>
                    rerun.mutate(
                      { id: run.pipeline, parameters: run.parameters },
                      { onSuccess: (r) => navigate(`/runs/${r.id}`) },
                    )
                  }
                >
                  <RotateCw /> Run again
                </Button>
              )
            )}
          </>
        }
      />

      <div className="mb-4 grid gap-4">
        {cancel.error && <ErrorAlert title="Could not cancel" error={cancel.error} />}
        {rerun.error && <ErrorAlert title="Could not start the run" error={rerun.error} />}
        {run.error && run.status !== "SUCCEEDED" && (
          <ErrorAlert title="Run error" error={new Error(run.error)} />
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="grid min-w-0 content-start gap-4">
          <p className="text-muted-foreground -mb-2 text-xs">Click a task to see its printout below.</p>
          <PipelineGraph
            nodes={graph.nodes}
            edges={graph.edges}
            statuses={graph.statuses}
            selected={selectedKey}
            onSelect={setPicked}
            onOpen={(n) => {
              const child = run.tasks[n.key]?.child_run_id
              if (child) navigate(`/runs/${child}`)
            }}
          />
          {selected ? (
            <TaskRunPanel
              task={selected}
              childRun={run.children.find((c) => c.id === selected.child_run_id)}
            />
          ) : (
            <p className="text-muted-foreground text-sm">Click a task to see its printout.</p>
          )}
        </div>

        <div className="grid min-w-0 content-start gap-4">
          <Card className="gap-3">
            <CardHeader>
              <CardTitle className="text-sm">Run hierarchy</CardTitle>
            </CardHeader>
            <CardContent>
              <RunTreeView tree={run} currentRunId={run.id} />
            </CardContent>
          </Card>
          <Card className="gap-3">
            <CardHeader>
              <CardTitle className="text-sm">Parameters</CardTitle>
            </CardHeader>
            <CardContent>
              <JsonView value={run.parameters} />
            </CardContent>
          </Card>
          <Card className="gap-3">
            <CardHeader>
              <CardTitle className="text-sm">Outputs</CardTitle>
            </CardHeader>
            <CardContent>
              <JsonView value={Object.keys(run.outputs).length ? run.outputs : null} />
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  )
}

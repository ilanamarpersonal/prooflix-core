import { useEffect, useMemo, useState } from "react"
import { Link, Navigate, useNavigate, useParams } from "react-router"
import { ArrowUpRight, FileCode2, List, PanelRightOpen, RotateCw, ScrollText, Square, Workflow } from "lucide-react"

import { AiAssistSlot, useAiAssistDock } from "@/components/ai-assist-dock"
import { AiAssistRunPanel } from "@/components/ai-assist-run-panel"
import { ErrorAlert } from "@/components/error-alert"
import { KeyValues } from "@/components/key-values"
import { PageHeader } from "@/components/page-header"
import { PipelineGraph } from "@/components/pipeline-graph"
import { ResizeDivider } from "@/components/resize-divider"
import { RunOutput } from "@/components/run-output"
import { RunTreeView } from "@/components/run-tree-view"
import { StatusBadge } from "@/components/status-badge"
import type { TaskAction } from "@/components/task-actions-menu"
import { TaskRunPanel } from "@/components/task-run-panel"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { useCancelRun, usePipeline, usePipelines, useRunTree, useStartRun } from "@/lib/api"
import { TERMINAL_STATUSES, type GraphEdge, type GraphNode, type RunStatus } from "@/lib/types"
import { formatDateTime, formatDuration } from "@/lib/utils"

const SIDE_WIDTH_KEY = "prooflix-run-side-width"
const DEFAULT_SIDE_WIDTH = 320 // 20rem
const clampSide = (w: number) => Math.round(Math.min(Math.max(w, 240), 720))

function loadSideWidth(): number {
  try {
    const w = Number(localStorage.getItem(SIDE_WIDTH_KEY))
    return w ? clampSide(w) : DEFAULT_SIDE_WIDTH
  } catch {
    return DEFAULT_SIDE_WIDTH
  }
}

export function RunDetailPage() {
  const { runId = "" } = useParams()
  const navigate = useNavigate()
  const { data: run, isLoading, error } = useRunTree(runId)
  const cancel = useCancelRun()
  const rerun = useStartRun()
  const [picked, setPicked] = useState<string | null>(null)
  // the side column's width (run hierarchy, parameters, outputs), set with the divider, remembered in the browser
  const [sideWidth, setSideWidth] = useState(loadSideWidth)
  const resizeSide = (w: number, save = false) => {
    const next = clampSide(w)
    setSideWidth(next)
    if (save)
      try {
        localStorage.setItem(SIDE_WIDTH_KEY, String(next))
      } catch {
        /* storage unavailable */
      }
  }
  const pipelines = usePipelines()
  // the pipeline's definition, for each python task's source file
  const definition = usePipeline(run?.pipeline ?? "")
  // AI Assist offers to explain a failed run, in the panel on the right, which opens by itself when the run fails
  const dock = useAiAssistDock()
  const failed = run?.status === "FAILED"
  const { popUp } = dock
  useEffect(() => {
    if (failed) popUp()
  }, [failed, run?.id, popUp])

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
  // Highlighted in the graph: the task you picked, else the running task, else the
  // first failed one, else the task that started last. Until you pick one, the
  // output of every task is shown below (live while the run is going).
  const lastStarted = [...tasks].filter((t) => t.started_at).sort((a, b) => (a.started_at! < b.started_at! ? 1 : -1))[0]
  const selectedKey =
    picked ??
    tasks.find((t) => t.status === "RUNNING")?.key ??
    tasks.find((t) => t.status === "FAILED")?.key ??
    lastStarted?.key ??
    tasks[0]?.key ??
    null
  const selected = picked ? run.tasks[picked] : undefined
  const showAssist = run.status === "FAILED" && dock.available

  // A task's links: its source code, its sub-run and the pipeline it calls.
  const taskLinks = (key: string): TaskAction[] => {
    const task = run.tasks[key]
    const source = definition.data?.graph.nodes.find((d) => d.key === key)?.source_file
    const links: TaskAction[] = []
    if (source)
      links.push({
        label: "Open source code",
        icon: FileCode2,
        onSelect: () => navigate(`/workspace?${new URLSearchParams({ path: source })}`),
      })
    if (task?.child_run_id)
      links.push({
        label: "Open sub-run",
        icon: ArrowUpRight,
        onSelect: () => navigate(`/runs/${task.child_run_id}`),
      })
    if (task?.pipeline)
      links.push({
        label: `Open pipeline ${task.pipeline}`,
        icon: Workflow,
        onSelect: () => navigate(`/pipelines/${task.pipeline}`),
      })
    return links
  }

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
              <Button
                variant="outline"
                onClick={() => cancel.mutate(run.id)}
                disabled={cancel.isPending}
                className="text-destructive hover:text-destructive"
                title="Stop this run and its sub-pipeline runs"
              >
                <Square /> Stop
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

      {showAssist && (
        <AiAssistSlot>
          <AiAssistRunPanel
            key={run.id}
            runId={run.id}
            ready={dock.ready}
            canSetUp={dock.canSetUp}
            onClose={() => dock.setOpen(false)}
          />
        </AiAssistSlot>
      )}
      <div className="mb-4 grid gap-4">
        {cancel.error && <ErrorAlert title="Could not stop" error={cancel.error} />}
        {rerun.error && <ErrorAlert title="Could not start the run" error={rerun.error} />}
        {run.error && run.status !== "SUCCEEDED" && <ErrorAlert title="Run error" error={new Error(run.error)} />}
      </div>

      <div
        style={{ ["--side-w" as string]: `${sideWidth}px` }}
        className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1fr)_1.25rem_var(--side-w)] lg:gap-1"
      >
        <div className="grid min-w-0 content-start gap-4">
          <p className="text-muted-foreground -mb-2 text-xs">
            {selected ? "Showing one task's printout." : "Every task's output is shown below as it runs."} Click a task
            to see only its printout.
          </p>
          <PipelineGraph
            nodes={graph.nodes}
            edges={graph.edges}
            statuses={graph.statuses}
            selected={selectedKey}
            onSelect={setPicked}
            actions={(n) => [
              { label: "Show printout", icon: PanelRightOpen, onSelect: () => setPicked(n.key) },
              ...taskLinks(n.key),
            ]}
          />
          {selected ? (
            <>
              <div>
                <Button variant="outline" size="sm" onClick={() => setPicked(null)}>
                  <ScrollText /> Show all output
                </Button>
              </div>
              <TaskRunPanel
                task={selected}
                childRun={run.children.find((c) => c.id === selected.child_run_id)}
                actions={[
                  ...taskLinks(selected.key),
                  { label: "Show all output", icon: ScrollText, onSelect: () => setPicked(null) },
                ]}
              />
            </>
          ) : (
            <RunOutput run={run} />
          )}
        </div>

        <ResizeDivider
          orientation="vertical"
          after
          className="hidden lg:flex"
          label="Resize the run's side column"
          value={sideWidth}
          onResize={(w) => resizeSide(w)}
          onDone={(w) => resizeSide(w, true)}
          onReset={() => resizeSide(DEFAULT_SIDE_WIDTH, true)}
        />
        <div className="grid min-w-0 content-start gap-4">
          <Card className="gap-3">
            <CardHeader>
              <CardTitle className="text-sm">Run hierarchy</CardTitle>
            </CardHeader>
            <CardContent>
              <RunTreeView tree={run} currentRunId={run.id} />
            </CardContent>
          </Card>
          {Object.keys(run.parameters).length > 0 && (
            <Card className="gap-3">
              <CardHeader>
                <CardTitle className="text-sm">Parameters</CardTitle>
              </CardHeader>
              <CardContent>
                <KeyValues values={run.parameters} />
              </CardContent>
            </Card>
          )}
          <Card className="gap-3">
            <CardHeader>
              <CardTitle className="text-sm">Outputs</CardTitle>
            </CardHeader>
            <CardContent>
              <KeyValues values={run.outputs} />
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  )
}

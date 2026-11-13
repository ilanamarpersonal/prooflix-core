import { useRef, useState } from "react"
import { Link, useNavigate } from "react-router"
import { AlarmClock, AlertTriangle, FolderInput, History, Plus, Search, Workflow, X } from "lucide-react"

import { ErrorAlert } from "@/components/error-alert"
import { PageHeader } from "@/components/page-header"
import { RunButton } from "@/components/run-button"
import { RunningBadge, activeRunsByPipeline } from "@/components/running-badge"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Pager } from "@/components/pager"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ResizeDivider } from "@/components/resize-divider"
import { RunsTable } from "@/components/runs-table"
import { usePipelines, useRuns } from "@/lib/api"
import { searchRuns } from "@/lib/run-search"
import { describeCron } from "@/lib/schedule"
import { usePagination } from "@/lib/use-pagination"
import { useFillHeight } from "@/lib/use-fill-height"
import { cn, formatDateTime } from "@/lib/utils"

const LIST_HEIGHT_KEY = "prooflix-pipelines-list-height"
const DEFAULT_LIST_HEIGHT = 300
const MIN_LIST_HEIGHT = 150 // header, a row and the pager
const MIN_RUNS_HEIGHT = 200 // the runs heading, a few rows and the pager

function loadListHeight() {
  try {
    const h = Number(localStorage.getItem(LIST_HEIGHT_KEY))
    return h >= MIN_LIST_HEIGHT && h <= 3000 ? h : DEFAULT_LIST_HEIGHT
  } catch {
    return DEFAULT_LIST_HEIGHT
  }
}

export function PipelinesPage() {
  const { data, isLoading, error } = usePipelines()
  const navigate = useNavigate()
  const hasPipelines = !!data?.length
  const pager = usePagination(data, 10)
  const runs = useRuns({ rootOnly: true, limit: 500 })
  // All runs of the pipelines in the workspace, newest first.
  const ids = new Set(data?.map((p) => p.id))
  const pipelineRuns = data ? runs.data?.filter((r) => ids.has(r.pipeline)) : undefined
  // runs still going (this list refreshes every second while any are)
  const activeRuns = activeRunsByPipeline(runs.data)
  const [runQuery, setRunQuery] = useState("")
  const shownRuns = searchRuns(pipelineRuns, runQuery)
  const searching = !!runQuery.trim()

  // On md+ screens the two lists fill the window; the divider between them sets how
  // tall the pipelines list is and the runs get the rest. Each scrolls inside.
  const panels = useRef<HTMLDivElement>(null)
  const panelsHeight = useFillHeight(panels)
  const split = !!panelsHeight && hasPipelines
  const [listHeight, setListHeight] = useState(loadListHeight)
  const clampList = (h: number) =>
    Math.round(
      Math.min(Math.max(h, MIN_LIST_HEIGHT), Math.max(MIN_LIST_HEIGHT, (panelsHeight ?? 2000) - MIN_RUNS_HEIGHT - 20)),
    )
  const resizeList = (h: number, save = false) => {
    const next = clampList(h)
    setListHeight(next)
    if (save)
      try {
        localStorage.setItem(LIST_HEIGHT_KEY, String(next))
      } catch {
        /* storage unavailable */
      }
  }

  return (
    <>
      <PageHeader
        title="Pipelines"
        description="Pipelines from the projects imported in the Workspace tab. Click a pipeline to open it, or Run to start it."
        actions={
          hasPipelines && (
            <>
              <Button variant="outline" asChild>
                <Link to="/pipelines/new">
                  <Plus /> New pipeline
                </Link>
              </Button>
            </>
          )
        }
      />
      {error && <ErrorAlert error={error} />}
      <div ref={panels} style={split ? { height: panelsHeight } : undefined} className={cn(split && "flex flex-col")}>
        <Card
          className={cn("py-2", split && "min-h-0 shrink-0")}
          style={split ? { height: clampList(listHeight) } : undefined}
        >
          <CardContent className={cn("px-2", split && "flex min-h-0 flex-1 flex-col")}>
            {isLoading ? (
              <Skeleton className="h-48 w-full" />
            ) : !hasPipelines ? (
              <div className="text-muted-foreground flex flex-col items-center gap-3 py-14 text-center text-sm">
                <Workflow className="size-8" />
                <div>
                  <p className="text-foreground font-medium">No pipelines yet</p>
                  <p>
                    Import a project with a <code className="font-mono">pipelines/</code> folder (and its code in{" "}
                    <code className="font-mono">src/</code>) to run its pipelines here.
                  </p>
                </div>
                <Button asChild>
                  <Link to="/workspace">
                    <FolderInput /> Import code in Workspace
                  </Link>
                </Button>
              </div>
            ) : (
              <>
                <Table containerClassName={cn("max-h-[60vh] overflow-y-auto", split && "max-h-none min-h-0 flex-1")}>
                  <TableHeader className="bg-card sticky top-0 z-10 shadow-[inset_0_-1px_0_var(--border)]">
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Id</TableHead>
                      <TableHead>Project</TableHead>
                      <TableHead>Tasks</TableHead>
                      <TableHead>Sub-pipelines</TableHead>
                      <TableHead>Trigger</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="w-0" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pager.items.map((p) => (
                      <TableRow
                        key={p.id}
                        className="cursor-pointer"
                        onClick={(e) => {
                          // the whole row opens the pipeline, except its links and buttons
                          if (!(e.target as HTMLElement).closest("a,button")) navigate(`/pipelines/${p.id}`)
                        }}
                      >
                        <TableCell className="max-w-80">
                          <Link to={`/pipelines/${p.id}`} className="font-medium hover:underline">
                            {p.name}
                          </Link>
                          {p.description && (
                            <div className="text-muted-foreground truncate text-xs">{p.description}</div>
                          )}
                        </TableCell>
                        <TableCell className="text-muted-foreground font-mono text-xs">{p.id}</TableCell>
                        <TableCell className="text-muted-foreground font-mono text-xs">
                          {p.file ? (
                            <Link
                              to={`/workspace?${new URLSearchParams({ path: p.file })}`}
                              className="hover:underline"
                            >
                              {p.project || "workspace"}
                            </Link>
                          ) : (
                            p.project || "workspace"
                          )}
                        </TableCell>
                        <TableCell>{p.task_count}</TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1">
                            {p.sub_pipelines.length ? (
                              p.sub_pipelines.map((s) => (
                                <Badge key={s} variant="secondary" asChild>
                                  <Link to={`/pipelines/${s}`}>{s}</Link>
                                </Badge>
                              ))
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-xs">
                          {!p.schedule ? (
                            <span className="text-muted-foreground">Manual</span>
                          ) : (
                            <div title={`${p.schedule.cron} (${p.schedule.timezone})`}>
                              <div className="flex items-center gap-1">
                                <AlarmClock className="text-primary size-3.5" />
                                {describeCron(p.schedule.cron)}
                                {!p.schedule.enabled && (
                                  <Badge variant="outline" className="ml-1 px-1 py-0 text-[10px]">
                                    paused
                                  </Badge>
                                )}
                              </div>
                              {p.schedule.enabled && p.schedule.next_run && (
                                <div className="text-muted-foreground">next {formatDateTime(p.schedule.next_run)}</div>
                              )}
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap items-center gap-1">
                            <RunningBadge runs={activeRuns.get(p.id)} />
                            {p.valid ? (
                              <Badge variant="outline" className="text-status-succeeded">
                                valid
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="text-status-failed" title={p.errors.join("\n")}>
                                <AlertTriangle /> {p.errors.length} error
                                {p.errors.length > 1 ? "s" : ""}
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <RunButton
                            pipeline={p}
                            size="sm"
                            variant="outline"
                            onNeedsParameters={() => navigate(`/pipelines/${p.id}?run=1`)}
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <Pager pagination={pager} label="pipelines" />
              </>
            )}
          </CardContent>
        </Card>

        {split && (
          <ResizeDivider
            className="my-2"
            label="Resize the pipelines list and the runs"
            value={clampList(listHeight)}
            onResize={(h) => resizeList(h)}
            onDone={(h) => resizeList(h, true)}
            onReset={() => resizeList(DEFAULT_LIST_HEIGHT, true)}
          />
        )}
        {hasPipelines && (
          <section className={cn(split ? "flex min-h-0 flex-1 flex-col" : "mt-8")}>
            <div className="mb-3 flex shrink-0 flex-wrap items-center gap-x-2 gap-y-2">
              <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
                <History className="size-5" /> All runs
              </h2>
              <span className="text-muted-foreground text-sm">
                {pipelineRuns
                  ? searching
                    ? `${shownRuns?.length ?? 0} of ${pipelineRuns.length} runs · `
                    : `${pipelineRuns.length} run${pipelineRuns.length === 1 ? "" : "s"} · `
                  : ""}
                newest first; sub-pipeline runs open inside their parent run
              </span>
              <div className="relative ml-auto w-full sm:w-80">
                <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
                <input
                  type="search"
                  value={runQuery}
                  onChange={(e) => setRunQuery(e.target.value)}
                  onKeyDown={(e) => e.key === "Escape" && setRunQuery("")}
                  placeholder="Search runs: id, pipeline, status, trigger, date"
                  aria-label="Search runs"
                  title={'Words narrow the search ("e2e failed"); commas find several ("e8d93, 178a9")'}
                  className="border-input bg-background focus-visible:ring-ring/50 h-9 w-full rounded-md border pr-8 pl-8 text-sm shadow-xs outline-none placeholder:text-muted-foreground focus-visible:ring-[3px] [&::-webkit-search-cancel-button]:hidden"
                />
                {searching && (
                  <button
                    type="button"
                    onClick={() => setRunQuery("")}
                    aria-label="Clear the search"
                    className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2"
                  >
                    <X className="size-4" />
                  </button>
                )}
              </div>
            </div>
            {runs.error && <ErrorAlert error={runs.error} />}
            <Card className={cn("py-2", split && "min-h-0 flex-1")}>
              <CardContent className={cn("px-2", split && "min-h-0 flex-1")}>
                <RunsTable
                  key={runQuery.trim() ? "search" : "all"} // a search starts on the first page
                  runs={shownRuns}
                  loading={runs.isLoading}
                  fill={split}
                  emptyText={
                    searching ? (
                      <>
                        No runs match <span className="text-foreground font-medium">“{runQuery.trim()}”</span>.{" "}
                        <button type="button" className="underline" onClick={() => setRunQuery("")}>
                          Show all runs
                        </button>
                      </>
                    ) : (
                      "No runs yet."
                    )
                  }
                />
              </CardContent>
            </Card>
          </section>
        )}
      </div>
    </>
  )
}

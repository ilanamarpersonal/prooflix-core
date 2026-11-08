import { Link, useNavigate } from "react-router"
import { AlertTriangle, FolderInput, History, Plus, Workflow } from "lucide-react"

import { ErrorAlert } from "@/components/error-alert"
import { PageHeader } from "@/components/page-header"
import { RunButton } from "@/components/run-button"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { RunsTable } from "@/components/runs-table"
import { usePipelines, useRuns } from "@/lib/api"

export function PipelinesPage() {
  const { data, isLoading, error } = usePipelines()
  const navigate = useNavigate()
  const hasPipelines = !!data?.length
  const runs = useRuns({ rootOnly: true, limit: 500 })
  // All runs of the pipelines in the workspace, newest first.
  const ids = new Set(data?.map((p) => p.id))
  const pipelineRuns = data ? runs.data?.filter((r) => ids.has(r.pipeline)) : undefined

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
      <Card className="py-2">
        <CardContent className="px-2">
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
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Id</TableHead>
                  <TableHead>Project</TableHead>
                  <TableHead>Tasks</TableHead>
                  <TableHead>Sub-pipelines</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-0" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.map((p) => (
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
                        <Link to={`/workspace?${new URLSearchParams({ path: p.file })}`} className="hover:underline">
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
                    <TableCell>
                      {p.valid ? (
                        <Badge variant="outline" className="text-status-succeeded">
                          valid
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-status-failed" title={p.errors.join("\n")}>
                          <AlertTriangle /> {p.errors.length} error{p.errors.length > 1 ? "s" : ""}
                        </Badge>
                      )}
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
          )}
        </CardContent>
      </Card>

      {hasPipelines && (
        <section className="mt-8">
          <div className="mb-3 flex items-baseline gap-2">
            <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
              <History className="size-5" /> All runs
            </h2>
            <span className="text-muted-foreground text-sm">
              {pipelineRuns ? `${pipelineRuns.length} run${pipelineRuns.length === 1 ? "" : "s"} · ` : ""}
              newest first; sub-pipeline runs open inside their parent run
            </span>
          </div>
          {runs.error && <ErrorAlert error={runs.error} />}
          <Card className="py-2">
            <CardContent className="px-2">
              <RunsTable runs={pipelineRuns} loading={runs.isLoading} />
            </CardContent>
          </Card>
        </section>
      )}
    </>
  )
}

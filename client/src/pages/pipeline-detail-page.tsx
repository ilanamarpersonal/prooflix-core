import { useState } from "react"
import { Link, useNavigate, useParams } from "react-router"
import { Play, Trash2 } from "lucide-react"

import { ErrorAlert, ValidationErrors } from "@/components/error-alert"
import { JsonView } from "@/components/json-view"
import { PageHeader } from "@/components/page-header"
import { PipelineGraph } from "@/components/pipeline-graph"
import { RunPipelineForm } from "@/components/run-pipeline-form"
import { RunsTable } from "@/components/runs-table"
import { TaskTypeIcon } from "@/components/task-type-icon"
import { YamlEditor } from "@/components/yaml-editor"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useDeletePipeline, usePipeline, useRuns } from "@/lib/api"

export function PipelineDetailPage() {
  const { pipelineId = "" } = useParams()
  const navigate = useNavigate()
  const { data: pipeline, isLoading, error } = usePipeline(pipelineId)
  const runs = useRuns({ pipeline: pipelineId, rootOnly: false })
  const del = useDeletePipeline()
  const [showRunForm, setShowRunForm] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)

  if (isLoading) return <Skeleton className="h-96 w-full" />
  if (error || !pipeline) return <ErrorAlert title="Could not load pipeline" error={error} />

  const tasks = (pipeline.spec?.tasks as Record<string, unknown>[] | undefined) ?? []
  const selectedTask = tasks.find((t) => t.key === selected)

  const remove = () => {
    if (!confirm(`Delete pipeline '${pipeline.id}'? This deletes its YAML file.`)) return
    del.mutate(pipeline.id, { onSuccess: () => navigate("/pipelines") })
  }

  return (
    <>
      <PageHeader
        eyebrow={
          <Link to="/pipelines" className="hover:underline">
            Pipelines
          </Link>
        }
        title={pipeline.name}
        description={pipeline.description}
        actions={
          <>
            <Button variant="outline" onClick={remove} disabled={del.isPending}>
              <Trash2 /> Delete
            </Button>
            <Button onClick={() => setShowRunForm((v) => !v)} disabled={!pipeline.valid}>
              <Play /> Run
            </Button>
          </>
        }
      />

      <div className="mb-4 grid gap-4">
        {del.error && <ErrorAlert title="Could not delete" error={del.error} />}
        <ValidationErrors errors={pipeline.errors} />
        {showRunForm && (
          <RunPipelineForm
            pipelineId={pipeline.id}
            parameters={pipeline.parameters}
            onDone={() => setShowRunForm(false)}
          />
        )}
      </div>

      <Tabs defaultValue="graph">
        <TabsList>
          <TabsTrigger value="graph">Graph</TabsTrigger>
          <TabsTrigger value="yaml">YAML</TabsTrigger>
          <TabsTrigger value="runs">Runs</TabsTrigger>
        </TabsList>

        <TabsContent value="graph" className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="grid min-w-0 content-start gap-4">
            {pipeline.graph.nodes.length ? (
              <PipelineGraph
                nodes={pipeline.graph.nodes}
                edges={pipeline.graph.edges}
                selected={selected}
                onSelect={setSelected}
                onOpen={(n) => n.pipeline && navigate(`/pipelines/${n.pipeline}`)}
              />
            ) : (
              <p className="text-muted-foreground text-sm">Fix the YAML errors to see the graph.</p>
            )}
            {selectedTask && (
              <Card className="gap-3">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <TaskTypeIcon type={selectedTask.type as "python"} /> {String(selectedTask.key)}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <JsonView value={selectedTask} />
                </CardContent>
              </Card>
            )}
          </div>
          <div className="grid content-start gap-4">
            <Card className="gap-3">
              <CardHeader>
                <CardTitle className="text-sm">Parameters</CardTitle>
              </CardHeader>
              <CardContent>
                {Object.keys(pipeline.parameters).length ? (
                  <dl className="grid gap-2 text-sm">
                    {Object.entries(pipeline.parameters).map(([k, v]) => (
                      <div key={k} className="flex justify-between gap-2">
                        <dt className="font-mono">{k}</dt>
                        <dd className="text-muted-foreground truncate font-mono">{JSON.stringify(v)}</dd>
                      </div>
                    ))}
                  </dl>
                ) : (
                  <p className="text-muted-foreground text-sm">None</p>
                )}
              </CardContent>
            </Card>
            <PipelineLinks title="Calls" ids={pipeline.sub_pipelines} />
            <PipelineLinks title="Used by" ids={pipeline.used_by} />
          </div>
        </TabsContent>

        <TabsContent value="yaml">
          {/* re-mount when the saved file changes so the editor shows the new text */}
          <YamlEditor key={pipeline.source} pipelineId={pipeline.id} savedSource={pipeline.source} />
        </TabsContent>

        <TabsContent value="runs">
          <Card className="py-2">
            <CardContent className="px-2">
              <RunsTable runs={runs.data} loading={runs.isLoading} showPipeline={false} />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </>
  )
}

function PipelineLinks({ title, ids }: { title: string; ids: string[] }) {
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle className="text-sm">{title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-1">
        {ids.length ? (
          ids.map((id) => (
            <Badge key={id} variant="secondary" asChild>
              <Link to={`/pipelines/${id}`}>{id}</Link>
            </Badge>
          ))
        ) : (
          <span className="text-muted-foreground text-sm">None</span>
        )}
      </CardContent>
    </Card>
  )
}

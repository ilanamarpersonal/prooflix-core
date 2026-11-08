import { Navigate } from "react-router"

import { ErrorAlert } from "@/components/error-alert"
import { PageHeader } from "@/components/page-header"
import { RunsTable } from "@/components/runs-table"
import { Card, CardContent } from "@/components/ui/card"
import { usePipelines, useRuns } from "@/lib/api"

export function RunsPage() {
  const { data, isLoading, error } = useRuns({ rootOnly: true })
  const pipelines = usePipelines()
  // Only runs of pipelines that are still in the workspace.
  const ids = new Set(pipelines.data?.map((p) => p.id))
  const runs = pipelines.data ? data?.filter((r) => ids.has(r.pipeline)) : undefined
  // No pipelines left in the workspace: the Pipelines tab shows its (empty) list.
  if (pipelines.data && pipelines.data.length === 0) return <Navigate to="/pipelines" replace />
  return (
    <>
      <PageHeader
        title="Runs"
        description="Top-level runs of the pipelines in the workspace. Sub-pipeline runs are shown inside their parent run."
      />
      {error && <ErrorAlert error={error} />}
      <Card className="py-2">
        <CardContent className="px-2">
          <RunsTable runs={runs} loading={isLoading || pipelines.isLoading} />
        </CardContent>
      </Card>
    </>
  )
}

import { ErrorAlert } from "@/components/error-alert"
import { PageHeader } from "@/components/page-header"
import { RunsTable } from "@/components/runs-table"
import { Card, CardContent } from "@/components/ui/card"
import { useRuns } from "@/lib/api"

export function RunsPage() {
  const { data, isLoading, error } = useRuns({ rootOnly: true })
  return (
    <>
      <PageHeader
        title="Runs"
        description="Top-level runs. Sub-pipeline runs are shown inside their parent run."
      />
      {error && <ErrorAlert error={error} />}
      <Card className="py-2">
        <CardContent className="px-2">
          <RunsTable runs={data} loading={isLoading} />
        </CardContent>
      </Card>
    </>
  )
}

import { RefreshCw } from "lucide-react"

import { ErrorAlert } from "@/components/error-alert"
import { PageHeader } from "@/components/page-header"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useSystemParameters } from "@/lib/api"
import { cn } from "@/lib/utils"

/** The server's settings: each PROOFLIX_* environment variable and what it is set to. */
export function SystemPage() {
  const params = useSystemParameters()
  return (
    <div>
      <PageHeader
        title="System"
        description="The server's parameters, set with environment variables when it starts (Helm values in Kubernetes). Read only: restart the server to change them."
        actions={
          <Button variant="outline" onClick={() => params.refetch()} disabled={params.isFetching}>
            <RefreshCw className={cn(params.isFetching && "animate-spin")} /> Refresh
          </Button>
        }
      />
      {params.error && <ErrorAlert error={params.error} />}
      <Card className="gap-0 overflow-hidden py-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[16rem]">Parameter</TableHead>
              <TableHead>Value</TableHead>
              <TableHead className="w-[8rem]">Source</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {params.isLoading
              ? Array.from({ length: 6 }, (_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={3}>
                      <Skeleton className="h-8" />
                    </TableCell>
                  </TableRow>
                ))
              : params.data?.map((p) => (
                  <TableRow key={p.name} className="align-top">
                    <TableCell className="py-3">
                      <code className="font-mono text-sm font-medium">{p.name}</code>
                      <p className="text-muted-foreground mt-1 text-xs whitespace-normal">{p.description}</p>
                    </TableCell>
                    <TableCell className="py-3 whitespace-normal">
                      {p.value !== null ? (
                        <code className="font-mono text-sm break-all">{p.value}</code>
                      ) : (
                        <span className="text-muted-foreground text-sm italic">not set</span>
                      )}
                      <p className="text-muted-foreground mt-1 text-xs">
                        Default: <span className="break-all">{p.default}</span>
                      </p>
                    </TableCell>
                    <TableCell className="py-3">
                      <Badge variant={p.source === "environment" ? "secondary" : "outline"}>
                        {p.source === "environment" ? "Environment" : "Default"}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  )
}

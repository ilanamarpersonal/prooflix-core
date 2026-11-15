import { useState } from "react"
import { Pencil, RefreshCw, RotateCcw } from "lucide-react"

import { ErrorAlert } from "@/components/error-alert"
import { PageHeader } from "@/components/page-header"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useSetSystemParameter, useSystemParameters } from "@/lib/api"
import type { SystemParameter } from "@/lib/types"
import { cn } from "@/lib/utils"

const SOURCE_LABEL: Record<SystemParameter["source"], string> = {
  saved: "Edited here",
  environment: "Environment",
  default: "Default",
}

/** The server's settings: each PROOFLIX_* parameter, what it is set to, and editing it. */
export function SystemPage() {
  const params = useSystemParameters()
  const pending = params.data?.filter((p) => p.restart_needed).length ?? 0
  return (
    <div>
      <PageHeader
        title="System"
        description="The server's parameters. They are read when the server starts: from environment variables (Helm values in Kubernetes), or from a value edited here, which wins over the environment variable. An edited value is used once the server restarts."
        actions={
          <Button variant="outline" onClick={() => params.refetch()} disabled={params.isFetching}>
            <RefreshCw className={cn(params.isFetching && "animate-spin")} /> Refresh
          </Button>
        }
      />
      {params.error && <ErrorAlert error={params.error} />}
      {pending > 0 && (
        <p className="mb-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
          {pending} edited parameter{pending === 1 ? "" : "s"} will be used once the server restarts.
        </p>
      )}
      <Card className="gap-0 overflow-hidden py-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[16rem]">Parameter</TableHead>
              <TableHead>Value</TableHead>
              <TableHead className="w-[9rem]">Source</TableHead>
              <TableHead className="w-[6rem]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {params.isLoading
              ? Array.from({ length: 6 }, (_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={4}>
                      <Skeleton className="h-8" />
                    </TableCell>
                  </TableRow>
                ))
              : params.data?.map((p) => <ParameterRow key={p.name} param={p} />)}
          </TableBody>
        </Table>
      </Card>
    </div>
  )
}

function ParameterRow({ param: p }: { param: SystemParameter }) {
  const setter = useSetSystemParameter()
  const [draft, setDraft] = useState<string | null>(null) // null: not editing
  const editing = draft !== null

  const save = (value: string | null) =>
    setter.mutate({ name: p.name, value }, { onSuccess: () => setDraft(null) })

  return (
    <TableRow className="align-top">
      <TableCell className="py-3">
        <code className="font-mono text-sm font-medium">{p.name}</code>
        <p className="text-muted-foreground mt-1 text-xs whitespace-normal">{p.description}</p>
      </TableCell>
      <TableCell className="py-3 whitespace-normal">
        {editing ? (
          <form
            className="grid gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              save(draft)
            }}
          >
            <Input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setDraft(null)}
              placeholder={p.default}
              aria-label={`New value for ${p.name}`}
              className="font-mono"
            />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" size="sm" disabled={setter.isPending}>
                Save
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => setDraft(null)}>
                Cancel
              </Button>
              <span className="text-muted-foreground self-center text-xs">Leave empty to remove the edited value.</span>
            </div>
            {setter.error && <ErrorAlert title="Not saved" error={setter.error} />}
          </form>
        ) : (
          <>
            {p.value !== null ? (
              <code className="font-mono text-sm break-all">{p.value}</code>
            ) : (
              <span className="text-muted-foreground text-sm italic">not set</span>
            )}
            {p.restart_needed && (
              <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                {p.saved !== null ? (
                  <>
                    After a restart: <code className="font-mono break-all">{p.saved}</code>
                  </>
                ) : (
                  "Edited value removed: after a restart, the environment variable or default is used."
                )}
              </p>
            )}
            <p className="text-muted-foreground mt-1 text-xs">
              Default: <span className="break-all">{p.default}</span>
            </p>
          </>
        )}
      </TableCell>
      <TableCell className="py-3">
        <div className="flex flex-wrap gap-1">
          <Badge variant={p.source === "default" ? "outline" : "secondary"}>{SOURCE_LABEL[p.source]}</Badge>
          {p.restart_needed && (
            <Badge variant="outline" className="border-amber-500/50 text-amber-700 dark:text-amber-400">
              Restart to apply
            </Badge>
          )}
        </div>
      </TableCell>
      <TableCell className="py-2">
        {p.editable && !editing && (
          <div className="flex justify-end gap-1">
            <Button
              variant="ghost"
              size="icon"
              title={`Edit ${p.name}`}
              aria-label={`Edit ${p.name}`}
              onClick={() => {
                setter.reset()
                setDraft(p.saved ?? p.value ?? "")
              }}
            >
              <Pencil />
            </Button>
            {p.saved !== null && (
              <Button
                variant="ghost"
                size="icon"
                title="Remove the edited value"
                aria-label={`Remove the edited value of ${p.name}`}
                onClick={() => save(null)}
                disabled={setter.isPending}
              >
                <RotateCcw />
              </Button>
            )}
          </div>
        )}
      </TableCell>
    </TableRow>
  )
}

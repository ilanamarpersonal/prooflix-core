import { Fragment, useMemo, useState } from "react"
import { Link } from "react-router"
import { CheckCircle2, ChevronDown, ChevronRight, DatabaseZap, Loader2, RefreshCw, Upload, XCircle } from "lucide-react"

import { ErrorAlert } from "@/components/error-alert"
import { PageHeader } from "@/components/page-header"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useClickHouseStatus, useGoldTables, useImportToClickHouse } from "@/lib/api"
import type { ClickHouseStatus } from "@/lib/types"
import { cn } from "@/lib/utils"

const fmt = (n: number | null | undefined) => (n == null ? "—" : n.toLocaleString())

/** Copy gold tables into ClickHouse, with the same columns and types, to query them from outside. */
export function ClickHousePage() {
  const status = useClickHouseStatus()
  const gold = useGoldTables()
  const importer = useImportToClickHouse()
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [open, setOpen] = useState<string | null>(null)

  // rows of each ClickHouse table, by "database.name"
  const inClickHouse = useMemo(
    () => new Map((status.data?.tables ?? []).map((t) => [`${t.database}.${t.name}`, t.rows])),
    [status.data],
  )
  const importable = (gold.data ?? []).filter((g) => !g.error)
  const allPicked = importable.length > 0 && importable.every((g) => picked.has(g.table))
  const ready = status.data?.configured && status.data.reachable

  const toggle = (table: string) =>
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(table)) next.delete(table)
      else next.add(table)
      return next
    })

  return (
    <div>
      <PageHeader
        title="ClickHouse"
        description="Copy gold tables into ClickHouse, with the same columns and types, so they can be queried from outside Prooflix with a read-only user. Importing a table again replaces its copy in one step."
        actions={
          <Button
            variant="outline"
            onClick={() => {
              void status.refetch()
              void gold.refetch()
            }}
            disabled={status.isFetching || gold.isFetching}
          >
            <RefreshCw className={cn((status.isFetching || gold.isFetching) && "animate-spin")} /> Refresh
          </Button>
        }
      />
      <div className="grid gap-4">
        {status.error && <ErrorAlert error={status.error} />}
        {status.isLoading ? <Skeleton className="h-28" /> : status.data && <ConnectionCard status={status.data} />}

        <Card className="gap-0 overflow-hidden py-0">
          <CardHeader className="flex flex-row flex-wrap items-center gap-3 border-b px-4 py-3">
            <CardTitle className="flex-1 text-base">Gold tables</CardTitle>
            <span className="text-muted-foreground text-sm">{picked.size} selected</span>
            <Button
              onClick={() => importer.mutate([...picked])}
              disabled={!ready || picked.size === 0 || importer.isPending}
              title={!ready ? "ClickHouse isn't reachable" : undefined}
            >
              {importer.isPending ? <Loader2 className="animate-spin" /> : <Upload />}
              {importer.isPending
                ? "Importing…"
                : `Import ${picked.size || ""} table${picked.size === 1 ? "" : "s"} to ClickHouse`}
            </Button>
          </CardHeader>
          {gold.error && (
            <div className="p-4">
              <ErrorAlert error={gold.error} />
            </div>
          )}
          {gold.isLoading ? (
            <Skeleton className="m-4 h-24" />
          ) : !gold.data?.length ? (
            <p className="text-muted-foreground p-4 text-sm">
              No gold tables yet. They are the tables of a <code className="font-mono">gold</code> schema, such as{" "}
              <code className="font-mono">tenant1.gold</code>; run the gold pipeline to build them.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <input
                      type="checkbox"
                      aria-label="Select all gold tables"
                      className="accent-primary size-4"
                      checked={allPicked}
                      onChange={() => setPicked(allPicked ? new Set() : new Set(importable.map((g) => g.table)))}
                    />
                  </TableHead>
                  <TableHead>Gold table</TableHead>
                  <TableHead className="text-right">Rows</TableHead>
                  <TableHead>ClickHouse table</TableHead>
                  <TableHead className="text-right">Rows in ClickHouse</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {gold.data.map((g) => {
                  const there = inClickHouse.get(g.target)
                  const expanded = open === g.table
                  return (
                    <Fragment key={g.table}>
                      <TableRow className={cn(picked.has(g.table) && "bg-accent/40")}>
                        <TableCell>
                          <input
                            type="checkbox"
                            aria-label={`Select ${g.table}`}
                            className="accent-primary size-4"
                            checked={picked.has(g.table)}
                            disabled={!!g.error}
                            onChange={() => toggle(g.table)}
                          />
                        </TableCell>
                        <TableCell>
                          <button
                            type="button"
                            onClick={() => setOpen(expanded ? null : g.table)}
                            className="flex items-center gap-1 font-mono text-sm hover:underline"
                            aria-expanded={expanded}
                          >
                            {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                            {g.table}
                          </button>
                          {g.error && <p className="text-destructive mt-1 text-xs">{g.error}</p>}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{fmt(g.rows)}</TableCell>
                        <TableCell className="font-mono text-sm">{g.target}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {there == null ? (
                            <span className="text-muted-foreground text-xs">not imported</span>
                          ) : (
                            fmt(there)
                          )}
                        </TableCell>
                      </TableRow>
                      {expanded && (
                        <TableRow>
                          <TableCell />
                          <TableCell colSpan={4} className="pb-3">
                            <div className="grid max-w-xl grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-xs">
                              <span className="text-muted-foreground">Column</span>
                              <span className="text-muted-foreground">ClickHouse type</span>
                              {g.columns.map((c) => (
                                <Fragment key={c.name}>
                                  <code className="font-mono">{c.name}</code>
                                  <code className="font-mono">{c.clickhouse_type}</code>
                                </Fragment>
                              ))}
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </Card>

        {importer.error && <ErrorAlert title="Not imported" error={importer.error} />}
        {importer.data && (
          <Card className="gap-2 py-4">
            <CardHeader className="px-4">
              <CardTitle className="text-base">Last import</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-1.5 px-4 text-sm">
              {importer.data.map((r) => (
                <div key={r.table} className="flex flex-wrap items-center gap-2">
                  {r.ok ? (
                    <CheckCircle2 className="text-status-succeeded size-4" />
                  ) : (
                    <XCircle className="text-destructive size-4" />
                  )}
                  <code className="font-mono">{r.table}</code>
                  {r.ok ? (
                    <span className="text-muted-foreground">
                      → <code className="font-mono">{r.target}</code>: {fmt(r.rows)} rows, {r.columns} columns,{" "}
                      {r.replaced ? "replaced" : "created"} in {r.seconds}s
                    </span>
                  ) : (
                    <span className="text-destructive">{r.error}</span>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}

function ConnectionCard({ status: s }: { status: ClickHouseStatus }) {
  if (!s.configured) {
    return (
      <Card className="py-4">
        <CardContent className="text-muted-foreground px-4 text-sm">
          ClickHouse isn't set up. Set <code className="font-mono">PROOFLIX_CLICKHOUSE_URL</code> (and its user and
          password) in the{" "}
          <Link to="/system" className="text-foreground underline">
            System
          </Link>{" "}
          tab, then Restart server. The Helm chart sets them when it runs ClickHouse.
        </CardContent>
      </Card>
    )
  }
  const publicUrl = s.public_url ?? s.url ?? ""
  const reader = s.reader ?? "<read-only user>"
  const example = `curl -u ${reader}:<password> '${publicUrl}/?query=SHOW+TABLES+FROM+tenant1'`
  return (
    <Card className="gap-3 py-4">
      <CardHeader className="flex flex-row flex-wrap items-center gap-3 px-4">
        <DatabaseZap className="text-primary size-5" />
        <CardTitle className="text-base">Connection</CardTitle>
        {s.reachable ? (
          <Badge variant="outline" className="text-status-succeeded">
            connected · ClickHouse {s.version}
          </Badge>
        ) : (
          <Badge variant="outline" className="text-destructive">
            not reachable
          </Badge>
        )}
      </CardHeader>
      <CardContent className="grid gap-3 px-4 text-sm">
        {s.error && <ErrorAlert title="ClickHouse is not reachable" error={new Error(s.error)} />}
        <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-[auto_1fr]">
          <dt className="text-muted-foreground">Prooflix writes to</dt>
          <dd className="font-mono break-all">{s.url}</dd>
          <dt className="text-muted-foreground">Query it from outside</dt>
          <dd className="font-mono break-all">{publicUrl}</dd>
          <dt className="text-muted-foreground">Read-only user</dt>
          <dd className="font-mono">{s.reader ?? "not set (PROOFLIX_CLICKHOUSE_READER)"}</dd>
          <dt className="text-muted-foreground">Tables in ClickHouse</dt>
          <dd>
            {s.tables.length === 0
              ? "none yet"
              : s.tables.map((t) => `${t.database}.${t.name}`).join(", ")}
          </dd>
        </dl>
        <div>
          <p className="text-muted-foreground mb-1 text-xs">Example (SELECT only: the read-only user can't change anything)</p>
          <pre className="bg-muted overflow-x-auto rounded-md px-3 py-2 font-mono text-xs">{example}</pre>
        </div>
      </CardContent>
    </Card>
  )
}

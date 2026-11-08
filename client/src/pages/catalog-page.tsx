import { useEffect, useMemo, useState } from "react"
import { Link, useNavigate, useSearchParams } from "react-router"
import { ChevronRight, Database, Layers, RefreshCw, Table2 } from "lucide-react"

import { ErrorAlert } from "@/components/error-alert"
import { PageHeader } from "@/components/page-header"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useCatalog, useSqlQuery } from "@/lib/api"
import type { CatalogSchema, SqlTable } from "@/lib/types"
import { cn } from "@/lib/utils"

const PREVIEW_ROWS = 50

/** Schemas (the workspace's own data and one per project) and their tables. */
export function CatalogPage() {
  const catalog = useCatalog()
  const [params, setParams] = useSearchParams()
  const selectedKey = params.get("table") // "schema.table"
  const schemaParam = params.get("schema")

  const selected = useMemo(() => {
    for (const s of catalog.data ?? []) {
      const t = s.tables.find((t) => `${s.name}.${t.name}` === selectedKey)
      if (t) return t
    }
    return null
  }, [catalog.data, selectedKey])
  const selectedSchema = catalog.data?.find((s) => s.name === (selected?.schema ?? schemaParam)) ?? null
  const tableCount = catalog.data?.reduce((n, s) => n + s.tables.length, 0) ?? 0

  return (
    <>
      <PageHeader
        title="Catalog"
        description={
          catalog.data
            ? `${catalog.data.length} schema${catalog.data.length === 1 ? "" : "s"} · ${tableCount} table${tableCount === 1 ? "" : "s"}. Each imported project is a schema; its tables are the CSV and JSON files in its data/ folder.`
            : undefined
        }
        actions={
          <Button variant="outline" onClick={() => catalog.refetch()} disabled={catalog.isFetching}>
            <RefreshCw className={cn(catalog.isFetching && "animate-spin")} /> Refresh
          </Button>
        }
      />
      {catalog.error && <ErrorAlert error={catalog.error} />}
      <div className="grid gap-4 md:grid-cols-[18rem_minmax(0,1fr)]">
        <Card className="max-h-[75vh] gap-0 overflow-auto py-2">
          {catalog.isLoading ? (
            <Skeleton className="mx-2 h-64" />
          ) : !catalog.data?.length ? (
            <div className="text-muted-foreground grid gap-2 p-4 text-sm">
              <p>No schemas yet.</p>
              <p>
                Import a project in the{" "}
                <Link to="/workspace" className="underline">
                  Workspace
                </Link>{" "}
                tab. Each project becomes a schema, and CSV or JSON files in its{" "}
                <code className="font-mono">data/</code> folder become its tables.
              </p>
            </div>
          ) : (
            catalog.data.map((s) => (
              <SchemaNode
                key={s.name}
                schema={s}
                selectedKey={selectedKey}
                schemaSelected={!selected && schemaParam === s.name}
                onSelectTable={(t) => setParams({ table: `${s.name}.${t.name}` })}
                onSelectSchema={() => setParams({ schema: s.name })}
              />
            ))
          )}
        </Card>

        {selected ? (
          <TableDetail table={selected} />
        ) : selectedSchema ? (
          <SchemaDetail schema={selectedSchema} onSelectTable={(t) => setParams({ table: `${t.schema}.${t.name}` })} />
        ) : (
          <Card className="text-muted-foreground grid min-h-64 place-items-center p-6 text-center text-sm">
            Select a schema or a table.
          </Card>
        )}
      </div>
    </>
  )
}

function SchemaNode({
  schema,
  selectedKey,
  schemaSelected,
  onSelectTable,
  onSelectSchema,
}: {
  schema: CatalogSchema
  selectedKey: string | null
  schemaSelected: boolean
  onSelectTable: (t: SqlTable) => void
  onSelectSchema: () => void
}) {
  const containsSelected = !!selectedKey?.startsWith(`${schema.name}.`)
  const [open, setOpen] = useState(true)
  useEffect(() => {
    if (containsSelected) setOpen(true)
  }, [containsSelected])

  return (
    <div>
      <div
        className={cn(
          "hover:bg-accent flex items-center gap-1.5 px-2 text-sm",
          schemaSelected && "bg-accent font-medium",
        )}
      >
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-label={open ? `Collapse ${schema.name}` : `Expand ${schema.name}`}
          className="grid size-4 shrink-0 place-items-center py-1.5"
        >
          <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        </button>
        <button type="button" onClick={onSelectSchema} className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left">
          <Layers className="text-primary size-4 shrink-0" />
          <span className="truncate font-mono text-xs">{schema.name}</span>
          <span className="text-muted-foreground ml-auto text-xs">{schema.tables.length}</span>
        </button>
      </div>
      {open && (
        <div>
          {schema.tables.length === 0 ? (
            <p className="text-muted-foreground py-1 pr-2 pl-10 text-xs italic">no tables</p>
          ) : (
            schema.tables.map((t) => (
              <button
                key={t.name}
                type="button"
                onClick={() => onSelectTable(t)}
                className={cn(
                  "hover:bg-accent flex w-full items-center gap-1.5 py-1 pr-2 pl-9 text-left text-sm",
                  selectedKey === `${schema.name}.${t.name}` && "bg-accent font-medium",
                )}
                title={t.source}
              >
                <Table2 className="text-muted-foreground size-4 shrink-0" />
                <span className="truncate font-mono text-xs">{t.name}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}

function SchemaDetail({ schema, onSelectTable }: { schema: CatalogSchema; onSelectTable: (t: SqlTable) => void }) {
  return (
    <Card className="min-w-0 gap-0 overflow-hidden py-0">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <Layers className="text-primary size-4" />
        <span className="font-mono font-medium">{schema.name}</span>
        <Badge variant="secondary">schema</Badge>
        <span className="text-muted-foreground text-sm">
          {schema.project ? (
            <>
              project{" "}
              <Link to={`/workspace?${new URLSearchParams({ path: schema.project })}`} className="font-mono hover:underline">
                {schema.project}/
              </Link>
            </>
          ) : (
            "the workspace's own data"
          )}
        </span>
      </div>
      {schema.tables.length === 0 ? (
        <div className="text-muted-foreground p-4 text-sm">
          No tables yet. Add CSV or JSON files to{" "}
          <code className="font-mono">{schema.data_dir ?? `${schema.project}/data`}/</code> and they show up here.
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-4">Table</TableHead>
              <TableHead>Rows</TableHead>
              <TableHead>Columns</TableHead>
              <TableHead>Source file</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {schema.tables.map((t) => (
              <TableRow key={t.name} className="cursor-pointer" onClick={() => onSelectTable(t)}>
                <TableCell className="pl-4 font-mono text-xs font-medium">{t.name}</TableCell>
                <TableCell className="tabular-nums">{t.row_count}</TableCell>
                <TableCell className="tabular-nums">{t.columns.length}</TableCell>
                <TableCell className="text-muted-foreground font-mono text-xs">{t.source}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  )
}

function TableDetail({ table }: { table: SqlTable }) {
  const navigate = useNavigate()
  const preview = useSqlQuery()
  const previewSql = `SELECT * FROM ${table.qualified} LIMIT ${PREVIEW_ROWS}`
  const { mutate } = preview

  useEffect(() => {
    mutate({ sql: previewSql, limit: PREVIEW_ROWS })
  }, [previewSql, mutate])

  return (
    <div className="grid min-w-0 content-start gap-4">
      <Card className="min-w-0 gap-0 overflow-hidden py-0">
        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
          <Table2 className="text-primary size-4" />
          <span className="font-mono font-medium">{table.qualified}</span>
          <span className="text-muted-foreground text-sm">
            {table.row_count} row{table.row_count === 1 ? "" : "s"} · {table.columns.length} column
            {table.columns.length === 1 ? "" : "s"} · from{" "}
            <Link to={`/workspace?${new URLSearchParams({ path: table.source })}`} className="font-mono hover:underline">
              {table.source}
            </Link>
          </span>
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            onClick={() => navigate("/sql", { state: { sql: `SELECT *\nFROM ${table.qualified}\nLIMIT 100;` } })}
          >
            <Database /> Query in SQL Editor
          </Button>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-4">Column</TableHead>
              <TableHead>Type</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {table.columns.map((c) => (
              <TableRow key={c.name}>
                <TableCell className="pl-4 font-mono text-xs">{c.name}</TableCell>
                <TableCell className="text-muted-foreground text-xs uppercase">{c.type}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      <Card className="min-w-0 gap-0 overflow-hidden py-0">
        <div className="text-muted-foreground border-b px-4 py-2 text-sm">
          Sample data {preview.data && `(first ${preview.data.row_count} row${preview.data.row_count === 1 ? "" : "s"})`}
        </div>
        {preview.error ? (
          <div className="p-4">
            <ErrorAlert title="Could not load sample data" error={preview.error} />
          </div>
        ) : !preview.data ? (
          <Skeleton className="m-4 h-32" />
        ) : (
          <div className="max-h-[50vh] overflow-auto">
            <Table>
              <TableHeader className="bg-muted sticky top-0">
                <TableRow>
                  {preview.data.columns.map((c, i) => (
                    <TableHead key={i} className="font-mono text-xs">
                      {c}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {preview.data.rows.map((row, r) => (
                  <TableRow key={r}>
                    {row.map((v, c) => (
                      <TableCell
                        key={c}
                        className={cn("font-mono text-xs", typeof v === "number" && "text-right tabular-nums")}
                      >
                        {v === null ? <span className="text-muted-foreground italic">NULL</span> : String(v)}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>
    </div>
  )
}

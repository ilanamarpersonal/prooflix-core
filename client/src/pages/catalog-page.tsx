import { useEffect, useMemo, useRef, useState } from "react"
import { Link, useNavigate, useSearchParams } from "react-router"
import {
  ChevronDown,
  ChevronRight,
  Database,
  Download,
  Layers,
  RefreshCw,
  Table2,
  Upload,
} from "lucide-react"

import { CatalogImportPanel } from "@/components/catalog-import-panel"
import { DataGrid } from "@/components/data-grid"
import { ErrorAlert } from "@/components/error-alert"
import { PageHeader } from "@/components/page-header"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { catalogExportUrl, useCatalog, useSqlQuery } from "@/lib/api"
import type { CatalogSchema, SqlTable } from "@/lib/types"
import { cn } from "@/lib/utils"

const PREVIEW_ROWS = 1000

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
  const [importing, setImporting] = useState(false)

  // Export what is selected: a table, a schema, or everything.
  const exportTarget = selected
    ? {
        label: "Export table",
        what: selected.qualified,
        target: { table: `${selected.schema}.${selected.name}` },
      }
    : selectedSchema
      ? {
          label: "Export schema",
          what: `all tables of ${selectedSchema.name}`,
          target: { schema: selectedSchema.name },
        }
      : { label: "Export all", what: "every schema", target: {} }

  return (
    <>
      <PageHeader
        title="Catalog"
        description={
          catalog.data
            ? `${catalog.data.length} schema${catalog.data.length === 1 ? "" : "s"} · ${tableCount} table${tableCount === 1 ? "" : "s"}. Schemas are imported datasets (kept in the catalog folder, outside the workspace) and projects' data/ folders; their Parquet files are the tables (a folder of Parquet files is one table).`
            : undefined
        }
        actions={
          <>
            <Button variant="outline" onClick={() => catalog.refetch()} disabled={catalog.isFetching}>
              <RefreshCw className={cn(catalog.isFetching && "animate-spin")} /> Refresh
            </Button>
            {tableCount > 0 ? (
              <ExportMenu
                label={exportTarget.label}
                what={exportTarget.what}
                target={exportTarget.target}
                single={!!selected}
              />
            ) : (
              <Button variant="outline" disabled>
                <Download /> Export
              </Button>
            )}
            <Button onClick={() => setImporting(true)} disabled={importing}>
              <Upload /> Import
            </Button>
          </>
        }
      />
      {importing && (
        <CatalogImportPanel
          schemas={catalog.data ?? []}
          defaultSchema={selected?.schema ?? selectedSchema?.name}
          onClose={() => setImporting(false)}
          onImported={(r) =>
            setParams(r.tables.length === 1 ? { table: `${r.schema}.${r.tables[0]}` } : { schema: r.schema })
          }
        />
      )}
      {catalog.error && <ErrorAlert error={catalog.error} />}
      <div className="grid gap-4 md:grid-cols-[18rem_minmax(0,1fr)]">
        <Card className="max-h-[75vh] gap-0 overflow-auto py-2">
          {catalog.isLoading ? (
            <Skeleton className="mx-2 h-64" />
          ) : !catalog.data?.length ? (
            <div className="text-muted-foreground grid gap-2 p-4 text-sm">
              <p>No tables yet.</p>
              <p>
                Import a project in the{" "}
                <Link to="/workspace" className="underline">
                  Workspace
                </Link>{" "}
                tab with Parquet files in its <code className="font-mono">data/</code> folder. The project
                becomes a schema and the files its tables.
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
          <SchemaDetail
            schema={selectedSchema}
            onSelectTable={(t) => setParams({ table: `${t.schema}.${t.name}` })}
          />
        ) : (
          <Card className="text-muted-foreground grid min-h-64 place-items-center p-6 text-center text-sm">
            Select a schema or a table.
          </Card>
        )}
      </div>
    </>
  )
}

/** Export button with a menu: CSV, or Parquet files in a ZIP. */
function ExportMenu({
  label,
  what,
  target,
  single,
}: {
  label: string
  what: string
  target: { table?: string; schema?: string }
  single: boolean
}) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !box.current?.contains(e.target as Node))
        setOpen(false)
    }
    document.addEventListener("mousedown", close)
    document.addEventListener("keydown", close)
    return () => {
      document.removeEventListener("mousedown", close)
      document.removeEventListener("keydown", close)
    }
  }, [open])

  const options = [
    {
      format: "csv" as const,
      title: single ? "CSV file" : "CSV files (ZIP)",
      hint: single ? ".csv" : "one .csv per table, in a .zip",
    },
    {
      format: "parquet" as const,
      title: "Parquet (ZIP)",
      hint: single ? ".zip with a .parquet file" : "one .parquet per table, in a .zip",
    },
  ]

  return (
    <div ref={box} className="relative">
      <Button variant="outline" onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open}>
        <Download /> {label} <ChevronDown className="opacity-60" />
      </Button>
      {open && (
        <div
          role="menu"
          className="bg-popover text-popover-foreground absolute right-0 z-30 mt-1 w-64 rounded-md border p-1 shadow-md"
        >
          <p className="text-muted-foreground px-2 pt-1 pb-1.5 text-xs">Download {what} as</p>
          {options.map((o) => (
            <a
              key={o.format}
              role="menuitem"
              href={catalogExportUrl({ ...target, format: o.format })}
              download
              onClick={() => setOpen(false)}
              className="hover:bg-accent flex flex-col rounded px-2 py-1.5 text-sm"
            >
              <span>{o.title}</span>
              <span className="text-muted-foreground text-xs">{o.hint}</span>
            </a>
          ))}
        </div>
      )}
    </div>
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
        <button
          type="button"
          onClick={onSelectSchema}
          className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left"
        >
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

function SchemaDetail({
  schema,
  onSelectTable,
}: {
  schema: CatalogSchema
  onSelectTable: (t: SqlTable) => void
}) {
  return (
    <Card className="min-w-0 gap-0 overflow-hidden py-0">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <Layers className="text-primary size-4" />
        <span className="font-mono font-medium">{schema.name}</span>
        <Badge variant="secondary">schema</Badge>
        <span className="text-muted-foreground text-sm">
          {schema.location === "catalog" ? (
            <>
              catalog folder <code className="font-mono">{schema.data_dir}/</code>
            </>
          ) : schema.project ? (
            <>
              data of project{" "}
              <Link
                to={`/workspace?${new URLSearchParams({ path: schema.project })}`}
                className="font-mono hover:underline"
              >
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
          No tables yet. Add Parquet files to{" "}
          <code className="font-mono">{schema.data_dir ?? `${schema.project}/data`}/</code> and they show up
          here.
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
            {table.in_workspace ? (
              <Link
                to={`/workspace?${new URLSearchParams({ path: table.source })}`}
                className="font-mono hover:underline"
              >
                {table.source}
              </Link>
            ) : (
              <span className="font-mono">{table.source}</span>
            )}
          </span>
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            onClick={() =>
              navigate("/sql", { state: { sql: `SELECT *\nFROM ${table.qualified}\nLIMIT 100;` } })
            }
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

      <div className="grid min-w-0 gap-2">
        <h3 className="text-muted-foreground text-sm">Sample data</h3>
        {preview.error ? (
          <div className="p-4">
            <ErrorAlert title="Could not load sample data" error={preview.error} />
          </div>
        ) : !preview.data ? (
          <Skeleton className="m-4 h-32" />
        ) : (
          <DataGrid
            columns={preview.data.columns}
            rows={preview.data.rows}
            maxHeight="max-h-[50vh]"
            footerNote={preview.data.truncated ? `First ${PREVIEW_ROWS.toLocaleString()} rows` : undefined}
          />
        )}
      </div>
    </div>
  )
}

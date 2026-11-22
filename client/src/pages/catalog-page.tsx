import { useEffect, useMemo, useRef, useState } from "react"
import { Link, useNavigate, useSearchParams } from "react-router"
import {
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  Database,
  Download,
  Eye,
  EyeOff,
  FolderOpen,
  Layers,
  Library,
  RefreshCw,
  Table2,
  Trash2,
  Upload,
} from "lucide-react"

import { CatalogImportPanel } from "@/components/catalog-import-panel"
import { DataGrid } from "@/components/data-grid"
import { DropSchemaPanel, type Dropped } from "@/components/drop-schema-panel"
import { ErrorAlert } from "@/components/error-alert"
import { PageHeader } from "@/components/page-header"
import { ResizeDivider } from "@/components/resize-divider"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { catalogExportUrl, useCatalog, useHiddenSchemas, useRestoreSchema, useSqlQuery } from "@/lib/api"
import type { CatalogSchema, SqlTable } from "@/lib/types"
import { useFillHeight } from "@/lib/use-fill-height"
import { cn } from "@/lib/utils"

const PREVIEW_ROWS = 1000

// The tree's width on md+ screens, set with the divider and remembered in the browser
const TREE_WIDTH_KEY = "prooflix-catalog-tree-width"
const DEFAULT_TREE_WIDTH = 288 // 18rem
const clampTree = (w: number) => Math.min(640, Math.max(200, Math.round(w)))

function loadTreeWidth(): number {
  try {
    const w = Number(localStorage.getItem(TREE_WIDTH_KEY))
    return w ? clampTree(w) : DEFAULT_TREE_WIDTH
  } catch {
    return DEFAULT_TREE_WIDTH
  }
}

/** Schemas (the workspace's own data and one per project) and their tables. */
export function CatalogPage() {
  const catalog = useCatalog()
  const [params, setParams] = useSearchParams()
  const selectedKey = params.get("table") // "schema.table"
  const schemaParam = params.get("schema")
  const catalogParam = params.get("catalog") // a catalog (tenant) selected in the tree

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
  const [dropped, setDropped] = useState<Dropped | null>(null)
  const hidden = useHiddenSchemas()
  const restore = useRestoreSchema()
  const selectedCatalog =
    !selected && !selectedSchema && catalogParam ? (catalog.data?.filter((s) => s.catalog === catalogParam) ?? []) : []
  // Restore what was just hidden: one schema, or every schema of a catalog
  const restoreDropped = async (d: Dropped) => {
    for (const name of d.schemas) await restore.mutateAsync(name)
    setParams(d.kind === "schema" ? { schema: d.name } : { catalog: d.name })
    setDropped(null)
  }
  // On md+ screens the tree and the detail fill the window and scroll inside.
  const panels = useRef<HTMLDivElement>(null)
  const panelsHeight = useFillHeight(panels)
  const [treeWidth, setTreeWidth] = useState(loadTreeWidth)
  const resizeTree = (w: number, save = false) => {
    const next = clampTree(w)
    setTreeWidth(next)
    if (save) {
      try {
        localStorage.setItem(TREE_WIDTH_KEY, String(next))
      } catch {
        /* storage unavailable */
      }
    }
  }

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
            ? `${catalog.data.length} schema${catalog.data.length === 1 ? "" : "s"} · ${tableCount} table${tableCount === 1 ? "" : "s"}. Tables are the data lake's Delta tables (each under its catalog and schema, read at their current version) and Parquet files (a folder of Parquet files is one table), plus imported datasets kept in the catalog folder.`
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
      {dropped && (
        <Alert className="mb-4">
          {dropped.mode === "hide" ? <EyeOff /> : <CheckCircle2 />}
          <AlertTitle>
            {dropped.kind === "schema" ? "Schema" : "Catalog"} {dropped.name}{" "}
            {dropped.mode === "hide" ? "is hidden" : "was deleted from the data lake"}
          </AlertTitle>
          <AlertDescription>
            <p>
              {dropped.mode === "hide"
                ? `${dropped.kind === "schema" ? "Its data is" : `Its schemas (${dropped.schemas.join(", ")}) and their data are`} still in the data lake. Restore from Hidden schemas under the tree.`
                : `Deleted the files of ${dropped.deletedTables.join(", ")}.`}
            </p>
            <div className="mt-2 flex gap-2">
              {dropped.mode === "hide" && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={restore.isPending}
                  onClick={() => restoreDropped(dropped).catch(() => {})}
                >
                  <Eye /> Restore
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => setDropped(null)}>
                Dismiss
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}
      {restore.error && <ErrorAlert title="Could not restore the schema" error={restore.error} />}
      <div
        ref={panels}
        style={{ ...(panelsHeight ? { height: panelsHeight } : {}), ["--tree-width" as string]: `${treeWidth}px` }}
        className="grid gap-4 md:grid-cols-[var(--tree-width)_1.25rem_minmax(0,1fr)] md:grid-rows-[minmax(0,1fr)] md:gap-1"
      >
        <Card className="max-h-[60vh] gap-0 overflow-auto py-2 md:max-h-none">
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
                tab with Parquet files in its <code className="font-mono">data/</code> folder. The project becomes a
                schema and the files its tables.
              </p>
            </div>
          ) : (
            groupByCatalog(catalog.data).map((group) => {
              const picked = selectedKey ?? schemaParam
              return (
                <CatalogNode
                  key={group.catalog ? `catalog:${group.catalog}` : "files"}
                  name={group.catalog}
                  selected={!!group.catalog && selectedCatalog.length > 0 && catalogParam === group.catalog}
                  onSelect={() => setParams({ catalog: group.catalog })}
                  containsSelected={group.schemas.some((s) => picked === s.name || !!picked?.startsWith(`${s.name}.`))}
                >
                  {group.schemas.map((s) => (
                    <SchemaNode
                      key={s.name}
                      schema={s}
                      selectedKey={selectedKey}
                      schemaSelected={!selected && schemaParam === s.name}
                      onSelectTable={(t) => setParams({ table: `${s.name}.${t.name}` })}
                      onSelectSchema={() => setParams({ schema: s.name })}
                    />
                  ))}
                </CatalogNode>
              )
            })
          )}
          {!!hidden.data?.length && (
            <HiddenSchemas
              names={hidden.data}
              restoring={restore.isPending ? restore.variables : undefined}
              onRestore={(name) =>
                restore.mutate(name, {
                  onSuccess: () => {
                    setParams({ schema: name })
                    if (dropped?.schemas.includes(name)) setDropped(null)
                  },
                })
              }
            />
          )}
        </Card>
        <ResizeDivider
          orientation="vertical"
          className="hidden md:flex"
          label="Resize the tree and the table panel"
          value={treeWidth}
          onResize={(w) => resizeTree(w)}
          onDone={(w) => resizeTree(w, true)}
          onReset={() => resizeTree(DEFAULT_TREE_WIDTH, true)}
        />

        {selected ? (
          <TableDetail table={selected} />
        ) : selectedSchema ? (
          <SchemaDetail
            key={selectedSchema.name}
            schema={selectedSchema}
            onSelectTable={(t) => setParams({ table: `${t.schema}.${t.name}` })}
            onDropped={(r) => {
              setDropped(r)
              setParams({})
            }}
          />
        ) : selectedCatalog.length && catalogParam ? (
          <CatalogDetail
            key={catalogParam}
            name={catalogParam}
            schemas={selectedCatalog}
            onSelectSchema={(s) => setParams({ schema: s.name })}
            onDropped={(r) => {
              setDropped(r)
              setParams({})
            }}
          />
        ) : (
          <Card className="text-muted-foreground grid min-h-64 place-items-center p-6 text-center text-sm md:min-h-0">
            Select a catalog, a schema or a table.
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
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !box.current?.contains(e.target as Node)) setOpen(false)
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

/**
 * The tree's top level: each catalog (tenant1) with its schemas (bronze, silver, gold), in server order,
 * then one group, catalog "", for the schemas outside a catalog (main, projects' data, imported datasets).
 */
function groupByCatalog(schemas: CatalogSchema[]): { catalog: string; schemas: CatalogSchema[] }[] {
  const catalogs = new Map<string, CatalogSchema[]>()
  const files: CatalogSchema[] = []
  for (const s of schemas) {
    if (s.catalog) catalogs.set(s.catalog, [...(catalogs.get(s.catalog) ?? []), s])
    else files.push(s)
  }
  const groups = [...catalogs].map(([catalog, list]) => ({ catalog, schemas: list }))
  return files.length ? [...groups, { catalog: "", schemas: files }] : groups
}

/** A catalog (tenant1) and its schemas, or, with no name, the group of schemas outside a catalog. */
function CatalogNode({
  name,
  selected,
  onSelect,
  containsSelected,
  children,
}: {
  name: string
  selected: boolean
  onSelect: () => void
  containsSelected: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(true)
  useEffect(() => {
    if (containsSelected) setOpen(true)
  }, [containsSelected])
  return (
    <div>
      <div className={cn("hover:bg-accent flex items-center gap-1.5 px-2 text-sm", selected && "bg-accent")}>
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-label={`${open ? "Collapse" : "Expand"} ${name ? `catalog ${name}` : FILES_GROUP}`}
          className="grid size-4 shrink-0 place-items-center py-1.5"
        >
          <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        </button>
        <button
          type="button"
          // a catalog opens its panel; the files group only folds
          onClick={name ? onSelect : () => setOpen(!open)}
          title={name ? undefined : FILES_GROUP_HINT}
          className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left"
        >
          {name ? (
            <Library className="text-primary size-4 shrink-0" />
          ) : (
            <FolderOpen className="text-muted-foreground size-4 shrink-0" />
          )}
          <span className={cn("truncate text-xs font-medium", name && "font-mono", selected && "font-semibold")}>
            {name || FILES_GROUP}
          </span>
          <span className="text-muted-foreground ml-auto text-[10px] tracking-wide uppercase">
            {name ? "catalog" : "parquet"}
          </span>
        </button>
      </div>
      {open && children}
    </div>
  )
}

// the top-level group for schemas that are not in a catalog
const FILES_GROUP = "Files and datasets"
const FILES_GROUP_HINT =
  "Parquet files outside a catalog: the workspace's data/ folder (main), projects' data and imported datasets"

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
  // "bronze" under catalog tenant1, the full name ("my_project") elsewhere
  const label = schema.catalog ? schema.name.slice(schema.catalog.length + 1) : schema.name
  const [open, setOpen] = useState(true)
  useEffect(() => {
    if (containsSelected) setOpen(true)
  }, [containsSelected])

  return (
    <div>
      <div
        className={cn(
          "hover:bg-accent flex items-center gap-1.5 px-2 pl-6 text-sm",
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
          <span className="truncate font-mono text-xs">{label}</span>
          <span className="text-muted-foreground ml-auto text-xs">{schema.tables.length}</span>
        </button>
      </div>
      {open && (
        <div>
          {schema.tables.length === 0 ? (
            <p className="text-muted-foreground py-1 pr-2 pl-14 text-xs italic">no tables</p>
          ) : (
            schema.tables.map((t) => (
              <button
                key={t.name}
                type="button"
                onClick={() => onSelectTable(t)}
                className={cn(
                  "hover:bg-accent flex w-full items-center gap-1.5 py-1 pr-2 pl-13 text-left text-sm",
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

/** Schemas hidden from the GUI, under the tree, each with a Restore button. */
function HiddenSchemas({
  names,
  restoring,
  onRestore,
}: {
  names: string[]
  restoring?: string
  onRestore: (name: string) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="mt-2 border-t pt-1">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="text-muted-foreground hover:bg-accent flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-xs"
      >
        <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
        <EyeOff className="size-3.5 shrink-0" />
        Hidden schemas
        <span className="ml-auto">{names.length}</span>
      </button>
      {open &&
        names.map((name) => (
          <div key={name} className="flex items-center gap-1.5 py-0.5 pr-2 pl-8 text-sm">
            <Layers className="text-muted-foreground size-4 shrink-0" />
            <span className="text-muted-foreground truncate font-mono text-xs">{name}</span>
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto h-7 px-2 text-xs"
              disabled={restoring === name}
              onClick={() => onRestore(name)}
            >
              <Eye /> Restore
            </Button>
          </div>
        ))}
    </div>
  )
}

/** A catalog (a tenant such as tenant1): its schemas, and Drop catalog for all of them. */
function CatalogDetail({
  name,
  schemas,
  onSelectSchema,
  onDropped,
}: {
  name: string
  schemas: CatalogSchema[]
  onSelectSchema: (s: CatalogSchema) => void
  onDropped: (result: Dropped) => void
}) {
  const [dropping, setDropping] = useState(false)
  const tables = schemas.reduce((n, s) => n + s.tables.length, 0)
  return (
    <Card className="min-h-0 min-w-0 gap-0 self-start overflow-hidden py-0 md:max-h-full">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-3">
        <Library className="text-primary size-4" />
        <span className="font-mono font-medium">{name}</span>
        <Badge variant="secondary">catalog</Badge>
        <span className="text-muted-foreground text-sm">
          {schemas.length} schema{schemas.length === 1 ? "" : "s"} · {tables} table{tables === 1 ? "" : "s"}
        </span>
        <Button
          size="sm"
          variant="outline"
          className="text-destructive hover:text-destructive ml-auto"
          onClick={() => setDropping(true)}
          disabled={dropping}
        >
          <Trash2 /> Drop catalog
        </Button>
      </div>
      {dropping && (
        <DropSchemaPanel
          kind="catalog"
          name={name}
          schemas={schemas}
          onClose={() => setDropping(false)}
          onDropped={onDropped}
        />
      )}
      <div className="min-h-0 overflow-y-auto">
        <Table>
          <TableHeader className="bg-card sticky top-0 z-[1]">
            <TableRow>
              <TableHead className="pl-4">Schema</TableHead>
              <TableHead>Tables</TableHead>
              <TableHead>Rows</TableHead>
              <TableHead>Folder</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {schemas.map((s) => (
              <TableRow key={s.name} className="cursor-pointer" onClick={() => onSelectSchema(s)}>
                <TableCell className="pl-4 font-mono text-xs font-medium">{s.name.slice(name.length + 1)}</TableCell>
                <TableCell className="tabular-nums">{s.tables.length}</TableCell>
                <TableCell className="tabular-nums">
                  {s.tables.reduce((n, t) => n + t.row_count, 0).toLocaleString()}
                </TableCell>
                <TableCell className="text-muted-foreground font-mono text-xs">{s.data_dir}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </Card>
  )
}

function SchemaDetail({
  schema,
  onSelectTable,
  onDropped,
}: {
  schema: CatalogSchema
  onSelectTable: (t: SqlTable) => void
  onDropped: (result: Dropped) => void
}) {
  const [dropping, setDropping] = useState(false)
  return (
    <Card className="min-h-0 min-w-0 gap-0 self-start overflow-hidden py-0 md:max-h-full">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-3">
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
        <Button
          size="sm"
          variant="outline"
          className="text-destructive hover:text-destructive ml-auto"
          onClick={() => setDropping(true)}
          disabled={dropping}
        >
          <Trash2 /> Drop schema
        </Button>
      </div>
      {dropping && (
        <DropSchemaPanel
          kind="schema"
          name={schema.name}
          schemas={[schema]}
          onClose={() => setDropping(false)}
          onDropped={onDropped}
        />
      )}
      {schema.tables.length === 0 ? (
        <div className="text-muted-foreground p-4 text-sm">
          No tables yet. Add Parquet files to{" "}
          <code className="font-mono">{schema.data_dir ?? `${schema.project}/data`}/</code> and they show up here.
        </div>
      ) : (
        <div className="min-h-0 overflow-y-auto">
          <Table>
            <TableHeader className="bg-card sticky top-0 z-[1]">
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
                  <TableCell className="tabular-nums">{t.row_count.toLocaleString()}</TableCell>
                  <TableCell className="tabular-nums">{t.columns.length}</TableCell>
                  <TableCell className="text-muted-foreground font-mono text-xs">{t.source}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
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
    <div className="flex min-h-0 min-w-0 flex-col gap-4">
      <Card className="min-w-0 shrink-0 gap-0 overflow-hidden py-0 md:max-h-[40%] md:shrink">
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-3">
          <Table2 className="text-primary size-4" />
          <span className="font-mono font-medium">{table.qualified}</span>
          <span className="text-muted-foreground text-sm">
            {table.row_count.toLocaleString()} row{table.row_count === 1 ? "" : "s"} · {table.columns.length} column
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
              navigate("/sql", {
                state: { sql: `SELECT *\nFROM ${table.qualified}\nLIMIT 100;` },
              })
            }
          >
            <Database /> Query in SQL Editor
          </Button>
        </div>
        <div className="min-h-0 overflow-y-auto">
          <Table>
            <TableHeader className="bg-card sticky top-0 z-[1]">
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
        </div>
      </Card>

      <div className="flex min-h-0 min-w-0 flex-col gap-2 md:flex-1">
        <h3 className="text-muted-foreground shrink-0 text-sm">Sample data</h3>
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
            maxHeight="max-h-[50vh] md:max-h-none md:min-h-0 md:flex-1"
            className="md:min-h-0 md:flex-1"
            footerNote={preview.data.truncated ? `First ${PREVIEW_ROWS.toLocaleString()} rows` : undefined}
          />
        )}
      </div>
    </div>
  )
}

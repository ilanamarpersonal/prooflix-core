import { useEffect, useMemo, useState } from "react"
import { useNavigate, useSearchParams } from "react-router"
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  FileCode,
  FunctionSquare,
  Link2,
  Loader2,
  Play,
  Plus,
  RotateCcw,
  Save,
  Shapes,
  ShieldCheck,
  Sigma,
  Table2,
  Tag,
  Trash2,
} from "lucide-react"

import { DataGrid } from "@/components/data-grid"
import { ErrorAlert } from "@/components/error-alert"
import { PageHeader } from "@/components/page-header"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { api, useSaveSemanticModel, useSemanticModel, useSemanticTables } from "@/lib/api"
import type {
  SemanticModel,
  SemanticModelFile,
  SemDimension,
  SemEntity,
  SemJoin,
  SemMeasure,
  SemMetric,
  SqlResult,
} from "@/lib/types"
import { cn } from "@/lib/utils"

const selectClass =
  "border-input bg-background h-8 rounded-md border px-2 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
const AGGS: SemMeasure["agg"][] = ["sum", "count", "count_distinct", "avg", "min", "max"]
const ident = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^(\d)/, "_$1")

type Selection = { kind: "model" } | { kind: "entity"; index: number } | { kind: "metrics" }

/** The semantic model: entities, dimensions, measures, joins and metrics, edited and saved to disk. */
export function SemanticPage() {
  const file = useSemanticModel()
  const save = useSaveSemanticModel()
  const [draft, setDraft] = useState<SemanticModel | null>(null)
  const [params, setParams] = useSearchParams()
  const tab = ["explore", "yaml"].includes(params.get("tab") ?? "") ? params.get("tab")! : "model"

  // start editing from the saved model (and again after a reload)
  useEffect(() => {
    if (file.data && draft === null) setDraft(structuredClone(file.data.model))
  }, [file.data, draft])

  const dirty = !!draft && !!file.data && JSON.stringify(draft) !== JSON.stringify(file.data.model)
  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [dirty])

  const doSave = () =>
    draft &&
    save.mutate(
      { model: draft, modified: file.data?.modified ?? null },
      { onSuccess: (d) => setDraft(structuredClone(d.model)) },
    )

  return (
    <div>
      <PageHeader
        title="Semantic model"
        description="Business meaning on top of the catalog's tables: entities with their dimensions (what to group by) and measures (what to add up), joins between them, and metrics built from measures. Saved in the workspace as a YAML file."
        actions={
          tab !== "yaml" && (
            <div className="flex items-center gap-2">
              {file.data && (
                <code className="text-muted-foreground hidden font-mono text-xs lg:inline">{file.data.path}</code>
              )}
              {dirty && <span className="text-muted-foreground text-xs">unsaved changes</span>}
              <Button
                variant="outline"
                onClick={() => file.data && setDraft(structuredClone(file.data.model))}
                disabled={!dirty}
                title="Undo every change since the last save"
              >
                <RotateCcw /> Revert
              </Button>
              <Button onClick={doSave} disabled={!dirty || save.isPending}>
                {save.isPending ? <Loader2 className="animate-spin" /> : <Save />} Save
              </Button>
            </div>
          )
        }
      />
      {file.error && <ErrorAlert title="The model can't be read" error={file.error} />}
      {save.error && (
        <div className="mb-4">
          <ErrorAlert title="Not saved" error={save.error} />
        </div>
      )}
      {!draft ? (
        <Skeleton className="h-64" />
      ) : (
        <Tabs value={tab} onValueChange={(t) => setParams(t === "model" ? {} : { tab: t }, { replace: true })}>
          <TabsList>
            <TabsTrigger value="model">
              <Shapes /> Model
            </TabsTrigger>
            <TabsTrigger value="explore">
              <Play /> Explore
            </TabsTrigger>
            <TabsTrigger value="yaml">
              <FileCode /> YAML
            </TabsTrigger>
          </TabsList>
          <TabsContent value="model" className="mt-4">
            <ModelEditor model={draft} onChange={setDraft} />
          </TabsContent>
          <TabsContent value="explore" className="mt-4">
            <Explore model={draft} />
          </TabsContent>
          <TabsContent value="yaml" className="mt-4">
            <YamlEditor formDirty={dirty} onSaved={(f) => setDraft(structuredClone(f.model))} />
          </TabsContent>
        </Tabs>
      )}
    </div>
  )
}

// ------------------------------------------------------------ editor
function ModelEditor({ model, onChange }: { model: SemanticModel; onChange: (m: SemanticModel) => void }) {
  const [sel, setSel] = useState<Selection>({ kind: "model" })
  const tables = useSemanticTables()
  const [check, setCheck] = useState<{ ok: boolean; problems: { where: string; problem: string }[] } | null>(null)
  const [checking, setChecking] = useState(false)
  const [checkError, setCheckError] = useState<string | null>(null)
  const columnsOf = (table: string) => tables.data?.find((t) => t.table === table)?.columns.map((c) => c.name) ?? []

  const setEntity = (i: number, e: SemEntity) =>
    onChange({ ...model, entities: model.entities.map((x, j) => (j === i ? e : x)) })
  const addEntity = () => {
    const name = ident(`entity_${model.entities.length + 1}`)
    onChange({ ...model, entities: [...model.entities, { name, table: "", dimensions: [], measures: [], joins: [] }] })
    setSel({ kind: "entity", index: model.entities.length })
  }
  const removeEntity = (i: number) => {
    const gone = model.entities[i].name
    if (!window.confirm(`Remove the entity ${gone}, its joins, and the metrics that use it?`)) return
    onChange({
      ...model,
      entities: model.entities
        .filter((_, j) => j !== i)
        .map((e) => ({ ...e, joins: e.joins.filter((jn) => jn.entity !== gone) })),
      metrics: model.metrics.filter((m) => !m.sql.includes(`{${gone}.`)),
    })
    setSel({ kind: "model" })
  }
  const runCheck = async () => {
    setChecking(true)
    setCheckError(null)
    try {
      setCheck(await api.checkSemanticModel(model))
    } catch (e) {
      setCheck(null)
      setCheckError((e as Error).message)
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="grid gap-4 md:grid-cols-[15rem_minmax(0,1fr)]">
      <Card className="h-fit gap-0 py-0">
        <CardContent className="grid gap-0.5 p-2 text-sm">
          <NavItem active={sel.kind === "model"} onClick={() => setSel({ kind: "model" })} icon={Shapes}>
            {model.name || "Model"}
          </NavItem>
          <div className="text-muted-foreground px-2 pt-3 pb-1 text-xs font-medium">Entities</div>
          {model.entities.map((e, i) => (
            <NavItem
              key={i}
              active={sel.kind === "entity" && sel.index === i}
              onClick={() => setSel({ kind: "entity", index: i })}
              icon={Table2}
              hint={`${e.dimensions.length + e.measures.length}`}
            >
              {e.name || "(unnamed)"}
            </NavItem>
          ))}
          <button
            className="text-muted-foreground hover:text-foreground flex items-center gap-2 px-2 py-1.5 text-left"
            onClick={addEntity}
          >
            <Plus className="size-4" /> Add entity
          </button>
          <div className="text-muted-foreground px-2 pt-3 pb-1 text-xs font-medium">Metrics</div>
          <NavItem
            active={sel.kind === "metrics"}
            onClick={() => setSel({ kind: "metrics" })}
            icon={FunctionSquare}
            hint={`${model.metrics.length}`}
          >
            Metrics
          </NavItem>
          <div className="mt-3 border-t px-1 pt-3">
            <Button variant="outline" size="sm" className="w-full" onClick={runCheck} disabled={checking}>
              {checking ? <Loader2 className="animate-spin" /> : <ShieldCheck />} Check against the catalog
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="grid min-w-0 gap-4">
        {checkError && <ErrorAlert title="Can't check the model" error={new Error(checkError)} />}
        {check && (
          <Card className="gap-2 py-3">
            <CardContent className="px-4 text-sm">
              {check.ok ? (
                <span className="text-status-succeeded flex items-center gap-2">
                  <CheckCircle2 className="size-4" /> Every table, column, expression and metric works.
                </span>
              ) : (
                <div className="grid gap-1">
                  <span className="text-destructive flex items-center gap-2 font-medium">
                    <AlertTriangle className="size-4" /> {check.problems.length} problem
                    {check.problems.length === 1 ? "" : "s"}
                  </span>
                  {check.problems.map((p, i) => (
                    <div key={i} className="text-xs">
                      <code className="font-mono">{p.where}</code>:{" "}
                      <span className="text-muted-foreground">{p.problem}</span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {sel.kind === "model" && (
          <Card className="gap-3 py-4">
            <CardHeader className="px-4">
              <CardTitle className="text-base">Model</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 px-4 text-sm">
              <Field label="Name">
                <Input
                  className="max-w-md"
                  value={model.name}
                  onChange={(e) => onChange({ ...model, name: e.target.value })}
                />
              </Field>
              <Field label="Description">
                <Input
                  value={model.description ?? ""}
                  onChange={(e) => onChange({ ...model, description: e.target.value })}
                />
              </Field>
              <p className="text-muted-foreground text-xs">
                {model.entities.length} entities · {model.entities.reduce((n, e) => n + e.dimensions.length, 0)}{" "}
                dimensions · {model.entities.reduce((n, e) => n + e.measures.length, 0)} measures ·{" "}
                {model.metrics.length} metrics. Pick an entity on the left to edit it, or add one for a table of the
                catalog.
              </p>
            </CardContent>
          </Card>
        )}

        {sel.kind === "entity" && model.entities[sel.index] && (
          <EntityEditor
            entity={model.entities[sel.index]}
            others={model.entities.filter((_, j) => j !== sel.index)}
            tables={tables.data?.map((t) => t.table) ?? []}
            columnsOf={columnsOf}
            onChange={(e) => setEntity(sel.index, e)}
            onRemove={() => removeEntity(sel.index)}
          />
        )}

        {sel.kind === "metrics" && (
          <MetricsEditor model={model} onChange={(metrics) => onChange({ ...model, metrics })} />
        )}
      </div>
    </div>
  )
}

function NavItem({
  active,
  onClick,
  icon: Icon,
  hint,
  children,
}: {
  active: boolean
  onClick: () => void
  icon: typeof Table2
  hint?: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "hover:bg-accent flex items-center gap-2 rounded-md px-2 py-1.5 text-left",
        active && "bg-accent font-medium",
      )}
    >
      <Icon className="text-muted-foreground size-4 shrink-0" />
      <span className="truncate">{children}</span>
      {hint && <span className="text-muted-foreground ml-auto text-xs">{hint}</span>}
    </button>
  )
}

function EntityEditor({
  entity: e,
  others,
  tables,
  columnsOf,
  onChange,
  onRemove,
}: {
  entity: SemEntity
  others: SemEntity[]
  tables: string[]
  columnsOf: (t: string) => string[]
  onChange: (e: SemEntity) => void
  onRemove: () => void
}) {
  const cols = columnsOf(e.table)
  const set = (c: Partial<SemEntity>) => onChange({ ...e, ...c })
  const setDim = (i: number, d: SemDimension) => set({ dimensions: e.dimensions.map((x, j) => (j === i ? d : x)) })
  const setMeas = (i: number, m: SemMeasure) => set({ measures: e.measures.map((x, j) => (j === i ? m : x)) })
  const setJoin = (i: number, jn: SemJoin) => set({ joins: e.joins.map((x, j) => (j === i ? jn : x)) })

  return (
    <>
      <Card className="gap-3 py-4">
        <CardHeader className="flex flex-row items-center gap-2 px-4">
          <Table2 className="text-primary size-4" />
          <CardTitle className="flex-1 text-base">Entity {e.name}</CardTitle>
          <Button variant="outline" size="sm" onClick={onRemove}>
            <Trash2 /> Remove entity
          </Button>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-4 px-4 text-sm">
          <Field label="Name">
            <Input className="w-48 font-mono" value={e.name} onChange={(x) => set({ name: ident(x.target.value) })} />
          </Field>
          <Field label="Table">
            <select
              className={cn(selectClass, "h-9 w-80")}
              value={e.table}
              onChange={(x) => set({ table: x.target.value })}
            >
              <option value="">Choose a table…</option>
              {(tables.includes(e.table) || !e.table ? tables : [e.table, ...tables]).map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Primary key">
            <ColumnSelect
              cols={cols}
              value={e.primary_key ?? ""}
              onChange={(v) => set({ primary_key: v || null })}
              allowNone
            />
          </Field>
          <Field label="Description" className="min-w-64 flex-1">
            <Input value={e.description ?? ""} onChange={(x) => set({ description: x.target.value })} />
          </Field>
        </CardContent>
      </Card>

      <Section
        icon={Tag}
        title="Dimensions"
        hint="What to group or filter by: a column, or a SQL expression using the entity's name as the table, like CAST(transactions.transaction_ts AS DATE)."
        onAdd={() =>
          set({
            dimensions: [
              ...e.dimensions,
              { name: ident(`dimension_${e.dimensions.length + 1}`), column: cols[0] ?? "", type: "category" },
            ],
          })
        }
        addLabel="Add dimension"
      >
        {e.dimensions.map((d, i) => (
          <Row key={i} onRemove={() => set({ dimensions: e.dimensions.filter((_, j) => j !== i) })}>
            <Input
              className="h-8 w-40 font-mono"
              value={d.name}
              onChange={(x) => setDim(i, { ...d, name: ident(x.target.value) })}
              aria-label="Dimension name"
            />
            <SourceEditor
              entity={e.name}
              cols={cols}
              column={d.column}
              sql={d.sql}
              onChange={(src) => setDim(i, { ...d, ...src })}
            />
            <select
              className={cn(selectClass, "w-28")}
              value={d.type}
              onChange={(x) => setDim(i, { ...d, type: x.target.value as SemDimension["type"] })}
              aria-label="Type"
            >
              <option value="category">category</option>
              <option value="time">time</option>
              <option value="number">number</option>
            </select>
            <Input
              className="h-8 min-w-40 flex-1"
              placeholder="description"
              value={d.description ?? ""}
              onChange={(x) => setDim(i, { ...d, description: x.target.value })}
            />
          </Row>
        ))}
      </Section>

      <Section
        icon={Sigma}
        title="Measures"
        hint="What to add up: an aggregation of a column or expression. A count needs no column."
        onAdd={() =>
          set({ measures: [...e.measures, { name: ident(`measure_${e.measures.length + 1}`), agg: "count" }] })
        }
        addLabel="Add measure"
      >
        {e.measures.map((m, i) => (
          <Row key={i} onRemove={() => set({ measures: e.measures.filter((_, j) => j !== i) })}>
            <Input
              className="h-8 w-40 font-mono"
              value={m.name}
              onChange={(x) => setMeas(i, { ...m, name: ident(x.target.value) })}
              aria-label="Measure name"
            />
            <select
              className={cn(selectClass, "w-36")}
              value={m.agg}
              onChange={(x) => setMeas(i, { ...m, agg: x.target.value as SemMeasure["agg"] })}
              aria-label="Aggregation"
            >
              {AGGS.map((a) => (
                <option key={a} value={a}>
                  {a.replace("_", " ")}
                </option>
              ))}
            </select>
            <SourceEditor
              entity={e.name}
              cols={cols}
              column={m.column}
              sql={m.sql}
              optional={m.agg === "count"}
              onChange={(src) => setMeas(i, { ...m, ...src })}
            />
            <Input
              className="h-8 min-w-40 flex-1"
              placeholder="description"
              value={m.description ?? ""}
              onChange={(x) => setMeas(i, { ...m, description: x.target.value })}
            />
          </Row>
        ))}
      </Section>

      <Section
        icon={Link2}
        title="Joins"
        hint="How this entity links to another, by a column of each. Explore follows joins to reach the dimensions a query needs."
        onAdd={() =>
          others.length > 0 &&
          set({
            joins: [
              ...e.joins,
              {
                entity: others[0].name,
                column: cols[0] ?? "",
                to_column: columnsOf(others[0].table)[0] ?? "",
                kind: "left",
              },
            ],
          })
        }
        addLabel={others.length ? "Add join" : "Add another entity to join"}
        addDisabled={!others.length}
      >
        {e.joins.map((jn, i) => {
          const target = others.find((o) => o.name === jn.entity)
          return (
            <Row key={i} onRemove={() => set({ joins: e.joins.filter((_, j) => j !== i) })}>
              <ColumnSelect cols={cols} value={jn.column} onChange={(v) => setJoin(i, { ...jn, column: v })} />
              <span className="text-muted-foreground text-xs">=</span>
              <select
                className={cn(selectClass, "w-40")}
                value={jn.entity}
                onChange={(x) => setJoin(i, { ...jn, entity: x.target.value })}
                aria-label="Entity"
              >
                {others.map((o) => (
                  <option key={o.name} value={o.name}>
                    {o.name}
                  </option>
                ))}
              </select>
              <span className="text-muted-foreground text-xs">.</span>
              <ColumnSelect
                cols={target ? columnsOf(target.table) : []}
                value={jn.to_column}
                onChange={(v) => setJoin(i, { ...jn, to_column: v })}
              />
              <select
                className={cn(selectClass, "w-28")}
                value={jn.kind}
                onChange={(x) => setJoin(i, { ...jn, kind: x.target.value as SemJoin["kind"] })}
                aria-label="Join kind"
              >
                <option value="left">left join</option>
                <option value="inner">inner join</option>
              </select>
            </Row>
          )
        })}
      </Section>
    </>
  )
}

/** A column of the table, or a SQL expression. */
function SourceEditor({
  entity,
  cols,
  column,
  sql,
  optional,
  onChange,
}: {
  entity: string
  cols: string[]
  column?: string | null
  sql?: string | null
  optional?: boolean
  onChange: (src: { column: string | null; sql: string | null }) => void
}) {
  const mode = sql ? "sql" : column ? "column" : optional ? "none" : "column"
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <select
        className={cn(selectClass, "w-24")}
        value={mode}
        onChange={(x) =>
          onChange(
            x.target.value === "sql"
              ? { column: null, sql: column ? `${entity}.${column}` : `${entity}.` }
              : x.target.value === "none"
                ? { column: null, sql: null }
                : { column: cols[0] ?? "", sql: null },
          )
        }
        aria-label="Source"
      >
        <option value="column">column</option>
        <option value="sql">SQL</option>
        {optional && <option value="none">rows (*)</option>}
      </select>
      {mode === "column" && (
        <ColumnSelect cols={cols} value={column ?? ""} onChange={(v) => onChange({ column: v, sql: null })} />
      )}
      {mode === "sql" && (
        <Input
          className="h-8 w-72 font-mono text-xs"
          value={sql ?? ""}
          onChange={(x) => onChange({ column: null, sql: x.target.value })}
          aria-label="SQL expression"
        />
      )}
    </div>
  )
}

function ColumnSelect({
  cols,
  value,
  onChange,
  allowNone,
}: {
  cols: string[]
  value: string
  onChange: (v: string) => void
  allowNone?: boolean
}) {
  return (
    <select
      className={cn(selectClass, "w-44 font-mono text-xs")}
      value={value}
      onChange={(x) => onChange(x.target.value)}
      aria-label="Column"
    >
      {(allowNone || !cols.includes(value)) && (
        <option value={allowNone ? "" : value}>{allowNone ? "none" : value || "choose…"}</option>
      )}
      {cols.map((c) => (
        <option key={c} value={c}>
          {c}
        </option>
      ))}
    </select>
  )
}

function MetricsEditor({ model, onChange }: { model: SemanticModel; onChange: (m: SemMetric[]) => void }) {
  const measures = model.entities.flatMap((e) => e.measures.map((m) => `${e.name}.${m.name}`))
  const set = (i: number, m: SemMetric) => onChange(model.metrics.map((x, j) => (j === i ? m : x)))
  return (
    <Section
      icon={FunctionSquare}
      title="Metrics"
      hint="Formulas over measures, written {entity.measure}, like {accounts.total_balance} / NULLIF({accounts.count}, 0). Click a measure to add it to the formula you're editing."
      onAdd={() =>
        onChange([
          ...model.metrics,
          { name: ident(`metric_${model.metrics.length + 1}`), sql: measures[0] ? `{${measures[0]}}` : "" },
        ])
      }
      addLabel="Add metric"
      addDisabled={!measures.length}
    >
      {model.metrics.map((m, i) => (
        <div key={i} className="grid gap-1.5 border-b pb-3 last:border-b-0">
          <Row onRemove={() => onChange(model.metrics.filter((_, j) => j !== i))}>
            <Input
              className="h-8 w-48 font-mono"
              value={m.name}
              onChange={(x) => set(i, { ...m, name: ident(x.target.value) })}
              aria-label="Metric name"
            />
            <Input
              className="h-8 min-w-72 flex-1 font-mono text-xs"
              value={m.sql}
              onChange={(x) => set(i, { ...m, sql: x.target.value })}
              aria-label="Formula"
            />
          </Row>
          <div className="flex flex-wrap items-center gap-1 pl-1">
            {measures.map((ref) => (
              <button
                key={ref}
                type="button"
                onClick={() => set(i, { ...m, sql: `${m.sql}{${ref}}` })}
                className="hover:bg-accent rounded border px-1.5 py-0.5 font-mono text-xs"
              >
                {`{${ref}}`}
              </button>
            ))}
          </div>
          <Input
            className="h-8"
            placeholder="description"
            value={m.description ?? ""}
            onChange={(x) => set(i, { ...m, description: x.target.value })}
          />
        </div>
      ))}
    </Section>
  )
}

function Section({
  icon: Icon,
  title,
  hint,
  onAdd,
  addLabel,
  addDisabled,
  children,
}: {
  icon: typeof Tag
  title: string
  hint: string
  onAdd: () => void
  addLabel: string
  addDisabled?: boolean
  children: React.ReactNode
}) {
  return (
    <Card className="gap-3 py-4">
      <CardHeader className="flex flex-row items-center gap-2 px-4">
        <Icon className="text-primary size-4" />
        <CardTitle className="flex-1 text-base">{title}</CardTitle>
        <Button variant="outline" size="sm" onClick={onAdd} disabled={addDisabled}>
          <Plus /> {addLabel}
        </Button>
      </CardHeader>
      <CardContent className="grid gap-2 px-4 text-sm">
        <p className="text-muted-foreground text-xs">{hint}</p>
        {children}
      </CardContent>
    </Card>
  )
}

function Row({ onRemove, children }: { onRemove: () => void; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {children}
      <Button variant="ghost" size="sm" onClick={onRemove} aria-label="Remove">
        <Trash2 />
      </Button>
    </div>
  )
}

// ------------------------------------------------------------ explore
function Explore({ model }: { model: SemanticModel }) {
  const navigate = useNavigate()
  const [measures, setMeasures] = useState<string[]>([])
  const [dimensions, setDimensions] = useState<string[]>([])
  const [limit, setLimit] = useState(100)
  const [running, setRunning] = useState(false)
  const [out, setOut] = useState<{ sql: string; result: SqlResult } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const allMeasures = useMemo(
    () => [
      ...model.entities.flatMap((e) => e.measures.map((m) => ({ ref: `${e.name}.${m.name}`, desc: m.description }))),
      ...model.metrics.map((m) => ({ ref: m.name, desc: m.description, metric: true })),
    ],
    [model],
  )
  const allDims = useMemo(
    () =>
      model.entities.flatMap((e) =>
        e.dimensions.map((d) => ({ ref: `${e.name}.${d.name}`, desc: d.description, type: d.type })),
      ),
    [model],
  )
  const toggle = (list: string[], set: (l: string[]) => void, ref: string) =>
    set(list.includes(ref) ? list.filter((x) => x !== ref) : [...list, ref])

  const run = async () => {
    setRunning(true)
    setError(null)
    try {
      setOut(await api.querySemantic(model, measures, dimensions, limit))
    } catch (e) {
      setOut(null)
      setError((e as Error).message)
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="grid gap-4">
      <Card className="gap-3 py-4">
        <CardContent className="grid gap-4 px-4 text-sm">
          <div className="grid gap-1.5">
            <span className="flex items-center gap-2 font-medium">
              <Sigma className="size-4" /> Measures and metrics
            </span>
            <div className="flex flex-wrap gap-1.5">
              {allMeasures.map((m) => (
                <Chip
                  key={m.ref}
                  on={measures.includes(m.ref)}
                  onClick={() => toggle(measures, setMeasures, m.ref)}
                  title={m.desc}
                >
                  {"metric" in m && <FunctionSquare className="size-3.5" />} {m.ref}
                </Chip>
              ))}
              {!allMeasures.length && (
                <span className="text-muted-foreground text-xs">No measures yet: add some in the Model tab.</span>
              )}
            </div>
          </div>
          <div className="grid gap-1.5">
            <span className="flex items-center gap-2 font-medium">
              <Tag className="size-4" /> Group by
            </span>
            <div className="flex flex-wrap gap-1.5">
              {allDims.map((d) => (
                <Chip
                  key={d.ref}
                  on={dimensions.includes(d.ref)}
                  onClick={() => toggle(dimensions, setDimensions, d.ref)}
                  title={d.desc}
                >
                  {d.ref}
                  {d.type === "time" && (
                    <Badge variant="outline" className="px-1 text-[10px]">
                      time
                    </Badge>
                  )}
                </Chip>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={run} disabled={running || (!measures.length && !dimensions.length)}>
              {running ? <Loader2 className="animate-spin" /> : <Play />} Run
            </Button>
            <label className="text-muted-foreground flex items-center gap-2 text-xs">
              Rows
              <Input
                type="number"
                min={1}
                max={10000}
                className="h-8 w-24"
                value={limit}
                onChange={(e) => setLimit(Math.max(1, Math.min(10000, +e.target.value || 1)))}
              />
            </label>
            <span className="text-muted-foreground text-xs">Runs the model as you see it, saved or not.</span>
          </div>
        </CardContent>
      </Card>
      {error && <ErrorAlert title="The query didn't run" error={new Error(error)} />}
      {out && (
        <>
          <Card className="gap-2 py-3">
            <CardHeader className="flex flex-row items-center gap-2 px-4">
              <CardTitle className="flex-1 text-sm">SQL written by the model</CardTitle>
              <Button
                variant="outline"
                size="sm"
                onClick={() => navigate("/sql", { state: { sql: out.sql, title: "Semantic query" } })}
              >
                <Database /> Open in SQL Editor
              </Button>
            </CardHeader>
            <CardContent className="px-4">
              <pre className="bg-muted overflow-x-auto rounded-md p-3 font-mono text-xs">{out.sql}</pre>
            </CardContent>
          </Card>
          <DataGrid
            columns={out.result.columns}
            rows={out.result.rows}
            footerNote={`${out.result.row_count.toLocaleString()} rows · ${out.result.elapsed_ms} ms${out.result.truncated ? " · more rows exist" : ""}`}
          />
        </>
      )}
    </div>
  )
}

function Chip({
  on,
  onClick,
  title,
  children,
}: {
  on: boolean
  onClick: () => void
  title?: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={title || undefined}
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        "flex items-center gap-1 rounded-md border px-2 py-1 font-mono text-xs",
        on ? "border-primary bg-primary/10 text-foreground" : "text-muted-foreground hover:bg-accent",
      )}
    >
      {children}
    </button>
  )
}

function Field({ label, className, children }: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("grid content-start gap-1", className)}>
      <span className="text-muted-foreground text-xs">{label}</span>
      {children}
    </div>
  )
}

// ------------------------------------------------------------ YAML (by hand)
/** semantic/model.yaml as text: edited by hand, checked as you type, saved as written. */
function YamlEditor({ formDirty, onSaved }: { formDirty: boolean; onSaved: (f: SemanticModelFile) => void }) {
  const qc = useQueryClient()
  const file = useQuery({ queryKey: ["semantic", "yaml"], queryFn: api.semanticYaml })
  const [text, setText] = useState<string | null>(null)
  const [check, setCheck] = useState<{ ok: boolean; error: string | null; entities?: number; metrics?: number } | null>(
    null,
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<{ status?: number; message: string } | null>(null)

  useEffect(() => {
    if (file.data && text === null) setText(file.data.text)
  }, [file.data, text])
  const dirty = text !== null && !!file.data && text !== file.data.text

  // checked by the server as you type, like saving would
  useEffect(() => {
    if (text === null) return
    setCheck(null)
    let current = true
    const t = setTimeout(() => {
      api
        .validateSemanticYaml(text)
        .then((r) => current && setCheck(r))
        .catch(() => current && setCheck(null))
    }, 400)
    return () => {
      current = false
      clearTimeout(t)
    }
  }, [text])

  const save = async () => {
    if (text === null || !file.data) return
    setSaving(true)
    setError(null)
    try {
      const saved = await api.saveSemanticYaml(text, file.data.modified)
      qc.setQueryData(["semantic", "model"], saved)
      const fresh = await qc.fetchQuery({ queryKey: ["semantic", "yaml"], queryFn: api.semanticYaml })
      setText(fresh.text)
      onSaved(saved)
    } catch (e) {
      setError({ status: (e as { status?: number }).status, message: (e as Error).message })
    } finally {
      setSaving(false)
    }
  }
  const reload = async () => {
    const fresh = await file.refetch()
    if (fresh.data) setText(fresh.data.text)
    setError(null)
  }

  if (file.error) return <ErrorAlert title="The model file can't be read" error={file.error} />
  if (text === null) return <Skeleton className="h-96" />
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <CardHeader className="flex flex-row flex-wrap items-center gap-3 border-b px-4 py-3">
        <FileCode className="text-primary size-4" />
        <CardTitle className="flex-1 font-mono text-sm">{file.data?.path}</CardTitle>
        {check &&
          (check.ok ? (
            <span className="text-status-succeeded flex items-center gap-1 text-xs">
              <CheckCircle2 className="size-4" /> valid · {check.entities} entities, {check.metrics} metrics
            </span>
          ) : (
            <span className="text-destructive flex items-center gap-1 text-xs">
              <AlertTriangle className="size-4" /> not valid
            </span>
          ))}
        {dirty && <span className="text-muted-foreground text-xs">unsaved changes</span>}
        <Button variant="outline" size="sm" onClick={() => setText(file.data!.text)} disabled={!dirty}>
          <RotateCcw /> Revert
        </Button>
        <Button size="sm" onClick={save} disabled={!dirty || saving || check?.ok === false}>
          {saving ? <Loader2 className="animate-spin" /> : <Save />} Save
        </Button>
      </CardHeader>
      {formDirty && (
        <div className="border-b px-4 py-2 text-xs">
          <span className="text-status-running">
            The Model tab has unsaved changes. This text is the saved file; saving here replaces those changes.
          </span>
        </div>
      )}
      {check && !check.ok && <div className="text-destructive border-b px-4 py-2 font-mono text-xs">{check.error}</div>}
      {error && (
        <div className="flex flex-wrap items-start gap-2 border-b p-3">
          <div className="min-w-0 flex-1">
            <ErrorAlert title="Not saved" error={new Error(error.message)} />
          </div>
          {error.status === 409 && (
            <Button variant="outline" size="sm" onClick={reload}>
              Reload the file
            </Button>
          )}
        </div>
      )}
      <textarea
        aria-label="semantic/model.yaml"
        spellCheck={false}
        wrap="off"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
            e.preventDefault()
            if (dirty && check?.ok !== false) void save()
          } else if (e.key === "Tab" && !e.shiftKey) {
            e.preventDefault() // YAML indents with spaces
            const el = e.currentTarget
            const { selectionStart: a, selectionEnd: b } = el
            setText(text.slice(0, a) + "  " + text.slice(b))
            requestAnimationFrame(() => el.setSelectionRange(a + 2, a + 2))
          }
        }}
        className="bg-background min-h-[65vh] w-full resize-y p-4 font-mono text-[13px] leading-relaxed outline-none"
      />
      <div className="text-muted-foreground border-t px-4 py-2 text-xs">
        Saved exactly as written, comments included, once it is a valid model. Tab indents with two spaces, Ctrl/Cmd+S
        saves.
      </div>
    </Card>
  )
}

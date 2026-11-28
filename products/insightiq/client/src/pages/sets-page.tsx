import { useEffect, useMemo, useState } from "react"
import { Link, useNavigate, useParams } from "react-router"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  ArrowRight,
  Boxes,
  Download,
  FileSpreadsheet,
  Play,
  Plus,
  Save,
  Share2,
  SquareTerminal,
  Trash2,
  Waypoints,
  X,
} from "lucide-react"

import { ErrorAlert } from "@prooflix/ui/app/error-alert"
import { PageHeader } from "@prooflix/ui/app/page-header"
import { Badge } from "@prooflix/ui/components/ui/badge"
import { Button } from "@prooflix/ui/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@prooflix/ui/components/ui/card"
import { Input } from "@prooflix/ui/components/ui/input"
import { Skeleton } from "@prooflix/ui/components/ui/skeleton"
import { productHref } from "@prooflix/ui/lib/products"
import { LayerBadge, show, TypeAvatar } from "@/components/ontology-ui"
import { api, exportFileUrl, useExports, useObjectTypes, useSets } from "@/lib/api"
import type { ObjectSetDef, PublishedType, SavedSet, SetFilter, SetResult } from "@/lib/types"
import { cn, formatDateTime } from "@/lib/utils"
import { ObjectAssistPanel } from "@/components/object-assist-panel"

const selectClass =
  "border-input bg-background h-9 rounded-md border px-2 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
const OPS: { op: SetFilter["op"]; label: string; value: boolean }[] = [
  { op: "eq", label: "is", value: true },
  { op: "ne", label: "is not", value: true },
  { op: "contains", label: "contains", value: true },
  { op: "gt", label: ">", value: true },
  { op: "gte", label: "≥", value: true },
  { op: "lt", label: "<", value: true },
  { op: "lte", label: "≤", value: true },
  { op: "in", label: "is one of", value: true },
  { op: "not_null", label: "has a value", value: false },
  { op: "is_null", label: "is empty", value: false },
]

/** The tabs of the Objects screen: search, object sets, proposals from AI apps, and connecting one. */
export function ObjectsNav({ active }: { active: "search" | "sets" | "proposals" | "connect" }) {
  return (
    <div className="bg-muted flex rounded-md p-0.5">
      {(
        [
          ["search", "/objects", "Search"],
          ["sets", "/objects/sets", "Object sets"],
          ["proposals", "/objects/proposals", "Proposals"],
          ["connect", "/objects/connect", "Connect an AI app"],
        ] as const
      ).map(([id, to, label]) => (
        <Link
          key={id}
          to={to}
          className={cn(
            "rounded px-3 py-1 text-sm",
            active === id ? "bg-background font-medium shadow-xs" : "text-muted-foreground",
          )}
        >
          {label}
        </Link>
      ))}
    </div>
  )
}

/** Object sets: start from a type, filter, follow links step by step; save, share and export. */
export function SetsPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const types = useObjectTypes()
  const sets = useSets()
  const byName = useMemo(() => new Map((types.data ?? []).map((t) => [t.api_name, t])), [types.data])
  const saved = sets.data?.sets.find((x) => String(x.id) === id) ?? null
  const [def, setDef] = useState<ObjectSetDef | null>(null)
  const [meta, setMeta] = useState({ name: "", description: "", shared: false })
  const [result, setResult] = useState<SetResult | null>(null)
  const [offset, setOffset] = useState(0)

  // a saved set opens as it was saved; a new one starts from the first type
  useEffect(() => {
    if (saved) {
      // just saved what is on screen: keep its results; another set: start fresh
      const same = def !== null && JSON.stringify(def) === JSON.stringify(saved.set)
      setDef(structuredClone(saved.set))
      setMeta({ name: saved.name, description: saved.description, shared: saved.shared })
      if (!same) setResult(null)
    } else if (!id && types.data && !def) {
      setDef({ type: types.data[0]?.api_name ?? "", filters: [], steps: [] })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved?.id, id, types.data])

  const run = useMutation({
    mutationFn: (o: number) => api.runSet(def!, o),
    onSuccess: (r, o) => {
      setResult(r)
      setOffset(o)
    },
  })
  const save = useMutation({
    mutationFn: () => {
      const body = { ...meta, name: meta.name.trim() || "Untitled set", set: def! }
      return saved ? api.updateSet(saved.id, body) : api.createSet(body)
    },
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["ontology", "sets"] })
      if (!saved) navigate(`/objects/sets/${r.id}`, { replace: true })
    },
  })
  const remove = useMutation({
    mutationFn: (s: SavedSet) => api.deleteSet(s.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["ontology", "sets"] })
      navigate("/objects/sets")
    },
  })
  const exporting = useMutation({
    mutationFn: (format: "csv" | "parquet") => api.startExport(def!, format, meta.name.trim() || "objects"),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["ontology", "exports"] }),
  })

  // the type each step lands on, to offer its links and properties
  const chain = useMemo(() => {
    const out: (PublishedType | undefined)[] = [byName.get(def?.type ?? "")]
    for (const step of def?.steps ?? []) {
      const prev = out[out.length - 1]
      const link = prev?.all_links.find((k) => k.name === step.link)
      out.push(link ? byName.get(link.target) : undefined)
    }
    return out
  }, [def, byName])

  const change = (fn: (d: ObjectSetDef) => void) => {
    setDef((d) => {
      if (!d) return d
      const next = structuredClone(d)
      fn(next)
      return next
    })
    setResult(null)
  }

  return (
    <div>
      <ObjectAssistPanel />
      <PageHeader
        title="Object sets"
        description="Questions built step by step: start from a type, filter, then follow links (search around). Run them on the current data, save and share them, export big results."
        actions={<ObjectsNav active="sets" />}
      />
      {types.error && <ErrorAlert title="The object types can't be read" error={types.error} />}
      <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
        <SetList sets={sets.data?.sets ?? []} available={sets.data?.available ?? true} active={saved?.id} />
        {!def ? (
          <Skeleton className="h-96" />
        ) : (
          <div className="grid content-start gap-4">
            <Card>
              <CardContent className="grid gap-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">Start from</span>
                  <select
                    className={selectClass}
                    value={def.type}
                    onChange={(e) =>
                      change((d) => {
                        d.type = e.target.value
                        d.filters = []
                        d.steps = []
                      })
                    }
                  >
                    {(types.data ?? []).map((t) => (
                      <option key={t.api_name} value={t.api_name}>
                        {t.plural || t.api_name}
                      </option>
                    ))}
                  </select>
                  {chain[0] && <LayerBadge layer={chain[0].source.layer} />}
                </div>
                <Filters
                  type={chain[0]}
                  filters={def.filters}
                  onChange={(filters) => change((d) => void (d.filters = filters))}
                />
                {def.steps.map((step, i) => {
                  const from = chain[i]
                  const lands = chain[i + 1]
                  return (
                    <div key={i} className="grid gap-3 border-l-2 border-violet-400/60 pl-4">
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        <Waypoints className="size-4 text-violet-500" />
                        <span className="font-medium">Search around</span>
                        <select
                          className={selectClass}
                          value={step.link}
                          onChange={(e) =>
                            change((d) => {
                              d.steps[i] = { link: e.target.value, filters: [] }
                              d.steps = d.steps.slice(0, i + 1)
                            })
                          }
                        >
                          {(from?.all_links ?? []).map((k) => (
                            <option key={k.name} value={k.name}>
                              {k.name} → {k.target}
                            </option>
                          ))}
                        </select>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="Remove this step"
                          onClick={() => change((d) => void (d.steps = d.steps.slice(0, i)))}
                        >
                          <X />
                        </Button>
                      </div>
                      <Filters
                        type={lands}
                        filters={step.filters}
                        onChange={(filters) => change((d) => void (d.steps[i]!.filters = filters))}
                      />
                    </div>
                  )
                })}
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!chain[chain.length - 1]?.all_links.length || def.steps.length >= 4}
                    title={def.steps.length >= 4 ? "At most 4 steps" : "Follow a link to the next type"}
                    onClick={() =>
                      change((d) => {
                        const last = chain[chain.length - 1]
                        d.steps.push({ link: last!.all_links[0]!.name, filters: [] })
                      })
                    }
                  >
                    <Waypoints /> Search around
                  </Button>
                  <Button
                    className="ml-auto"
                    loading={run.isPending}
                    disabled={!def.type}
                    onClick={() => run.mutate(0)}
                  >
                    <Play /> Run
                  </Button>
                </div>
              </CardContent>
            </Card>
            {run.error && <ErrorAlert title="The set can't run" error={run.error} />}
            {result && (
              <Results
                result={result}
                byName={byName}
                offset={offset}
                loading={run.isPending}
                onPage={(o) => run.mutate(o)}
              />
            )}
            <Card>
              <CardContent className="grid gap-3">
                <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
                  <Input
                    placeholder="Name"
                    value={meta.name}
                    onChange={(e) => setMeta({ ...meta, name: e.target.value })}
                  />
                  <Input
                    placeholder="Description (optional)"
                    value={meta.description}
                    onChange={(e) => setMeta({ ...meta, description: e.target.value })}
                  />
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="size-4 accent-violet-500"
                      checked={meta.shared}
                      onChange={(e) => setMeta({ ...meta, shared: e.target.checked })}
                    />
                    <Share2 className="size-4" /> Shared
                  </label>
                </div>
                {save.error && <ErrorAlert title="Not saved" error={save.error} />}
                {exporting.error && <ErrorAlert title="The export didn't start" error={exporting.error} />}
                <div className="flex flex-wrap gap-2">
                  <Button
                    loading={save.isPending}
                    disabled={sets.data?.available === false}
                    onClick={() => save.mutate()}
                  >
                    <Save /> {saved ? "Save changes" : "Save set"}
                  </Button>
                  <Button
                    variant="outline"
                    loading={exporting.isPending && exporting.variables === "csv"}
                    onClick={() => exporting.mutate("csv")}
                  >
                    <FileSpreadsheet /> Export CSV
                  </Button>
                  <Button
                    variant="outline"
                    loading={exporting.isPending && exporting.variables === "parquet"}
                    onClick={() => exporting.mutate("parquet")}
                  >
                    <Download /> Export Parquet
                  </Button>
                  {result && (
                    <Button variant="ghost" asChild>
                      <a
                        href={productHref(
                          "ingestiq",
                          `/sql?${new URLSearchParams({ sql: result.sql, title: meta.name || "Object set" })}`,
                        )}
                      >
                        <SquareTerminal /> Open in SQL Editor
                      </a>
                    </Button>
                  )}
                  {saved && (
                    <Button
                      variant="ghost"
                      className="text-muted-foreground ml-auto"
                      loading={remove.isPending}
                      onClick={() => window.confirm(`Delete the set ${saved.name}?`) && remove.mutate(saved)}
                    >
                      <Trash2 /> Delete
                    </Button>
                  )}
                </div>
                {sets.data?.available === false && (
                  <p className="text-muted-foreground text-xs">
                    Saving sets needs the object model's database (PROOFLIX_DATABASE_URL in System); running and
                    exporting work without it.
                  </p>
                )}
              </CardContent>
            </Card>
            <Exports />
          </div>
        )}
      </div>
    </div>
  )
}

function SetList({ sets, available, active }: { sets: SavedSet[]; available: boolean; active?: number }) {
  return (
    <div className="grid content-start gap-1">
      <Button variant="outline" size="sm" className="mb-2 justify-start" asChild>
        <Link to="/objects/sets">
          <Plus /> New set
        </Link>
      </Button>
      <div className="text-muted-foreground px-2 text-xs font-semibold tracking-wide uppercase">Saved sets</div>
      {!available && <p className="text-muted-foreground px-2 text-xs">Needs the object model's database.</p>}
      {available && sets.length === 0 && <p className="text-muted-foreground px-2 text-xs">None yet.</p>}
      {sets.map((s) => (
        <Link
          key={s.id}
          to={`/objects/sets/${s.id}`}
          className={cn(
            "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm",
            active === s.id ? "bg-accent font-medium" : "hover:bg-accent/50",
          )}
        >
          <Boxes className="text-muted-foreground size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{s.name}</span>
          {s.shared && <Share2 className="text-muted-foreground size-3.5" aria-label="shared" />}
        </Link>
      ))}
    </div>
  )
}

function Filters({
  type,
  filters,
  onChange,
}: {
  type?: PublishedType
  filters: SetFilter[]
  onChange: (f: SetFilter[]) => void
}) {
  if (!type) return null
  const props = type.properties.filter((p) => !p.sensitive || type.sees_sensitive)
  const set = (i: number, patch: Partial<SetFilter>) =>
    onChange(filters.map((f, j) => (j === i ? { ...f, ...patch } : f)))
  return (
    <div className="grid gap-2">
      {filters.map((f, i) => {
        const op = OPS.find((o) => o.op === f.op)!
        return (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground w-12 text-right text-xs">{i === 0 ? "where" : "and"}</span>
            <select className={selectClass} value={f.property} onChange={(e) => set(i, { property: e.target.value })}>
              {props.map((p) => (
                <option key={p.api_name}>{p.api_name}</option>
              ))}
            </select>
            <select
              className={selectClass}
              value={f.op}
              onChange={(e) => set(i, { op: e.target.value as SetFilter["op"] })}
            >
              {OPS.map((o) => (
                <option key={o.op} value={o.op}>
                  {o.label}
                </option>
              ))}
            </select>
            {op.value && (
              <Input
                className="h-9 w-48"
                placeholder={f.op === "in" ? "a, b, c" : "value"}
                value={f.value == null ? "" : String(f.value)}
                onChange={(e) => set(i, { value: e.target.value })}
              />
            )}
            <Button
              variant="ghost"
              size="icon"
              aria-label="Remove filter"
              onClick={() => onChange(filters.filter((_, j) => j !== i))}
            >
              <X />
            </Button>
          </div>
        )
      })}
      <div className="pl-14">
        <button
          type="button"
          className="text-xs text-violet-700 hover:underline dark:text-violet-300"
          onClick={() => onChange([...filters, { property: props[0]?.api_name ?? "", op: "eq", value: "" }])}
        >
          + filter {type.plural || type.api_name}
        </button>
      </div>
    </div>
  )
}

function Results({
  result,
  byName,
  offset,
  loading,
  onPage,
}: {
  result: SetResult
  byName: Map<string, PublishedType>
  offset: number
  loading: boolean
  onPage: (offset: number) => void
}) {
  const last = result.steps[result.steps.length - 1]!
  const t = byName.get(last.type)
  const cols = (t?.properties ?? []).filter((p) => p.api_name !== t?.title).slice(0, 4)
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          {result.steps.map((s, i) => (
            <span key={i} className="flex items-center gap-2">
              {i > 0 && (
                <span className="text-muted-foreground flex items-center gap-1 text-xs">
                  <ArrowRight className="size-3" /> {s.link}
                </span>
              )}
              <span
                className={cn(
                  "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-sm",
                  i === result.steps.length - 1 && "border-violet-500 bg-violet-500/10",
                )}
              >
                <TypeAvatar name={s.type} size="sm" />
                <span className="font-semibold">{s.count.toLocaleString()}</span>
                <span className="text-muted-foreground">{byName.get(s.type)?.plural || s.type}</span>
              </span>
            </span>
          ))}
        </div>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        {result.objects.length === 0 ? (
          <p className="text-muted-foreground text-sm">No objects.</p>
        ) : (
          <table className={cn("w-full text-sm", loading && "opacity-60")}>
            <thead className="text-muted-foreground text-left text-xs">
              <tr>
                <th className="pr-3 pb-2 font-medium">{t?.title ?? "title"}</th>
                {cols.map((p) => (
                  <th key={p.api_name} className="pr-3 pb-2 font-medium">
                    {p.label || p.api_name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.objects.map((o) => (
                <tr key={o.pk} className="border-t">
                  <td className="py-2 pr-3">
                    <Link
                      to={`/objects/${o.type}/${encodeURIComponent(o.pk ?? "")}`}
                      className="font-medium text-violet-700 hover:underline dark:text-violet-300"
                    >
                      {show(o.title)}
                    </Link>
                  </td>
                  {cols.map((p) => (
                    <td key={p.api_name} className="py-2 pr-3">
                      {show(o.properties[p.api_name])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="mt-3 flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">
            {result.objects.length
              ? `${offset + 1}–${offset + result.objects.length} of ${last.count.toLocaleString()}`
              : ""}
          </span>
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            disabled={offset === 0 || loading}
            onClick={() => onPage(Math.max(0, offset - 50))}
          >
            Previous
          </Button>
          <Button size="sm" variant="outline" disabled={!result.more || loading} onClick={() => onPage(offset + 50)}>
            Next
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

/** The user's exports: progress while they run, a download when done, kept 24 hours. */
function Exports() {
  const exports = useExports()
  const qc = useQueryClient()
  const remove = useMutation({
    mutationFn: api.deleteExport,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["ontology", "exports"] }),
  })
  if (!exports.data?.length) return null
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Exports</CardTitle>
        <p className="text-muted-foreground text-xs">Kept for 24 hours, for you only.</p>
      </CardHeader>
      <CardContent>
        <ul className="divide-y">
          {exports.data.map((e) => {
            const running = e.state === "queued" || e.state === "running"
            const pct = e.total ? Math.min(100, Math.round((e.rows / e.total) * 100)) : null
            return (
              <li key={e.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                <FileSpreadsheet className="text-muted-foreground size-4" />
                <span className="min-w-0 flex-1">
                  <span className="font-medium">
                    {e.name}.{e.format}
                  </span>
                  <span className="text-muted-foreground block text-xs">
                    {e.type} · {e.rows.toLocaleString()}
                    {e.total ? ` of ${e.total.toLocaleString()}` : ""} rows · {formatDateTime(e.created)}
                    {e.truncated ? " · cut at 5,000,000 rows" : ""}
                  </span>
                  {running && (
                    <span className="bg-muted mt-1 block h-1.5 w-48 overflow-hidden rounded-full">
                      <span
                        className={cn("block h-full bg-violet-500", pct === null && "w-1/3 animate-pulse")}
                        style={pct !== null ? { width: `${pct}%` } : undefined}
                      />
                    </span>
                  )}
                  {e.error && <span className="text-status-failed block text-xs">{e.error}</span>}
                </span>
                {running ? (
                  <Badge variant="outline">{e.state}</Badge>
                ) : e.state === "done" ? (
                  <Button size="sm" asChild>
                    <a href={exportFileUrl(e.id)} download>
                      <Download /> Download
                    </a>
                  </Button>
                ) : (
                  <Badge className="bg-status-failed/15 text-status-failed border-transparent">failed</Badge>
                )}
                {!running && (
                  <Button variant="ghost" size="icon" aria-label="Delete export" onClick={() => remove.mutate(e.id)}>
                    <Trash2 />
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
      </CardContent>
    </Card>
  )
}

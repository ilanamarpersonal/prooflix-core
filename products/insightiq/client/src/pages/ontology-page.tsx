import { useMemo, useState } from "react"
import { Link, useNavigate } from "react-router"
import { Boxes, LayoutGrid, Loader2, Network, Pencil, Plus, Sparkles, Trash2 } from "lucide-react"
import { useQueryClient } from "@tanstack/react-query"

import { ErrorAlert } from "@prooflix/ui/app/error-alert"
import { PageHeader } from "@prooflix/ui/app/page-header"
import { Badge } from "@prooflix/ui/components/ui/badge"
import { Button } from "@prooflix/ui/components/ui/button"
import { Card, CardContent } from "@prooflix/ui/components/ui/card"
import { Skeleton } from "@prooflix/ui/components/ui/skeleton"
import { LayerBadge, suggestLinks, TypeAvatar, type LinkSuggestion } from "@/components/ontology-ui"
import { api, ApiError, useOntologyTypes } from "@/lib/api"
import type { ObjectType } from "@/lib/types"
import { cn } from "@/lib/utils"

interface Node {
  type: ObjectType
  draft: boolean
}

/** The Object Model tab (internally: the ontology): the workspace's object types and links as a graph or a list, and the way into the wizard. */
export function OntologyPage() {
  const types = useOntologyTypes()
  const [view, setView] = useState<"graph" | "list">("graph")
  const [selected, setSelected] = useState<string | null>(null)
  const navigate = useNavigate()

  const nodes = useMemo<Node[]>(() => {
    if (!types.data) return []
    const published = types.data.types.map((t) => ({ type: t, draft: false }))
    const drafts = types.data.drafts
      .filter((d) => !types.data.types.some((t) => t.api_name === d.api_name))
      .map((t) => ({ type: t, draft: true }))
    return [...published, ...drafts]
  }, [types.data])
  const hasDraft = (name: string) => !!types.data?.drafts.some((d) => d.api_name === name)
  const current = nodes.find((n) => n.type.api_name === selected) ?? nodes[0]
  const suggestions = useMemo(
    () =>
      suggestLinks(
        nodes.map((n) => n.type),
        new Set(nodes.filter((n) => !n.draft).map((n) => n.type.api_name)),
      ),
    [nodes],
  )
  const [adding, setAdding] = useState<string | null>(null)
  const [addError, setAddError] = useState<unknown>(null)

  // a suggestion goes into the source type's draft (started from the published type when there is none),
  // then the wizard opens on its Links step: the link is checked against the data before it is published
  const add = async (s: LinkSuggestion) => {
    setAdding(s.source + s.link.api_name)
    setAddError(null)
    try {
      const draft = await api
        .draft(s.source)
        .catch((e) => (e instanceof ApiError && e.status === 404 ? null : Promise.reject(e)))
      const base = draft?.type ?? nodes.find((n) => n.type.api_name === s.source)!.type
      await api.saveDraft(s.source, { ...base, links: [...base.links, s.link] }, draft?.modified ?? null)
      navigate(`/ontology/${s.source}?step=links`)
    } catch (e) {
      setAddError(e)
      setAdding(null)
    }
  }

  return (
    <div>
      <PageHeader
        title="Object Model"
        description="Business objects on top of the catalog's tables, in any layer: bronze, silver or gold. Build an object type step by step, check it against the data, then publish it for the Objects tab and AI Assist."
        actions={
          <>
            <div className="bg-muted flex rounded-md p-0.5">
              {(["graph", "list"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setView(v)}
                  className={cn(
                    "flex items-center gap-1.5 rounded px-2.5 py-1 text-sm capitalize",
                    view === v ? "bg-background shadow-xs" : "text-muted-foreground",
                  )}
                >
                  {v === "graph" ? <Network className="size-4" /> : <LayoutGrid className="size-4" />} {v}
                </button>
              ))}
            </div>
            <Button onClick={() => navigate("/ontology/new")}>
              <Plus /> New object type
            </Button>
          </>
        }
      />
      {types.error && <ErrorAlert title="The object model can't be read" error={types.error} />}
      {types.data?.broken.map((b) => (
        <div key={b} className="mb-3">
          <ErrorAlert title="A definition file can't be read" error={new Error(b)} />
        </div>
      ))}
      {types.isLoading ? (
        <Skeleton className="h-96" />
      ) : nodes.length === 0 ? (
        <EmptyState onNew={() => navigate("/ontology/new")} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
          <div className="grid min-w-0 content-start gap-4">
            {view === "graph" ? (
              <Graph
                nodes={nodes}
                selected={current?.type.api_name}
                onSelect={setSelected}
                suggestions={suggestions}
                onAdd={add}
              />
            ) : (
              <div className="grid content-start gap-3 sm:grid-cols-2">
                {nodes.map((n) => (
                  <TypeCard
                    key={n.type.api_name}
                    node={n}
                    active={current?.type.api_name === n.type.api_name}
                    onClick={() => setSelected(n.type.api_name)}
                  />
                ))}
              </div>
            )}
            {addError != null && <ErrorAlert title="The link wasn't added" error={addError} />}
            {suggestions.length > 0 && <Suggestions suggestions={suggestions} adding={adding} onAdd={add} />}
          </div>
          {current && <Details node={current} hasDraft={hasDraft(current.type.api_name)} />}
        </div>
      )}
    </div>
  )
}

function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <Card>
      <CardContent className="grid justify-items-center gap-3 py-14 text-center">
        <span className="bg-muted flex size-14 items-center justify-center rounded-full">
          <Network className="text-muted-foreground size-7" />
        </span>
        <h2 className="text-lg font-semibold">No object types yet</h2>
        <p className="text-muted-foreground max-w-md text-sm">
          Pick a table from the catalog (bronze, silver or gold), give its rows an identity and meaning, link it to
          other types, and publish it. Each step is checked against the data.
        </p>
        <Button onClick={onNew}>
          <Plus /> New object type
        </Button>
      </CardContent>
    </Card>
  )
}

function TypeCard({ node, active, onClick }: { node: Node; active?: boolean; onClick: () => void }) {
  const t = node.type
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "bg-card hover:bg-accent/40 flex w-full flex-col gap-3 rounded-xl border p-3 text-left shadow-xs transition",
        active && "border-violet-500 ring-2 ring-violet-500/20",
        node.draft && "border-dashed",
      )}
    >
      <div className="flex items-center gap-3">
        <TypeAvatar name={t.api_name} muted={node.draft} />
        <div className="min-w-0">
          <div className="truncate font-semibold">{t.api_name}</div>
          <div className="text-muted-foreground truncate font-mono text-xs">{t.source.table}</div>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2">
        <LayerBadge layer={t.source.layer} short />
        <Badge variant={node.draft ? "outline" : "secondary"}>{node.draft ? "draft" : "published"}</Badge>
      </div>
    </button>
  )
}

const W = 760
const H = 440
const NW = 196
const NH = 92

/** The types on an ellipse, their links as labelled arrows. */
function Graph({
  nodes,
  selected,
  onSelect,
  suggestions,
  onAdd,
}: {
  nodes: Node[]
  selected?: string
  onSelect: (n: string) => void
  suggestions: LinkSuggestion[]
  onAdd: (s: LinkSuggestion) => void
}) {
  const pos = useMemo(() => {
    const out: Record<string, { x: number; y: number }> = {}
    nodes.forEach((n, i) => {
      if (nodes.length === 1) out[n.type.api_name] = { x: W / 2, y: H / 2 }
      else {
        const a = (2 * Math.PI * i) / nodes.length - Math.PI / 2
        out[n.type.api_name] = { x: W / 2 + Math.cos(a) * (W / 2 - NW / 2 - 16), y: H / 2 + Math.sin(a) * (H / 2 - 60) }
      }
    })
    return out
  }, [nodes])
  const edges = nodes.flatMap((n) =>
    n.type.links
      .filter((l) => pos[l.target] && l.target !== n.type.api_name)
      .map((l) => ({
        from: pos[n.type.api_name]!,
        to: pos[l.target]!,
        label: l.api_name,
        draft: n.draft,
        suggestion: null as LinkSuggestion | null,
      })),
  )
  for (const s of suggestions)
    if (pos[s.source] && pos[s.link.target])
      edges.push({ from: pos[s.source]!, to: pos[s.link.target]!, label: s.link.api_name, draft: true, suggestion: s })
  return (
    <div className="bg-muted/30 relative overflow-x-auto rounded-xl border">
      <div
        className="relative mx-auto"
        style={{
          width: W,
          height: H,
          backgroundImage: "radial-gradient(var(--border) 1px, transparent 1px)",
          backgroundSize: "22px 22px",
        }}
      >
        <svg width={W} height={H} className="absolute inset-0">
          <defs>
            <marker id="ont-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M0 0L10 5L0 10z" className="fill-violet-400" />
            </marker>
            <marker
              id="ont-arrow-s"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto"
            >
              <path d="M0 0L10 5L0 10z" className="fill-muted-foreground/60" />
            </marker>
          </defs>
          {edges.map((e, i) => {
            const dx = e.to.x - e.from.x
            const dy = e.to.y - e.from.y
            const len = Math.hypot(dx, dy) || 1
            // stop at the edge of the target card
            const t = Math.min(NW / 2 / Math.abs(dx || 1e-9), NH / 2 / Math.abs(dy || 1e-9)) * len
            const end = { x: e.to.x - (dx / len) * (t + 6), y: e.to.y - (dy / len) * (t + 6) }
            const mid = { x: (e.from.x + end.x) / 2, y: (e.from.y + end.y) / 2 }
            return (
              <g key={i}>
                <line
                  x1={e.from.x}
                  y1={e.from.y}
                  x2={end.x}
                  y2={end.y}
                  className={e.suggestion ? "stroke-muted-foreground/50" : "stroke-violet-400"}
                  strokeWidth={2}
                  strokeDasharray={e.draft ? "6 5" : undefined}
                  markerEnd={e.suggestion ? "url(#ont-arrow-s)" : "url(#ont-arrow)"}
                />
                <foreignObject x={mid.x - 70} y={mid.y - 13} width={140} height={26}>
                  <div className="flex justify-center">
                    {e.suggestion ? (
                      <button
                        type="button"
                        onClick={() => onAdd(e.suggestion!)}
                        title={`Suggested: ${e.suggestion.via}. Add it to a draft and check it.`}
                        className="bg-background text-muted-foreground hover:border-violet-400 hover:text-violet-700 flex items-center gap-1 rounded-full border border-dashed px-2 text-xs font-medium"
                      >
                        <Sparkles className="size-3" /> {e.label}?
                      </button>
                    ) : (
                      <span className="bg-background rounded-full border border-violet-300 px-2 text-xs font-medium text-violet-700 dark:text-violet-300">
                        {e.label}
                      </span>
                    )}
                  </div>
                </foreignObject>
              </g>
            )
          })}
        </svg>
        {nodes.map((n) => {
          const p = pos[n.type.api_name]!
          return (
            <div
              key={n.type.api_name}
              className="absolute"
              style={{ left: p.x - NW / 2, top: p.y - NH / 2, width: NW, height: NH }}
            >
              <TypeCard node={n} active={selected === n.type.api_name} onClick={() => onSelect(n.type.api_name)} />
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** Links the columns suggest, each added with one click (to a draft, checked in the wizard before publishing). */
function Suggestions({
  suggestions,
  adding,
  onAdd,
}: {
  suggestions: LinkSuggestion[]
  adding: string | null
  onAdd: (s: LinkSuggestion) => void
}) {
  return (
    <Card>
      <CardContent className="grid gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Sparkles className="size-4 text-violet-500" /> Suggested links
          </div>
          <p className="text-muted-foreground text-xs">
            Found from columns named like another type's key. Adding one opens the wizard on its Links step, where the
            match rate is checked before you publish.
          </p>
        </div>
        <ul className="divide-y">
          {suggestions.map((s) => (
            <li key={s.source + s.link.api_name} className="flex flex-wrap items-center gap-3 py-2">
              <TypeAvatar name={s.source} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">
                  {s.source} <span className="text-violet-600 dark:text-violet-300">{s.link.api_name}</span> →{" "}
                  {s.link.target}
                  <span className="text-muted-foreground ml-2 text-xs font-normal">
                    {s.link.cardinality.replace(/-/g, " ")}
                  </span>
                </span>
                <code className="text-muted-foreground block truncate text-xs">{s.via}</code>
              </span>
              <Button size="sm" variant="outline" disabled={adding !== null} onClick={() => onAdd(s)}>
                {adding === s.source + s.link.api_name ? <Loader2 className="animate-spin" /> : <Plus />} Add link
              </Button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}

function Details({ node, hasDraft }: { node: Node; hasDraft: boolean }) {
  const t = node.type
  const navigate = useNavigate()
  const qc = useQueryClient()
  const rules = [t.source.rows?.filter && "filter", t.source.rows?.latest_by && `latest per ${t.primary_key}`]
    .filter(Boolean)
    .join(", ")
  const remove = async () => {
    const what = node.draft ? `the draft of ${t.api_name}` : `the published type ${t.api_name}`
    if (!window.confirm(`Remove ${what}? Its definition file is deleted.`)) return
    await (node.draft ? api.deleteDraft(t.api_name) : api.unpublish(t.api_name))
    qc.invalidateQueries({ queryKey: ["ontology"] })
  }
  const rows: [string, React.ReactNode][] = [
    ["Source", <span className="font-mono text-xs break-all">{t.source.table}</span>],
    ["Row rules", rules || "none"],
    ["Key", t.primary_key],
    ["Title", t.title],
    ["Properties", `${t.properties.length} (${t.properties.filter((p) => p.sensitive).length} sensitive)`],
    ["Links", t.links.map((l) => `${l.api_name} → ${l.target}`).join(", ") || "none"],
  ]
  return (
    <Card className="h-fit">
      <CardContent className="grid gap-4">
        <div className="flex items-start gap-3">
          <TypeAvatar name={t.api_name} />
          <div className="min-w-0">
            <div className="text-lg font-semibold">{t.api_name}</div>
            <p className="text-muted-foreground text-sm">{t.description || "No description yet"}</p>
          </div>
        </div>
        <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-2 text-sm">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="min-w-0">{v}</dd>
            </div>
          ))}
        </dl>
        <div className="flex flex-wrap items-center gap-2">
          <LayerBadge layer={t.source.layer} />
          {node.draft ? <Badge variant="outline">draft</Badge> : <Badge variant="secondary">published</Badge>}
          {!node.draft && hasDraft && <Badge variant="outline">draft open</Badge>}
        </div>
        {t.source.layer === "bronze" && (
          <p className="text-muted-foreground text-xs">
            Raw data: rows may repeat per key and hold unmasked personal fields. Mark them sensitive in the wizard.
          </p>
        )}
        <div className="grid gap-2">
          <Button onClick={() => navigate(`/ontology/${t.api_name}`)}>
            <Pencil /> {node.draft || hasDraft ? "Continue in the wizard" : "Edit in the wizard"}
          </Button>
          {!node.draft && (
            <Button variant="outline" asChild>
              <Link to={`/objects?type=${t.api_name}`}>
                <Boxes /> Open in Objects
              </Link>
            </Button>
          )}
          <Button variant="ghost" className="text-muted-foreground" onClick={remove}>
            <Trash2 /> {node.draft ? "Discard the draft" : "Unpublish"}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

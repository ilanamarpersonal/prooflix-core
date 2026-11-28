import { useMemo, useState } from "react"
import { Link, useNavigate, useParams, useSearchParams } from "react-router"
import { ArrowRight, Boxes, ChevronRight, Loader2, Network, Search } from "lucide-react"

import { ErrorAlert } from "@prooflix/ui/app/error-alert"
import { PageHeader } from "@prooflix/ui/app/page-header"
import { Badge } from "@prooflix/ui/components/ui/badge"
import { Button } from "@prooflix/ui/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@prooflix/ui/components/ui/card"
import { Input } from "@prooflix/ui/components/ui/input"
import { Skeleton } from "@prooflix/ui/components/ui/skeleton"
import { LayerBadge, show, TypeAvatar, useDebounced } from "@/components/ontology-ui"
import { useLinked, useObject, useObjectTypes, useSearch } from "@/lib/api"
import type { ObjectLink, OntologyObject, PublishedType } from "@/lib/types"
import { cn } from "@/lib/utils"

const objectPath = (o: OntologyObject) => `/objects/${o.type}/${encodeURIComponent(o.pk ?? "")}`

/** The Objects tab: one search box over every published type, results grouped by type. */
export function ObjectsPage() {
  const [params, setParams] = useSearchParams()
  const type = params.get("type") ?? undefined
  const [text, setText] = useState(params.get("q") ?? "")
  const q = useDebounced(text, 300)
  const types = useObjectTypes()
  const search = useSearch(q, type)
  const byName = useMemo(() => new Map((types.data ?? []).map((t) => [t.api_name, t])), [types.data])
  const setType = (t?: string) => {
    const next = new URLSearchParams(params)
    if (t) next.set("type", t)
    else next.delete("type")
    setParams(next, { replace: true })
  }

  return (
    <div>
      <PageHeader
        title="Objects"
        description="Search the published object types: customers, accounts, anything the object model defines. Open an object to see its properties and follow its links."
      />
      {types.error && <ErrorAlert title="The object types can't be read" error={types.error} />}
      {types.data && types.data.length === 0 ? (
        <Card>
          <CardContent className="grid justify-items-center gap-3 py-14 text-center">
            <span className="bg-muted flex size-14 items-center justify-center rounded-full">
              <Boxes className="text-muted-foreground size-7" />
            </span>
            <h2 className="text-lg font-semibold">Nothing to explore yet</h2>
            <p className="text-muted-foreground max-w-md text-sm">
              Object types appear here once they are published in the Object Model tab.
            </p>
            <Button variant="outline" asChild>
              <Link to="/ontology">
                <Network /> Go to the Object Model
              </Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[14rem_1fr]">
          <div className="grid content-start gap-1">
            <div className="text-muted-foreground mb-1 px-2 text-xs font-semibold tracking-wide uppercase">Types</div>
            <FacetButton active={!type} onClick={() => setType(undefined)}>
              <Boxes className="size-4" /> All types
            </FacetButton>
            {(types.data ?? []).map((t) => (
              <FacetButton key={t.api_name} active={type === t.api_name} onClick={() => setType(t.api_name)}>
                <TypeAvatar name={t.api_name} size="sm" />
                <span className="min-w-0 flex-1 truncate">{t.plural || t.api_name}</span>
                <LayerBadge layer={t.source.layer} short className="px-1.5" />
              </FacetButton>
            ))}
          </div>
          <div className="grid content-start gap-4">
            <div className="relative">
              <Search className="text-muted-foreground absolute top-3 left-3 size-4" />
              <Input
                autoFocus
                className="h-10 pl-9 text-base"
                placeholder={type ? `Search ${byName.get(type)?.plural || type}…` : "Search every object…"}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
              {search.isFetching && (
                <Loader2 className="text-muted-foreground absolute top-3 right-3 size-4 animate-spin" />
              )}
            </div>
            {search.error && <ErrorAlert title="The search failed" error={search.error} />}
            {search.isLoading && <Skeleton className="h-64" />}
            {search.data?.groups.map((g) => {
              const t = byName.get(g.type)
              if (!t || (!type && g.objects.length === 0 && !g.error)) return null
              return (
                <Card key={g.type}>
                  <CardHeader className="flex flex-row items-center gap-3">
                    <TypeAvatar name={t.api_name} size="sm" />
                    <CardTitle className="text-sm">{t.plural || t.api_name}</CardTitle>
                    <LayerBadge layer={t.source.layer} />
                    {!type && g.more && (
                      <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setType(t.api_name)}>
                        More <ArrowRight />
                      </Button>
                    )}
                  </CardHeader>
                  <CardContent>
                    {g.error && <ErrorAlert title={`${t.api_name} can't be read`} error={new Error(g.error)} />}
                    {g.objects.length === 0 && !g.error && <p className="text-muted-foreground text-sm">No match</p>}
                    <ul className="divide-y">
                      {g.objects.map((o) => (
                        <ObjectRow key={o.pk} obj={o} type={t} />
                      ))}
                    </ul>
                    {type && g.more && (
                      <p className="text-muted-foreground mt-2 text-xs">
                        Showing the first 50: search to narrow it down.
                      </p>
                    )}
                  </CardContent>
                </Card>
              )
            })}
            {search.data && !type && search.data.groups.every((g) => g.objects.length === 0) && (
              <p className="text-muted-foreground text-sm">Nothing matches “{q}”.</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function FacetButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
        active ? "bg-accent font-medium" : "hover:bg-accent/50 text-muted-foreground",
      )}
    >
      {children}
    </button>
  )
}

function ObjectRow({ obj, type }: { obj: OntologyObject; type: PublishedType }) {
  const extra = type.properties.filter((p) => p.api_name !== type.title && p.api_name !== type.primary_key).slice(0, 3)
  return (
    <li>
      <Link to={objectPath(obj)} className="hover:bg-accent/40 -mx-2 flex items-center gap-3 rounded-md px-2 py-2">
        <TypeAvatar name={show(obj.title)} size="sm" />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{show(obj.title)}</span>
          <span className="text-muted-foreground block truncate text-xs">
            <span className="font-mono">{obj.pk}</span>
            {extra.map((p) => (
              <span key={p.api_name}>
                {" · "}
                {show(obj.properties[p.api_name])}
              </span>
            ))}
          </span>
        </span>
        <ChevronRight className="text-muted-foreground size-4" />
      </Link>
    </li>
  )
}

/** The object page, fresh for every object (so the chosen tab and link don't carry over). */
export function ObjectRoute() {
  const { type, pk } = useParams()
  return <ObjectPage key={`${type}/${pk}`} />
}

/** One object: its properties and its links, both ways. */
function ObjectPage() {
  const { type = "", pk = "" } = useParams()
  const navigate = useNavigate()
  const obj = useObject(type, pk)
  const types = useObjectTypes()
  const def = types.data?.find((t) => t.api_name === type)
  const [tab, setTab] = useState<"properties" | "links">("properties")
  const [link, setLink] = useState<string | null>(null)
  const links = obj.data?.links ?? []
  const current = link ?? links.find((l) => (l.count ?? 0) > 0)?.name ?? links[0]?.name ?? null

  if (obj.error) return <ErrorAlert title="The object can't be opened" error={obj.error} />
  if (obj.isLoading || !obj.data) return <Skeleton className="h-96" />
  const o = obj.data.object
  const keyProps = (def?.properties ?? []).filter((p) => p.api_name !== def?.title && !p.sensitive).slice(0, 4)

  return (
    <div>
      <div className="text-muted-foreground mb-4 flex items-center gap-1 text-sm">
        <Link to="/objects" className="hover:underline">
          Objects
        </Link>
        <ChevronRight className="size-3.5" />
        <Link to={`/objects?type=${type}`} className="hover:underline">
          {def?.plural || type}
        </Link>
      </div>
      <div className="mb-6 flex flex-wrap items-center gap-4">
        <TypeAvatar name={show(o.title)} size="lg" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-2xl font-semibold tracking-tight">{show(o.title)}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <code className="text-muted-foreground text-xs">
              {type}:{o.pk}
            </code>
            <LayerBadge layer={obj.data.layer} />
            <span className="text-muted-foreground font-mono text-xs">{obj.data.table}</span>
          </div>
        </div>
        <dl className="flex flex-wrap gap-6">
          {keyProps.map((p) => (
            <div key={p.api_name}>
              <dt className="text-muted-foreground text-xs">{p.label || p.api_name}</dt>
              <dd className="font-semibold">
                {show(o.properties[p.api_name])}
                {p.unit && <span className="text-muted-foreground ml-1 text-xs font-normal">{p.unit}</span>}
              </dd>
            </div>
          ))}
        </dl>
      </div>
      <div className="mb-4 flex gap-1 border-b">
        {(["properties", "links"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm capitalize",
              tab === t ? "border-violet-500 font-semibold" : "text-muted-foreground border-transparent",
            )}
          >
            {t}
            {t === "links" && ` (${links.length})`}
          </button>
        ))}
      </div>
      {tab === "properties" ? (
        <Card>
          <CardContent>
            <table className="w-full text-sm">
              <tbody>
                {(def?.properties ?? []).map((p) => (
                  <tr key={p.api_name} className="border-b last:border-0">
                    <td className="w-56 py-2 pr-4 align-top">
                      <div className="font-medium">{p.label || p.api_name}</div>
                      {p.description && <div className="text-muted-foreground text-xs">{p.description}</div>}
                    </td>
                    <td className="py-2 align-top">
                      {show(o.properties[p.api_name])}
                      {p.unit && <span className="text-muted-foreground ml-1 text-xs">{p.unit}</span>}
                      {p.sensitive && (
                        <Badge variant="outline" className="ml-2">
                          sensitive
                        </Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      ) : links.length === 0 ? (
        <p className="text-muted-foreground text-sm">This type has no links.</p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
          <div className="grid content-start gap-1">
            {links.map((l) => (
              <button
                key={l.name}
                type="button"
                onClick={() => setLink(l.name)}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2 py-2 text-left text-sm",
                  current === l.name ? "bg-accent font-medium" : "hover:bg-accent/50",
                )}
              >
                <TypeAvatar name={l.target} size="sm" />
                <span className="min-w-0 flex-1 truncate">
                  {l.name} <span className="text-muted-foreground">→ {l.target}</span>
                </span>
                <Badge variant="secondary">{l.count ?? 0}</Badge>
              </button>
            ))}
          </div>
          {current && (
            <LinkedObjects type={type} pk={pk} link={links.find((l) => l.name === current)!} onOpen={navigate} />
          )}
        </div>
      )}
    </div>
  )
}

function LinkedObjects({
  type,
  pk,
  link,
  onOpen,
}: {
  type: string
  pk: string
  link: ObjectLink
  onOpen: (path: string) => void
}) {
  const linked = useLinked(type, pk, link.name)
  const types = useObjectTypes()
  const target = types.data?.find((t) => t.api_name === link.target)
  const cols = (target?.properties ?? []).filter((p) => p.api_name !== target?.title).slice(0, 4)
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center gap-2">
        <CardTitle className="text-sm">
          {link.name} → {link.target}
        </CardTitle>
        {linked.data && <LayerBadge layer={linked.data.layer} />}
        <span className="text-muted-foreground text-xs">{link.count ?? 0} linked</span>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        {linked.error && <ErrorAlert title="The linked objects can't be read" error={linked.error} />}
        {linked.isLoading ? (
          <Skeleton className="h-32" />
        ) : (linked.data?.objects.length ?? 0) === 0 ? (
          <p className="text-muted-foreground text-sm">No linked objects</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-muted-foreground text-left text-xs">
              <tr>
                <th className="pb-2 font-medium">{target?.title ?? "title"}</th>
                {cols.map((p) => (
                  <th key={p.api_name} className="pb-2 font-medium">
                    {p.label || p.api_name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {linked.data!.objects.map((o) => (
                <tr
                  key={o.pk}
                  className="hover:bg-accent/40 cursor-pointer border-t"
                  onClick={() => onOpen(objectPath(o))}
                >
                  <td className="py-2 pr-3 font-medium text-violet-700 dark:text-violet-300">{show(o.title)}</td>
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
        {linked.data?.more && <p className="text-muted-foreground mt-2 text-xs">Showing the first 50.</p>}
      </CardContent>
    </Card>
  )
}

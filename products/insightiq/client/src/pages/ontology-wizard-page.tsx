import { useEffect, useState } from "react"
import { Link as RouterLink, useNavigate, useParams, useSearchParams } from "react-router"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ArrowLeft,
  ArrowRight,
  Boxes,
  Check as CheckMark,
  Eye,
  Loader2,
  Lock,
  Plus,
  Rocket,
  Save,
  Search,
  Sparkles,
  Trash2,
  X,
} from "lucide-react"

import { ErrorAlert } from "@prooflix/ui/app/error-alert"
import { PageHeader } from "@prooflix/ui/app/page-header"
import { Badge } from "@prooflix/ui/components/ui/badge"
import { Button } from "@prooflix/ui/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@prooflix/ui/components/ui/card"
import { Input } from "@prooflix/ui/components/ui/input"
import { Skeleton } from "@prooflix/ui/components/ui/skeleton"
import {
  blocking,
  CheckList,
  draftFrom,
  fieldName,
  LayerBadge,
  ORDERING,
  suggestLinks,
  show,
  TypeAvatar,
  useDebounced,
  warnings,
} from "@/components/ontology-ui"
import {
  api,
  ApiError,
  useChecks,
  useObjectsStatus,
  useOntologyTypes,
  usePreview,
  usePrincipals,
  usePublish,
  useSources,
} from "@/lib/api"
import type {
  Action,
  Cardinality,
  CheckResult,
  Layer,
  Link,
  ObjectType,
  Principal,
  Property,
  PropType,
  SourceTable,
} from "@/lib/types"
import { cn } from "@/lib/utils"

const STEPS = [
  { id: "source", label: "Source" },
  { id: "identity", label: "Identity" },
  { id: "properties", label: "Properties" },
  { id: "links", label: "Links" },
  { id: "actions", label: "Actions" },
  { id: "access", label: "Access" },
  { id: "review", label: "Review & publish" },
] as const
type StepId = (typeof STEPS)[number]["id"]
const ALL_CHECKS = ["source", "identity", "properties", "links", "actions", "access"]
const TYPES: PropType[] = ["auto", "string", "integer", "number", "decimal", "boolean", "date", "timestamp"]
const selectClass =
  "border-input bg-background h-9 w-full rounded-md border px-2 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"

const notFound = (e: unknown) => e instanceof ApiError && e.status === 404

/** The wizard: a type built step by step from a table in any layer, each step checked against the data. */
export function OntologyWizardPage() {
  const { name } = useParams()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const loaded = useQuery({
    queryKey: ["ontology", "edit", name ?? null],
    queryFn: async () => {
      if (!name) return { draft: null, published: null }
      const draft = await api.draft(name).catch((e) => (notFound(e) ? null : Promise.reject(e)))
      const published = await api.type(name).catch((e) => (notFound(e) ? null : Promise.reject(e)))
      if (!draft && !published) throw new Error(`There is no object type or draft named ${name}`)
      return { draft, published }
    },
    staleTime: Infinity,
    gcTime: 0,
  })

  const [def, setDef] = useState<ObjectType | null>(null)
  const [draftModified, setDraftModified] = useState<number | null>(null)
  const [savedName, setSavedName] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<Date | null>(null)
  const [saveError, setSaveError] = useState<unknown>(null)
  const [saving, setSaving] = useState(false)
  const [step, setStep] = useState(0)
  const [published, setPublished] = useState<{ path: string } | null>(null)

  // start from the draft, else from the published type
  useEffect(() => {
    if (!loaded.data || def) return
    const { draft, published: pub } = loaded.data
    // ?step=links: open on that step (a suggested link was just added to the draft)
    const asked = STEPS.findIndex((s) => s.id === params.get("step"))
    if (draft) {
      setDef(draft.type)
      setDraftModified(draft.modified)
      setSavedName(draft.type.api_name)
      setStep(asked > 0 ? asked : 1)
    } else if (pub) {
      setDef(pub.type)
      setStep(asked > 0 ? asked : 1)
    }
  }, [loaded.data, def, params])

  const original = loaded.data?.published?.type ?? null
  const publishedModified = loaded.data?.published?.modified ?? null
  const stepId: StepId = STEPS[step]!.id
  const settled = useDebounced(def)
  const fresh = settled === def
  const checkSteps = stepId === "review" ? ALL_CHECKS : [stepId]
  const checks = useChecks(settled, checkSteps)
  const stepChecks = checks.data?.checks.filter((c) => stepId === "review" || c.step === stepId) ?? []
  const blocked = !fresh || checks.isFetching || !!checks.error || blocking(stepChecks).length > 0

  const update = (fn: (d: ObjectType) => ObjectType) => setDef((d) => (d ? fn(structuredClone(d)) : d))

  const saveDraft = async (): Promise<boolean> => {
    if (!def) return false
    setSaving(true)
    setSaveError(null)
    try {
      let modified = savedName === def.api_name ? draftModified : null
      const res = await api.saveDraft(def.api_name, def, modified)
      if (savedName && savedName !== def.api_name) await api.deleteDraft(savedName).catch(() => undefined)
      modified = res.modified
      setDraftModified(modified)
      setSavedName(def.api_name)
      setSavedAt(new Date())
      qc.invalidateQueries({ queryKey: ["ontology", "types"] })
      if (!name || name !== def.api_name) navigate(`/ontology/${def.api_name}`, { replace: true })
      return true
    } catch (e) {
      setSaveError(e)
      return false
    } finally {
      setSaving(false)
    }
  }

  const go = async (to: number) => {
    if (to > step && !(await saveDraft())) return
    setStep(to)
    window.scrollTo({ top: 0 })
  }

  if (loaded.error) return <ErrorAlert title="The object type can't be opened" error={loaded.error} />
  if (loaded.isLoading) return <Skeleton className="h-96" />
  if (published && def) return <Published def={def} path={published.path} onAgain={() => navigate("/ontology/new")} />

  return (
    <div>
      <PageHeader
        eyebrow={
          <RouterLink to="/ontology" className="hover:underline">
            Object Model
          </RouterLink>
        }
        title={def ? def.api_name : "New object type"}
        description={
          def ? (
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs">{def.source.table}</span>
              <LayerBadge layer={def.source.layer} />
              {original ? <Badge variant="secondary">published</Badge> : <Badge variant="outline">new</Badge>}
            </span>
          ) : (
            "Choose the table behind it first: any Delta table in the catalog, in bronze, silver or gold."
          )
        }
      />
      <Stepper step={step} enabled={!!def} onSelect={(i) => void go(i)} />
      {saveError != null && (
        <div className="mb-4">
          <ErrorAlert title="The draft wasn't saved" error={saveError} />
        </div>
      )}
      {checks.error && stepId !== "source" && (
        <div className="mb-4">
          <ErrorAlert title="The checks couldn't run" error={checks.error} />
        </div>
      )}

      {stepId === "source" && (
        <SourceStep
          def={def}
          onChoose={(src) => {
            if (def && def.source.table === src.table) return
            if (def && !window.confirm("Start again from this table? Properties and links set so far are replaced."))
              return
            setDef(draftFrom(src))
          }}
          checks={stepChecks}
          checking={checks.isFetching}
        />
      )}
      {def && stepId === "identity" && (
        <IdentityStep def={def} update={update} result={checks.data} checking={checks.isFetching} />
      )}
      {def && stepId === "properties" && (
        <PropertiesStep def={def} update={update} result={checks.data} checking={checks.isFetching} />
      )}
      {def && stepId === "links" && (
        <LinksStep def={def} update={update} result={checks.data} checking={checks.isFetching} />
      )}
      {def && stepId === "actions" && (
        <ActionsStep def={def} update={update} result={checks.data} checking={checks.isFetching} />
      )}
      {def && stepId === "access" && (
        <AccessStep def={def} update={update} result={checks.data} checking={checks.isFetching} />
      )}
      {def && stepId === "review" && (
        <ReviewStep
          def={def}
          original={original}
          result={checks.data}
          checking={checks.isFetching || !fresh}
          modified={publishedModified}
          onPublished={(path) => {
            void api.deleteDraft(def.api_name).catch(() => undefined)
            setPublished({ path })
          }}
        />
      )}

      <Footer
        step={step}
        canBack={step > 0}
        onBack={() => void go(step - 1)}
        onNext={() => void go(step + 1)}
        onSave={() => void saveDraft()}
        canSave={!!def && !saving}
        saving={saving}
        savedAt={savedAt}
        nextDisabled={!def || blocked || saving}
        nextBusy={!!def && (saving || !fresh || checks.isFetching)}
        nextHint={
          !def
            ? "Choose a table"
            : checks.error
              ? "Fix what stops the checks"
              : !fresh || checks.isFetching
                ? "Checking…"
                : blocking(stepChecks).length
                  ? `${blocking(stepChecks).length} check(s) must pass first`
                  : warnings(stepChecks).length
                    ? `${warnings(stepChecks).length} warning(s): you can go on`
                    : ""
        }
        last={stepId === "review"}
      />
    </div>
  )
}

// ------------------------------------------------------------ frame
function Stepper({ step, enabled, onSelect }: { step: number; enabled: boolean; onSelect: (i: number) => void }) {
  return (
    <ol className="mb-6 flex flex-wrap items-center gap-x-2 gap-y-3">
      {STEPS.map((s, i) => {
        const done = i < step
        const now = i === step
        return (
          <li key={s.id} className="flex items-center gap-2">
            <button
              type="button"
              disabled={!enabled || now}
              onClick={() => onSelect(i)}
              className="flex items-center gap-2 disabled:cursor-default"
            >
              <span
                className={cn(
                  "flex size-7 items-center justify-center rounded-full text-xs font-semibold",
                  done && "bg-violet-500 text-white",
                  now && "bg-gradient-to-br from-violet-500 to-pink-600 text-white ring-4 ring-violet-500/20",
                  !done && !now && "text-muted-foreground border-2",
                )}
              >
                {done ? <CheckMark className="size-4" /> : i + 1}
              </span>
              <span className={cn("text-sm", now ? "font-semibold" : done ? "" : "text-muted-foreground")}>
                {s.label}
              </span>
            </button>
            {i < STEPS.length - 1 && <span className={cn("h-0.5 w-6 sm:w-10", done ? "bg-violet-500" : "bg-border")} />}
          </li>
        )
      })}
    </ol>
  )
}

function Footer(props: {
  step: number
  canBack: boolean
  onBack: () => void
  onNext: () => void
  onSave: () => void
  canSave: boolean
  saving: boolean
  savedAt: Date | null
  nextDisabled: boolean
  /** checks are running or the draft is saving: Next shows a spinner until they are done */
  nextBusy: boolean
  nextHint: string
  last: boolean
}) {
  return (
    <div className="bg-background/95 sticky bottom-0 z-10 -mx-4 mt-6 -mb-4 border-t backdrop-blur md:-mx-6 md:-mb-6">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3 md:px-6">
        <Button variant="outline" onClick={props.onBack} disabled={!props.canBack}>
          <ArrowLeft /> Back
        </Button>
        <span className="text-muted-foreground text-xs">
          {props.saving
            ? "Saving the draft…"
            : props.savedAt
              ? `Draft saved · ${props.savedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
              : "The draft is saved at every step"}
        </span>
        <span className="ml-auto text-xs text-muted-foreground">{props.nextHint}</span>
        <Button variant="outline" onClick={props.onSave} disabled={!props.canSave} loading={props.saving}>
          <Save /> Save draft
        </Button>
        {!props.last && (
          <Button onClick={props.onNext} disabled={props.nextDisabled} loading={props.nextBusy}>
            Next: {STEPS[props.step + 1]?.label} <ArrowRight />
          </Button>
        )}
      </div>
    </div>
  )
}

function ChecksCard({
  checks,
  checking,
  title = "Checks",
  oneColumn,
}: {
  checks: CheckResult["checks"]
  checking: boolean
  title?: string
  oneColumn?: boolean
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          {title} {checking && <Loader2 className="text-muted-foreground size-4 animate-spin" />}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <CheckList checks={checks} loading={checking} oneColumn={oneColumn} />
      </CardContent>
    </Card>
  )
}

/** One sample object after the row rules, as the Objects tab will show it. */
function PreviewCard({ def, asUser }: { def: ObjectType; asUser?: string }) {
  const settled = useDebounced(def)
  const preview = usePreview(settled, asUser)
  const obj = preview.data?.objects[0]
  if (asUser && preview.data && !preview.data.visible)
    return (
      <Card className="h-fit lg:sticky lg:top-4">
        <CardContent className="grid justify-items-center gap-2 py-10 text-center">
          <Lock className="text-muted-foreground size-8" />
          <div className="font-semibold">
            {asUser} doesn't see {def.api_name}
          </div>
          <p className="text-muted-foreground text-xs">Add them (or a role they have) to who sees this type.</p>
        </CardContent>
      </Card>
    )
  return (
    <Card className="h-fit lg:sticky lg:top-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          Preview object {preview.isFetching && <Loader2 className="text-muted-foreground size-4 animate-spin" />}
        </CardTitle>
        <p className="text-muted-foreground text-xs">
          {asUser ? `as ${asUser} sees it` : "one sample, after the row rules"}
        </p>
      </CardHeader>
      <CardContent className="grid gap-3">
        {preview.error ? (
          <ErrorAlert title="No preview" error={preview.error} />
        ) : !obj ? (
          <p className="text-muted-foreground text-sm">{preview.isLoading ? "Reading…" : "The table has no rows"}</p>
        ) : (
          <>
            <div className="flex items-center gap-3 rounded-xl bg-gradient-to-br from-violet-500/10 to-pink-500/10 p-3">
              <TypeAvatar name={show(obj.title)} size="lg" />
              <div className="min-w-0">
                <div className="truncate text-lg font-semibold">{show(obj.title)}</div>
                <div className="text-muted-foreground truncate font-mono text-xs">
                  {def.api_name}:{obj.pk}
                </div>
                <div className="mt-1 flex gap-1.5">
                  <LayerBadge layer={def.source.layer} />
                </div>
              </div>
            </div>
            <dl className="grid gap-1.5 text-sm">
              {def.properties.map((p) => (
                <div key={p.api_name} className="flex justify-between gap-3 border-b pb-1.5 last:border-0">
                  <dt className="text-muted-foreground truncate font-mono text-xs">{p.api_name}</dt>
                  <dd className="truncate text-right">
                    {show(obj.properties[p.api_name])}
                    {p.unit && <span className="text-muted-foreground ml-1 text-xs">{p.unit}</span>}
                  </dd>
                </div>
              ))}
            </dl>
          </>
        )}
      </CardContent>
    </Card>
  )
}

// ------------------------------------------------------------ ① source
function SourceStep({
  def,
  onChoose,
  checks,
  checking,
}: {
  def: ObjectType | null
  onChoose: (src: SourceTable) => void
  checks: CheckResult["checks"]
  checking: boolean
}) {
  const sources = useSources()
  const [layer, setLayer] = useState<Layer | "all">("all")
  const [text, setText] = useState("")
  const shown = (sources.data ?? []).filter(
    (s) => (layer === "all" || s.layer === layer) && s.table.toLowerCase().includes(text.toLowerCase()),
  )
  const chosen = sources.data?.find((s) => s.table === def?.source.table)
  const preview = usePreview(def)
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
      <div className="grid content-start gap-4">
        <div className="flex flex-wrap gap-2">
          <div className="relative min-w-48 flex-1">
            <Search className="text-muted-foreground absolute top-2.5 left-2.5 size-4" />
            <Input
              className="pl-8"
              placeholder="Find a table…"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </div>
          <div className="bg-muted flex rounded-md p-0.5">
            {(["all", "bronze", "silver", "gold"] as const).map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => setLayer(l)}
                className={cn(
                  "rounded px-3 py-1 text-sm",
                  layer === l ? "bg-background shadow-xs" : "text-muted-foreground",
                )}
              >
                {l === "all" ? "All layers" : l}
              </button>
            ))}
          </div>
        </div>
        {sources.error && <ErrorAlert title="The catalog can't be read" error={sources.error} />}
        {sources.isLoading ? (
          <Skeleton className="h-64" />
        ) : (
          <div className="grid gap-2">
            {shown.length === 0 && <p className="text-muted-foreground text-sm">No table matches.</p>}
            {shown.map((s) => {
              const on = s.table === def?.source.table
              return (
                <button
                  key={s.table}
                  type="button"
                  onClick={() => onChoose(s)}
                  className={cn(
                    "bg-card hover:bg-accent/40 flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2.5 text-left",
                    on && "border-violet-500 bg-violet-500/5 ring-2 ring-violet-500/20",
                  )}
                >
                  <span
                    className={cn(
                      "flex size-4 items-center justify-center rounded-full border-2",
                      on ? "border-violet-500" : "border-muted-foreground/40",
                    )}
                  >
                    {on && <span className="size-2 rounded-full bg-violet-500" />}
                  </span>
                  <LayerBadge layer={s.layer} short />
                  <span className="min-w-0 flex-1 truncate font-mono text-sm font-medium">{s.table}</span>
                  <span className="text-muted-foreground text-xs">
                    {s.rows.toLocaleString()} rows · {s.columns.length} columns{s.delta ? " · Delta" : ""}
                  </span>
                </button>
              )
            })}
          </div>
        )}
        {def && def.source.layer !== "gold" && (
          <div className="rounded-lg border border-layer-bronze/50 bg-layer-bronze/10 p-3 text-sm">
            <div className="mb-1 flex items-center gap-2 font-medium">
              <LayerBadge layer={def.source.layer} /> What the next steps offer
            </div>
            <p className="text-muted-foreground">
              Rows may repeat per key: step 2 offers row rules (a filter and the newest row per key). Text columns: step
              3 offers casts. Mark personal fields sensitive: they are masked for everyone but admins.
            </p>
          </div>
        )}
        {def && <ChecksCard checks={checks} checking={checking} />}
      </div>
      <Card className="h-fit">
        <CardHeader>
          <CardTitle className="text-sm">Preview</CardTitle>
          <p className="text-muted-foreground text-xs">
            {chosen ? `${chosen.columns.length} columns · ${chosen.rows.toLocaleString()} rows` : "Choose a table"}
          </p>
        </CardHeader>
        {chosen && (
          <CardContent className="grid gap-4">
            <ul className="grid gap-1">
              {chosen.columns.map((c) => (
                <li key={c.name} className="bg-muted/40 flex justify-between gap-2 rounded px-2 py-1 font-mono text-xs">
                  <span className="truncate font-medium">{c.name}</span>
                  <span className="text-muted-foreground">{c.type.toLowerCase()}</span>
                </li>
              ))}
            </ul>
            {preview.data && preview.data.objects.length > 0 && (
              <div>
                <div className="text-muted-foreground mb-1 text-xs font-semibold tracking-wide uppercase">
                  Sample objects
                </div>
                <ul className="grid gap-1 text-sm">
                  {preview.data.objects.map((o, i) => (
                    <li key={i} className="flex justify-between gap-2">
                      <span className="truncate">{show(o.title)}</span>
                      <span className="text-muted-foreground font-mono text-xs">{o.pk}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        )}
      </Card>
    </div>
  )
}

// ------------------------------------------------------------ ② identity and row rules
interface StepProps {
  def: ObjectType
  update: (fn: (d: ObjectType) => ObjectType) => void
  result?: CheckResult
  checking: boolean
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="grid gap-1.5 text-sm">
      <span className="font-medium">{label}</span>
      {children}
      {hint && <span className="text-muted-foreground text-xs">{hint}</span>}
    </label>
  )
}

function IdentityStep({ def, update, result, checking }: StepProps) {
  const sources = useSources()
  const columns = sources.data?.find((s) => s.table === def.source.table)?.columns.map((c) => c.name) ?? []
  const rows = def.source.rows ?? {}
  const latestOn = !!rows.latest_by
  const suggested = columns.filter((c) => ORDERING.test(c))
  const checks = result?.checks.filter((c) => c.step === "identity") ?? []
  const setRows = (patch: Partial<NonNullable<ObjectType["source"]["rows"]>>) =>
    update((d) => ({ ...d, source: { ...d.source, rows: { ...d.source.rows, ...patch } } }))
  const stats = result?.stats
  const needRules = (stats?.before?.duplicate_keys ?? 0) > 0
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
      <div className="grid content-start gap-4">
        <Card>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" hint="A capital letter, then letters and digits: Customer, BankAccount">
              <Input
                value={def.api_name}
                onChange={(e) => update((d) => ({ ...d, api_name: e.target.value.replace(/[^A-Za-z0-9]/g, "") }))}
              />
            </Field>
            <Field label="Plural">
              <Input value={def.plural ?? ""} onChange={(e) => update((d) => ({ ...d, plural: e.target.value }))} />
            </Field>
            <div className="sm:col-span-2">
              <Field label="Description" hint="What one object is. AI Assist reads it.">
                <Input
                  value={def.description ?? ""}
                  placeholder="A person or company that holds accounts at the bank"
                  onChange={(e) => update((d) => ({ ...d, description: e.target.value }))}
                />
              </Field>
            </div>
            <Field label="Primary key" hint="Identifies one object">
              <select
                className={selectClass}
                value={def.primary_key}
                onChange={(e) => update((d) => ({ ...d, primary_key: e.target.value }))}
              >
                {def.properties.map((p) => (
                  <option key={p.api_name} value={p.api_name}>
                    {p.api_name} ({p.column})
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Title property" hint="What an object is called in lists">
              <select
                className={selectClass}
                value={def.title}
                onChange={(e) => update((d) => ({ ...d, title: e.target.value }))}
              >
                {def.properties.map((p) => (
                  <option key={p.api_name} value={p.api_name}>
                    {p.api_name}
                  </option>
                ))}
              </select>
            </Field>
          </CardContent>
        </Card>

        <Card className={cn(needRules && !latestOn && "border-status-failed/50")}>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
              Row rules <LayerBadge layer={def.source.layer} />
              <span className="text-muted-foreground ml-auto text-xs font-normal">
                how the table's rows become one object per key
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <Field label="Filter" hint="One condition on the table's columns, e.g. _op <> 'D' or is_current">
              <Input
                className="font-mono"
                value={rows.filter ?? ""}
                placeholder="no filter"
                onChange={(e) => setRows({ filter: e.target.value || null })}
              />
            </Field>
            <div className="grid gap-1.5 text-sm">
              <span className="font-medium">Latest row per key</span>
              <div className="flex gap-2">
                <button
                  type="button"
                  role="switch"
                  aria-checked={latestOn}
                  onClick={() => setRows({ latest_by: latestOn ? null : (suggested[0] ?? columns[0] ?? null) })}
                  className={cn(
                    "relative h-6 w-11 shrink-0 self-center rounded-full transition",
                    latestOn ? "bg-violet-500" : "bg-muted-foreground/30",
                  )}
                >
                  <span
                    className={cn(
                      "absolute top-0.5 size-5 rounded-full bg-white shadow transition-all",
                      latestOn ? "left-5.5" : "left-0.5",
                    )}
                  />
                </button>
                <select
                  className={selectClass}
                  disabled={!latestOn}
                  value={rows.latest_by ?? ""}
                  onChange={(e) => setRows({ latest_by: e.target.value })}
                >
                  {!latestOn && <option value="">off</option>}
                  {columns.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
                <select
                  className={cn(selectClass, "w-28")}
                  disabled={!latestOn}
                  value={rows.latest_desc === false ? "asc" : "desc"}
                  onChange={(e) => setRows({ latest_desc: e.target.value === "desc" })}
                >
                  <option value="desc">newest</option>
                  <option value="asc">oldest</option>
                </select>
              </div>
              {suggested.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                  <span className="text-muted-foreground">Suggested:</span>
                  {suggested.map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setRows({ latest_by: c })}
                      className="rounded-full bg-violet-500/10 px-2 py-0.5 font-mono text-violet-700 dark:text-violet-300"
                    >
                      {c}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {stats?.before && stats.after && <RuleNumbers before={stats.before} after={stats.after} />}
        <ChecksCard checks={checks} checking={checking} />
      </div>
      <PreviewCard def={def} />
    </div>
  )
}

function RuleNumbers({
  before,
  after,
}: {
  before: NonNullable<CheckResult["stats"]["before"]>
  after: NonNullable<CheckResult["stats"]["after"]>
}) {
  const cards: [string, keyof typeof before][] = [
    ["Rows", "rows"],
    ["Distinct keys", "distinct_keys"],
    ["Duplicate keys", "duplicate_keys"],
    ["Empty keys", "empty_keys"],
  ]
  return (
    <div>
      <div className="text-muted-foreground mb-2 text-xs font-semibold tracking-wide uppercase">What the rules do</div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {cards.map(([label, k]) => {
          const bad = (k === "duplicate_keys" || k === "empty_keys") && after[k] > 0
          const good = (k === "duplicate_keys" || k === "empty_keys") && after[k] === 0
          return (
            <Card key={k} className="gap-1 py-3">
              <CardContent className="px-4">
                <div className="text-muted-foreground text-xs">{label}</div>
                <div
                  className={cn(
                    "text-xs line-through",
                    before[k] !== after[k] ? "text-muted-foreground" : "invisible",
                    k === "duplicate_keys" && before[k] > 0 && "text-status-failed",
                  )}
                >
                  {before[k].toLocaleString()}
                </div>
                <div className={cn("text-2xl font-bold", bad && "text-status-failed", good && "text-status-succeeded")}>
                  {after[k].toLocaleString()}
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>
    </div>
  )
}

// ------------------------------------------------------------ ③ properties
function PropertiesStep({ def, update, result, checking }: StepProps) {
  const sources = useSources()
  const columns = sources.data?.find((s) => s.table === def.source.table)?.columns ?? []
  const unused = columns.filter((c) => !def.properties.some((p) => p.column === c.name))
  const checks = result?.checks.filter((c) => c.step === "properties") ?? []
  const setProp = (i: number, patch: Partial<Property>) =>
    update((d) => {
      const old = d.properties[i]!
      const next = { ...old, ...patch }
      d.properties[i] = next
      // a renamed property stays the key, the title and the source of links
      if (patch.api_name && patch.api_name !== old.api_name) {
        if (d.primary_key === old.api_name) d.primary_key = next.api_name
        if (d.title === old.api_name) d.title = next.api_name
        d.links = d.links.map((l) => (l.from_property === old.api_name ? { ...l, from_property: next.api_name } : l))
      }
      return d
    })
  const fixed = (p: Property) =>
    p.api_name === def.primary_key || p.api_name === def.title || def.links.some((l) => l.from_property === p.api_name)
  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
            Properties
            <span className="text-muted-foreground text-xs font-normal">
              names, descriptions and types: the meaning people and AI Assist rely on
            </span>
            <span
              className="text-muted-foreground ml-auto flex items-center gap-1 text-xs font-normal"
              title="Suggestions from AI Assist come in a later phase"
            >
              <Sparkles className="size-3.5" /> AI suggestions: later phase
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full min-w-[56rem] text-sm">
            <thead className="text-muted-foreground text-left text-xs">
              <tr>
                <th className="pb-2 font-medium">Name</th>
                <th className="pb-2 font-medium">Column</th>
                <th className="pb-2 font-medium">Description</th>
                <th className="pb-2 font-medium">Type</th>
                <th className="pb-2 font-medium">Unit</th>
                <th className="pb-2 text-center font-medium">Searchable</th>
                <th className="pb-2 text-center font-medium">Sensitive</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {def.properties.map((p, i) => (
                <tr key={p.column + i} className="border-t">
                  <td className="py-1.5 pr-2">
                    <Input
                      className="h-8 w-40 font-mono text-xs"
                      value={p.api_name}
                      onChange={(e) => setProp(i, { api_name: fieldName(e.target.value) })}
                    />
                  </td>
                  <td className="text-muted-foreground py-1.5 pr-2 font-mono text-xs">{p.column}</td>
                  <td className="py-1.5 pr-2">
                    <Input
                      className="h-8 min-w-48"
                      value={p.description ?? ""}
                      placeholder="What it means"
                      onChange={(e) => setProp(i, { description: e.target.value })}
                    />
                  </td>
                  <td className="py-1.5 pr-2">
                    <select
                      className={cn(selectClass, "h-8 w-28")}
                      value={p.type ?? "auto"}
                      onChange={(e) => setProp(i, { type: e.target.value as PropType })}
                    >
                      {TYPES.map((t) => (
                        <option key={t} value={t}>
                          {t === "auto" ? "as stored" : `cast: ${t}`}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="py-1.5 pr-2">
                    <Input
                      className="h-8 w-20"
                      value={p.unit ?? ""}
                      onChange={(e) => setProp(i, { unit: e.target.value })}
                    />
                  </td>
                  <td className="py-1.5 text-center">
                    <input
                      type="checkbox"
                      className="size-4 accent-violet-500"
                      checked={!!p.searchable}
                      onChange={(e) => setProp(i, { searchable: e.target.checked })}
                    />
                  </td>
                  <td className="py-1.5 text-center">
                    <input
                      type="checkbox"
                      className="size-4 accent-violet-500"
                      checked={!!p.sensitive}
                      onChange={(e) => setProp(i, { sensitive: e.target.checked })}
                    />
                  </td>
                  <td className="py-1.5 text-right">
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={fixed(p)}
                      title={fixed(p) ? "The key, the title and link properties stay" : "Leave this column out"}
                      onClick={() => update((d) => ({ ...d, properties: d.properties.filter((_, j) => j !== i) }))}
                    >
                      <X />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {unused.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs">
              <span className="text-muted-foreground">Add a column:</span>
              {unused.map((c) => (
                <button
                  key={c.name}
                  type="button"
                  className="hover:bg-accent rounded-full border px-2 py-0.5 font-mono"
                  onClick={() =>
                    update((d) => ({
                      ...d,
                      properties: [...d.properties, { api_name: fieldName(c.name), column: c.name, type: "auto" }],
                    }))
                  }
                >
                  <Plus className="mr-0.5 inline size-3" />
                  {c.name}
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
      <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
        <ChecksCard checks={checks} checking={checking} />
        <PreviewCard def={def} />
      </div>
    </div>
  )
}

// ------------------------------------------------------------ ④ links
function LinksStep({ def, update, result, checking }: StepProps) {
  const types = useOntologyTypes()
  const targets = [def, ...(types.data?.types ?? []).filter((t) => t.api_name !== def.api_name)]
  const checks = result?.checks.filter((c) => c.step === "links") ?? []
  const stats = result?.stats.links ?? {}
  // links this type's key suggests (other types with a column named like it)
  const suggested = suggestLinks(targets, new Set((types.data?.types ?? []).map((t) => t.api_name))).filter(
    (x) => x.source === def.api_name,
  )
  const add = () => {
    const target = targets.find((t) => t.api_name !== def.api_name) ?? def
    update((d) => ({
      ...d,
      links: [
        ...d.links,
        {
          api_name: fieldName(target.plural || `${target.api_name}s`),
          target: target.api_name,
          cardinality: "one-to-many",
          reverse: fieldName(def.api_name),
          from_property: d.primary_key,
          to_property:
            target.properties.find((p) => p.api_name.includes(fieldName(def.api_name)))?.api_name ?? target.primary_key,
        },
      ],
    }))
  }
  const setLink = (i: number, patch: Partial<Link>) =>
    update((d) => {
      d.links[i] = { ...d.links[i]!, ...patch }
      return d
    })
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
      <div className="grid content-start gap-4">
        {suggested.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-violet-400/60 bg-violet-500/5 p-3 text-sm">
            <Sparkles className="size-4 text-violet-500" />
            <span className="font-medium">Suggested:</span>
            {suggested.map((x) => (
              <button
                key={x.link.api_name + x.link.target}
                type="button"
                title={x.via}
                onClick={() => update((d) => ({ ...d, links: [...d.links, x.link] }))}
                className="bg-background hover:border-violet-500 flex items-center gap-1 rounded-full border px-2.5 py-0.5"
              >
                <Plus className="size-3" /> {x.link.api_name} → {x.link.target}
              </button>
            ))}
          </div>
        )}
        {def.links.length === 0 && (
          <Card>
            <CardContent className="text-muted-foreground py-8 text-center text-sm">
              No links yet. A link names a relationship: <i>Customer</i> <b>owns</b> <i>Account</i>. The target must be
              published (or this type itself).
            </CardContent>
          </Card>
        )}
        {def.links.map((l, i) => {
          const target = targets.find((t) => t.api_name === l.target)
          const s = stats[l.api_name]
          return (
            <Card key={i} className="border-violet-500/40">
              <CardContent className="grid gap-4">
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label="From">
                    <Input value={def.api_name} disabled />
                  </Field>
                  <Field label="To">
                    <select
                      className={selectClass}
                      value={l.target}
                      onChange={(e) => {
                        const t = targets.find((x) => x.api_name === e.target.value)
                        setLink(i, { target: e.target.value, to_property: t?.primary_key ?? "" })
                      }}
                    >
                      {targets.map((t) => (
                        <option key={t.api_name} value={t.api_name}>
                          {t.api_name}
                          {t.api_name === def.api_name ? " (this type)" : ""}
                        </option>
                      ))}
                      {!target && <option value={l.target}>{l.target} (not published)</option>}
                    </select>
                  </Field>
                  <Field label="Cardinality">
                    <select
                      className={selectClass}
                      value={l.cardinality}
                      onChange={(e) => setLink(i, { cardinality: e.target.value as Cardinality })}
                    >
                      <option value="one-to-many">one to many</option>
                      <option value="many-to-one">many to one</option>
                      <option value="one-to-one">one to one</option>
                    </select>
                  </Field>
                  <Field label={`Name (${def.api_name} →)`}>
                    <Input
                      className="font-mono"
                      value={l.api_name}
                      onChange={(e) => setLink(i, { api_name: fieldName(e.target.value) })}
                    />
                  </Field>
                  <Field label={`Reverse (← ${l.target})`}>
                    <Input
                      className="font-mono"
                      value={l.reverse ?? ""}
                      placeholder="none"
                      onChange={(e) => setLink(i, { reverse: e.target.value ? fieldName(e.target.value) : null })}
                    />
                  </Field>
                  <div />
                  <Field label={`${def.api_name} property`}>
                    <select
                      className={selectClass}
                      value={l.from_property}
                      onChange={(e) => setLink(i, { from_property: e.target.value })}
                    >
                      {def.properties.map((p) => (
                        <option key={p.api_name}>{p.api_name}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label={`${l.target} property`}>
                    <select
                      className={selectClass}
                      value={l.to_property}
                      onChange={(e) => setLink(i, { to_property: e.target.value })}
                    >
                      {(target?.properties ?? []).map((p) => (
                        <option key={p.api_name}>{p.api_name}</option>
                      ))}
                    </select>
                  </Field>
                  <div className="flex items-end justify-end">
                    <Button
                      variant="ghost"
                      className="text-muted-foreground"
                      onClick={() => update((d) => ({ ...d, links: d.links.filter((_, j) => j !== i) }))}
                    >
                      <Trash2 /> Remove link
                    </Button>
                  </div>
                </div>
                <code className="text-xs text-violet-700 dark:text-violet-300">
                  {l.target}.{l.to_property} = {def.api_name}.{l.from_property}
                </code>
                {s && <MatchRate stats={s} />}
              </CardContent>
            </Card>
          )
        })}
        <div>
          <Button variant="outline" onClick={add}>
            <Plus /> Add link
          </Button>
        </div>
        <ChecksCard checks={checks} checking={checking} />
      </div>
      <PreviewCard def={def} />
    </div>
  )
}

function MatchRate({ stats }: { stats: NonNullable<CheckResult["stats"]["links"]>[string] }) {
  const pct = Math.round(stats.match_rate * 1000) / 10
  const r = 30
  const c = 2 * Math.PI * r
  return (
    <div className="flex flex-wrap items-center gap-5">
      <svg width="80" height="80" viewBox="0 0 80 80" className="shrink-0">
        <circle cx="40" cy="40" r={r} fill="none" strokeWidth="9" className="stroke-muted" />
        <circle
          cx="40"
          cy="40"
          r={r}
          fill="none"
          strokeWidth="9"
          strokeLinecap="round"
          className={pct >= 95 ? "stroke-violet-500" : "stroke-status-cancelled"}
          strokeDasharray={`${(c * stats.match_rate).toFixed(1)} ${c.toFixed(1)}`}
          transform="rotate(-90 40 40)"
        />
        <text x="40" y="44" textAnchor="middle" className="fill-foreground text-[13px] font-bold">
          {pct}%
        </text>
      </svg>
      <dl className="grid flex-1 grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Find their partner</dt>
        <dd>
          {stats.matched.toLocaleString()} of {stats.total.toLocaleString()}
        </dd>
        <dt className="text-muted-foreground">Cardinality found</dt>
        <dd>
          {stats.found.replace(/-/g, " ")} · up to {stats.max_per_source} per source
        </dd>
      </dl>
    </div>
  )
}

// ------------------------------------------------------------ ⑥ review and publish
function changes(
  def: ObjectType,
  original: ObjectType | null,
): { sign: "+" | "~" | "−"; what: string; note: string }[] {
  if (!original)
    return [
      { sign: "+", what: def.api_name, note: "new object type" },
      {
        sign: "+",
        what: `${def.properties.length} properties`,
        note: `${def.properties.filter((p) => p.sensitive).length} sensitive`,
      },
      ...(def.source.rows?.filter || def.source.rows?.latest_by
        ? [
            {
              sign: "+" as const,
              what: "Row rules",
              note: [def.source.rows.filter, def.source.rows.latest_by && `latest by ${def.source.rows.latest_by}`]
                .filter(Boolean)
                .join(", "),
            },
          ]
        : []),
      ...def.links.map((l) => ({ sign: "+" as const, what: `Link ${l.api_name} → ${l.target}`, note: l.cardinality })),
    ]
  const out: { sign: "+" | "~" | "−"; what: string; note: string }[] = []
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  if (def.source.table !== original.source.table)
    out.push({ sign: "~", what: "Source", note: `${original.source.table} → ${def.source.table}` })
  if (!same(def.source.rows ?? {}, original.source.rows ?? {}))
    out.push({ sign: "~", what: "Row rules", note: "changed" })
  for (const k of ["primary_key", "title", "description", "plural"] as const)
    if ((def[k] ?? "") !== (original[k] ?? ""))
      out.push({ sign: "~", what: k.replace("_", " "), note: `${original[k] || "—"} → ${def[k] || "—"}` })
  if (!same(def.access ?? { view: [], sensitive: [] }, original.access ?? { view: [], sensitive: [] }))
    out.push({ sign: "~", what: "Access", note: `seen by ${who(def.access?.view ?? [], "everyone")}` })
  for (const a of def.actions ?? []) {
    const old = (original.actions ?? []).find((x) => x.api_name === a.api_name)
    if (!old) out.push({ sign: "+", what: `action ${a.label || a.api_name}`, note: "added" })
    else if (!same(a, old)) out.push({ sign: "~", what: `action ${a.label || a.api_name}`, note: "changed" })
  }
  for (const a of original.actions ?? [])
    if (!(def.actions ?? []).some((x) => x.api_name === a.api_name))
      out.push({ sign: "−", what: `action ${a.label || a.api_name}`, note: "removed" })
  const byName = (ps: { api_name: string }[]) => new Map(ps.map((p) => [p.api_name, p]))
  for (const [kind, now, then] of [
    ["property", byName(def.properties), byName(original.properties)],
    ["link", byName(def.links), byName(original.links)],
  ] as const) {
    for (const [n, v] of now)
      if (!then.has(n)) out.push({ sign: "+", what: `${kind} ${n}`, note: "added" })
      else if (!same(v, then.get(n))) out.push({ sign: "~", what: `${kind} ${n}`, note: "changed" })
    for (const n of then.keys()) if (!now.has(n)) out.push({ sign: "−", what: `${kind} ${n}`, note: "removed" })
  }
  return out
}

function ReviewStep({
  def,
  original,
  result,
  checking,
  modified,
  onPublished,
}: {
  def: ObjectType
  original: ObjectType | null
  result?: CheckResult
  checking: boolean
  modified: number | null
  onPublished: (path: string) => void
}) {
  const publish = usePublish()
  const list = changes(def, original)
  const checks = result?.checks ?? []
  const blocks = blocking(checks)
  const warns = warnings(checks)
  const sign = { "+": "bg-status-succeeded", "~": "bg-status-cancelled", "−": "bg-status-failed" }
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_1fr_20rem]">
      <Card className="h-fit">
        <CardHeader>
          <CardTitle className="text-sm">Changes</CardTitle>
          <p className="text-muted-foreground text-xs">{original ? "against the published version" : "a new type"}</p>
        </CardHeader>
        <CardContent className="grid gap-2">
          {list.length === 0 && <p className="text-muted-foreground text-sm">No changes</p>}
          {list.map((c, i) => (
            <div key={i} className="bg-muted/40 flex items-center gap-3 rounded-lg px-3 py-2">
              <span
                className={cn(
                  "flex size-6 shrink-0 items-center justify-center rounded-full text-sm font-bold text-white",
                  sign[c.sign],
                )}
              >
                {c.sign}
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium">{c.what}</span>
                <span className="text-muted-foreground block truncate text-xs">{c.note}</span>
              </span>
            </div>
          ))}
        </CardContent>
      </Card>
      <ChecksCard title="Every check, on the whole table" checks={checks} checking={checking} oneColumn />
      <Card className="h-fit overflow-hidden pt-0">
        <div className="bg-gradient-to-br from-violet-500 to-pink-600 px-5 py-4 text-white">
          <div className="text-lg font-bold">{blocks.length ? "Not ready yet" : "Ready to publish"}</div>
          <div className="text-sm text-white/80">
            {checking
              ? "checking…"
              : blocks.length
                ? `${blocks.length} check(s) must pass`
                : `${warns.length} warning(s) accepted`}
          </div>
        </div>
        <CardContent className="grid gap-3 text-sm">
          <div>
            <div className="text-muted-foreground text-xs">Writes</div>
            <code className="text-xs">ontology/{def.api_name.replace(/(?<!^)(?=[A-Z])/g, "_").toLowerCase()}.yaml</code>
          </div>
          <div>
            <div className="text-muted-foreground text-xs">Then</div>
            The Objects tab shows {def.plural || def.api_name} at once.
          </div>
          {publish.error && <ErrorAlert title="Not published" error={publish.error} />}
          <Button
            size="lg"
            disabled={blocks.length > 0}
            loading={checking || publish.isPending}
            onClick={() => publish.mutate({ type: def, modified }, { onSuccess: (r) => onPublished(r.path) })}
            className="bg-gradient-to-r from-violet-500 to-pink-600 text-white hover:opacity-90"
          >
            <Rocket /> Publish {def.api_name}
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}

function Published({ def, path, onAgain }: { def: ObjectType; path: string; onAgain: () => void }) {
  return (
    <Card className="mx-auto max-w-lg">
      <CardContent className="grid justify-items-center gap-3 py-10 text-center">
        <TypeAvatar name={def.api_name} size="lg" />
        <h1 className="text-xl font-semibold">{def.api_name} is published</h1>
        <p className="text-muted-foreground text-sm">
          Written to <code>{path}</code> in the workspace. Its objects are in the Objects tab now.
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button asChild>
            <RouterLink to={`/objects?type=${def.api_name}`}>
              <Boxes /> Open in Objects
            </RouterLink>
          </Button>
          <Button variant="outline" asChild>
            <RouterLink to="/ontology">Back to the object model</RouterLink>
          </Button>
          <Button variant="ghost" onClick={onAgain}>
            <Plus /> Another type
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

// ------------------------------------------------------------ ⑤ actions
const who = (principals: string[], empty: string) =>
  principals.length
    ? principals
        .map((p) =>
          p
            .replace(/^role:admin$/, "admins")
            .replace(/^role:user$/, "every signed-in user")
            .replace(/^user:/, ""),
        )
        .join(", ")
    : empty

/** Choose principals: admins, every signed-in user, or named users. */
function PrincipalPicker({
  value,
  onChange,
  principals,
  empty,
}: {
  value: string[]
  onChange: (v: string[]) => void
  principals: Principal[]
  empty: string
}) {
  const toggle = (p: string) => onChange(value.includes(p) ? value.filter((x) => x !== p) : [...value, p])
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap gap-1.5">
        {principals.map((p) => {
          const on = value.includes(p.principal)
          return (
            <button
              key={p.principal}
              type="button"
              onClick={() => toggle(p.principal)}
              className={cn(
                "flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-sm",
                on
                  ? "border-violet-500 bg-violet-500/10 font-medium text-violet-700 dark:text-violet-300"
                  : "hover:bg-accent",
              )}
            >
              {on && <CheckMark className="size-3" />}
              {p.label}
              {p.role === "admin" && <span className="text-muted-foreground text-xs">(admin)</span>}
            </button>
          )
        })}
      </div>
      <span className="text-muted-foreground text-xs">{value.length ? `Chosen: ${who(value, "")}` : empty}</span>
    </div>
  )
}

function ActionsStep({ def, update, result, checking }: StepProps) {
  const principals = usePrincipals()
  const status = useObjectsStatus()
  const actions = def.actions ?? []
  const checks = result?.checks.filter((c) => c.step === "actions") ?? []
  const editable = def.properties.filter((p) => p.api_name !== def.primary_key)
  const setAction = (i: number, patch: Partial<Action>) =>
    update((d) => {
      const list = [...(d.actions ?? [])]
      list[i] = { ...list[i]!, ...patch }
      return { ...d, actions: list }
    })
  const add = () => {
    const prop = editable.find((p) => /status|state|flag|segment|type/i.test(p.column)) ?? editable[0]
    if (!prop) return
    update((d) => ({
      ...d,
      actions: [
        ...(d.actions ?? []),
        {
          api_name: `set_${prop.api_name}`.slice(0, 60),
          label: `Set ${prop.api_name.replace(/_/g, " ")}`,
          description: "",
          parameters: [{ property: prop.api_name, label: "", required: true, choices: [] }],
          allowed: [],
          require_reason: true,
        },
      ],
    }))
  }
  const db = status.data?.database
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
      <div className="grid content-start gap-4">
        {db && !db.ok && (
          <div className="border-status-cancelled/50 bg-status-cancelled/10 rounded-lg border p-3 text-sm">
            {db.configured
              ? `The object model's database isn't reachable (${db.error}). Actions can be defined, but not run.`
              : "Actions can be defined now; running them needs the object model's database (PROOFLIX_DATABASE_URL in Settings & Management → System)."}
          </div>
        )}
        {actions.length === 0 && (
          <Card>
            <CardContent className="text-muted-foreground py-8 text-center text-sm">
              No actions yet. An action is a controlled change: it sets some properties of one object (say{" "}
              <i>Freeze account</i> sets its <b>status</b>), with a reason, by the people you allow. It never writes the
              table: the change is recorded and shown over it.
            </CardContent>
          </Card>
        )}
        {actions.map((a, i) => (
          <Card key={i} className="border-violet-500/40">
            <CardContent className="grid gap-4">
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Label">
                  <Input value={a.label ?? ""} onChange={(e) => setAction(i, { label: e.target.value })} />
                </Field>
                <Field label="Name">
                  <Input
                    className="font-mono"
                    value={a.api_name}
                    onChange={(e) => setAction(i, { api_name: fieldName(e.target.value) })}
                  />
                </Field>
                <div className="flex items-end justify-end">
                  <Button
                    variant="ghost"
                    className="text-muted-foreground"
                    onClick={() => update((d) => ({ ...d, actions: (d.actions ?? []).filter((_, j) => j !== i) }))}
                  >
                    <Trash2 /> Remove action
                  </Button>
                </div>
                <div className="sm:col-span-3">
                  <Field label="Description">
                    <Input
                      value={a.description ?? ""}
                      placeholder="When to use it"
                      onChange={(e) => setAction(i, { description: e.target.value })}
                    />
                  </Field>
                </div>
              </div>
              <div className="grid gap-2">
                <span className="text-sm font-medium">It sets</span>
                {a.parameters.map((x, j) => (
                  <div key={j} className="bg-muted/40 grid gap-2 rounded-lg p-2 sm:grid-cols-[12rem_1fr_auto_auto]">
                    <select
                      className={selectClass}
                      value={x.property}
                      onChange={(e) => {
                        const params = [...a.parameters]
                        params[j] = { ...x, property: e.target.value }
                        setAction(i, { parameters: params })
                      }}
                    >
                      {editable.map((p) => (
                        <option key={p.api_name}>{p.api_name}</option>
                      ))}
                    </select>
                    <ChoicesInput
                      value={x.choices ?? []}
                      onChange={(choices) => {
                        const params = [...a.parameters]
                        params[j] = { ...x, choices }
                        setAction(i, { parameters: params })
                      }}
                    />
                    <label className="flex items-center gap-1.5 text-sm">
                      <input
                        type="checkbox"
                        className="size-4 accent-violet-500"
                        checked={x.required !== false}
                        onChange={(e) => {
                          const params = [...a.parameters]
                          params[j] = { ...x, required: e.target.checked }
                          setAction(i, { parameters: params })
                        }}
                      />
                      required
                    </label>
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={a.parameters.length === 1}
                      onClick={() => setAction(i, { parameters: a.parameters.filter((_, k) => k !== j) })}
                    >
                      <X />
                    </Button>
                  </div>
                ))}
                <div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      const next = editable.find((p) => !a.parameters.some((x) => x.property === p.api_name))
                      if (next)
                        setAction(i, { parameters: [...a.parameters, { property: next.api_name, required: true }] })
                    }}
                  >
                    <Plus /> Another property
                  </Button>
                </div>
              </div>
              <Field label="Who may run it">
                <PrincipalPicker
                  value={a.allowed}
                  onChange={(v) => setAction(i, { allowed: v })}
                  principals={principals.data ?? []}
                  empty="Nobody chosen: admins only"
                />
              </Field>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4 accent-violet-500"
                  checked={a.require_reason !== false}
                  onChange={(e) => setAction(i, { require_reason: e.target.checked })}
                />
                Ask for a reason (it goes into the audit log)
              </label>
            </CardContent>
          </Card>
        ))}
        <div>
          <Button variant="outline" onClick={add} disabled={editable.length === 0}>
            <Plus /> Add action
          </Button>
        </div>
        <ChecksCard checks={checks} checking={checking} />
      </div>
      <PreviewCard def={def} />
    </div>
  )
}

// ------------------------------------------------------------ ⑥ access
function AccessStep({ def, update, result, checking }: StepProps) {
  const principals = usePrincipals()
  const [asUser, setAsUser] = useState("")
  const access = def.access ?? { view: [], sensitive: [] }
  const checks = result?.checks.filter((c) => c.step === "access") ?? []
  const sensitive = def.properties.filter((p) => p.sensitive)
  const users = (principals.data ?? []).filter((p) => p.principal.startsWith("user:"))
  const setAccess = (patch: Partial<NonNullable<ObjectType["access"]>>) =>
    update((d) => ({ ...d, access: { ...(d.access ?? { view: [], sensitive: [] }), ...patch } }))
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
      <div className="grid content-start gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Eye className="size-4" /> Who sees {def.plural || def.api_name}
              <LayerBadge layer={def.source.layer} />
            </CardTitle>
            <p className="text-muted-foreground text-xs">
              Besides the Objects tab itself. Admins always see everything. People not chosen don't see the type at all:
              not in search, not as a link.
            </p>
          </CardHeader>
          <CardContent>
            <PrincipalPicker
              value={access.view}
              onChange={(v) => setAccess({ view: v })}
              principals={principals.data ?? []}
              empty="Nobody chosen: everyone with the Objects tab"
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Lock className="size-4" /> Who sees sensitive properties
            </CardTitle>
            <p className="text-muted-foreground text-xs">
              {sensitive.length
                ? `${sensitive.map((p) => p.api_name).join(", ")}: shown as •••• to everyone else. Reads are audited.`
                : "No property is marked sensitive (step 3)."}
            </p>
          </CardHeader>
          <CardContent>
            <PrincipalPicker
              value={access.sensitive}
              onChange={(v) => setAccess({ sensitive: v })}
              principals={principals.data ?? []}
              empty="Nobody chosen: admins only"
            />
          </CardContent>
        </Card>
        <ChecksCard checks={checks} checking={checking} />
      </div>
      <div className="grid content-start gap-3">
        <Field label="View as user" hint="The preview shows the type exactly as this user would (never more than you).">
          <select className={selectClass} value={asUser} onChange={(e) => setAsUser(e.target.value)}>
            <option value="">Me</option>
            {users.map((u) => (
              <option key={u.principal} value={u.label}>
                {u.label}
                {u.role === "admin" ? " (admin)" : ""}
              </option>
            ))}
          </select>
        </Field>
        <PreviewCard def={def} asUser={asUser || undefined} />
      </div>
    </div>
  )
}

/** Choices typed as text ("active, frozen"): the text is kept as typed, the list follows it. */
function ChoicesInput({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [text, setText] = useState(value.join(", "))
  return (
    <Input
      placeholder="Choices, separated by commas (empty: any value)"
      value={text}
      onChange={(e) => {
        setText(e.target.value)
        onChange(
          e.target.value
            .split(",")
            .map((c) => c.trim())
            .filter(Boolean),
        )
      }}
    />
  )
}

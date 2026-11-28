import { useEffect, useState } from "react"
import { AlertTriangle, CheckCircle2, Info, Loader2, XCircle } from "lucide-react"

import type { Check, Layer, Link, ObjectType, SourceTable } from "@/lib/types"
import { cn } from "@/lib/utils"

const LAYER_STYLE: Record<Layer, { dot: string; ring: string; word: string }> = {
  bronze: { dot: "bg-layer-bronze", ring: "border-layer-bronze/60 bg-layer-bronze/10", word: "raw" },
  silver: { dot: "bg-layer-silver", ring: "border-layer-silver/60 bg-layer-silver/10", word: "cleaned" },
  gold: { dot: "bg-layer-gold", ring: "border-layer-gold/70 bg-layer-gold/15", word: "curated" },
  unclassified: { dot: "bg-muted-foreground", ring: "border-border bg-muted", word: "no layer" },
}

/** The medallion layer a type's table is in: bronze · raw, silver · cleaned, gold · curated. */
export function LayerBadge({
  layer,
  short = false,
  className,
}: {
  layer?: Layer
  short?: boolean
  className?: string
}) {
  const l = layer ?? "unclassified"
  const s = LAYER_STYLE[l]
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        s.ring,
        className,
      )}
      title={`${l} layer`}
    >
      <span className={cn("size-2 rounded-full", s.dot)} />
      {short ? l : `${l} · ${s.word}`}
    </span>
  )
}

/** A type's round tile with its first letter, in InsightIQ's colours. */
export function TypeAvatar({ name, size = "md", muted }: { name: string; size?: "sm" | "md" | "lg"; muted?: boolean }) {
  const sizes = { sm: "size-7 text-xs rounded-lg", md: "size-9 text-sm rounded-xl", lg: "size-14 text-xl rounded-full" }
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center bg-gradient-to-br from-violet-500 to-pink-600 font-semibold text-white",
        sizes[size],
        muted && "opacity-50",
      )}
    >
      {initials(name)}
    </span>
  )
}

export const initials = (text: string) =>
  text
    .split(/[\s_]+|(?=[A-Z])/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("") || "?"

/** A check of the wizard: red blocks Next, amber is a warning that can be accepted, blue is information. */
export function CheckList({
  checks,
  loading,
  empty,
  oneColumn,
}: {
  checks: Check[]
  loading?: boolean
  empty?: string
  oneColumn?: boolean
}) {
  if (!checks.length)
    return (
      <p className="text-muted-foreground flex items-center gap-2 text-sm">
        {loading && <Loader2 className="size-4 animate-spin" />}
        {loading ? "Checking against the data…" : (empty ?? "No checks for this step")}
      </p>
    )
  return (
    <ul className={cn("grid gap-2", !oneColumn && "sm:grid-cols-2", loading && "opacity-60")}>
      {checks.map((c, i) => (
        <li key={i} className="flex items-start gap-2 text-sm">
          <CheckIcon check={c} />
          <span className="min-w-0">
            <span className="font-medium">{c.name}</span>
            {c.detail && <span className="text-muted-foreground block text-xs">{c.detail}</span>}
          </span>
        </li>
      ))}
    </ul>
  )
}

function CheckIcon({ check }: { check: Check }) {
  const cls = "mt-0.5 size-4 shrink-0"
  if (check.status === "ok") return <CheckCircle2 className={cn(cls, "text-status-succeeded")} />
  if (check.status === "info") return <Info className={cn(cls, "text-status-running")} />
  if (check.severity === "block") return <XCircle className={cn(cls, "text-status-failed")} />
  return <AlertTriangle className={cn(cls, "text-status-cancelled")} />
}

export const blocking = (checks: Check[]) => checks.filter((c) => c.status === "fail" && c.severity === "block")
export const warnings = (checks: Check[]) => checks.filter((c) => c.status === "fail" && c.severity === "warn")

/** The value after it stopped changing for a moment (checks run on a settled draft, not on every key). */
export function useDebounced<T>(value: T, ms = 500): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms)
    return () => clearTimeout(id)
  }, [value, ms])
  return v
}

// ------------------------------------------------------------ a first definition from a table
export const fieldName = (s: string) => {
  const n = s
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase()
  return /^[a-z]/.test(n) ? n : `f_${n || "x"}`
}

/** customers -> Customer, bank_accounts -> BankAccount */
export const typeName = (table: string) => {
  const last = table.split(".").pop() ?? table
  const words = last
    .replace(/^(raw_|stg_|dim_|fact_)/, "")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
  const name = words.map((w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase()).join("")
  const singular = name.replace(/ies$/, "y").replace(/(?<!s)s$/, "")
  return /^[A-Z]/.test(singular) ? singular : `T${singular}`
}

const PERSONAL = /(national|id_?num|passport|ssn|phone|mobile|e_?mail|birth|address|iban|card_?n)/i
export const ORDERING = /(_ingested_at|ingest|updated_at|_commit_version|modified|_ts$|timestamp|loaded_at)/i

/** A complete first draft from a table: every column a property, a guessed key and title. */
export function draftFrom(src: SourceTable): ObjectType {
  const cols = src.columns.map((c) => c.name)
  const props = cols.filter((c) => !c.startsWith("_") || cols.length < 3)
  const used = props.length ? props : cols
  const key =
    used.find((c) => /(^|_)id$/i.test(c) && !/(_ref|parent|owner)/i.test(c)) ??
    used.find((c) => /id/i.test(c)) ??
    used[0]!
  const title = used.find((c) => /(full_?name|^name$|_name$|title|label)/i.test(c)) ?? key
  return {
    api_name: typeName(src.table),
    plural: "",
    description: "",
    source: { table: src.table, layer: src.layer, rows: {} },
    primary_key: fieldName(key),
    title: fieldName(title),
    properties: used.map((c) => ({
      api_name: fieldName(c),
      column: c,
      description: "",
      type: "auto",
      searchable: c === title || c === key,
      sensitive: PERSONAL.test(c),
    })),
    links: [],
  }
}

/** Show a value as text: decimals with separators, whole numbers (often keys) as stored, nothing as a dash. */
export const show = (v: unknown) =>
  v === null || v === undefined || v === ""
    ? "—"
    : typeof v === "number" && !Number.isInteger(v)
      ? v.toLocaleString(undefined, { maximumFractionDigits: 4 })
      : String(v)

// ------------------------------------------------------------ suggested links
export interface LinkSuggestion {
  /** the type that gets the link (it holds the key) */
  source: string
  link: Link
  /** how it was found, for people: "Account.customer_id = Customer.customer_id" */
  via: string
}

const plural = (t: ObjectType) => fieldName(t.plural || `${t.api_name}s`)

/**
 * Links that the types' columns suggest: when a type has a property named like another type's key
 * (Account.customer_id and Customer's key customer_id), the key's type gets a link to it (Customer
 * accounts → Account, one to many; one to one when it is the other type's own key too). Pairs that
 * are already linked, either way, aren't suggested. Targets must be published, as for any link.
 */
export function suggestLinks(types: ObjectType[], published: Set<string>): LinkSuggestion[] {
  const out: LinkSuggestion[] = []
  const linked = (a: string, b: string) =>
    types.some(
      (t) =>
        (t.api_name === a && t.links.some((l) => l.target === b)) ||
        (t.api_name === b && t.links.some((l) => l.target === a)),
    )
  for (const one of types) {
    const key = one.properties.find((p) => p.api_name === one.primary_key)
    if (!key || /^id$/i.test(key.column)) continue // "id" alone would match every table
    for (const many of types) {
      if (many.api_name === one.api_name || !published.has(many.api_name) || linked(one.api_name, many.api_name))
        continue
      const fk = many.properties.find((p) => p.column === key.column || p.api_name === key.api_name)
      if (!fk) continue
      const taken = new Set([...one.properties.map((p) => p.api_name), ...one.links.map((l) => l.api_name)])
      const oneToOne = fk.api_name === many.primary_key
      let name = oneToOne ? fieldName(many.api_name) : plural(many)
      while (taken.has(name)) name = `${name}_link`
      out.push({
        source: one.api_name,
        via: `${many.api_name}.${fk.api_name} = ${one.api_name}.${key.api_name}`,
        link: {
          api_name: name,
          target: many.api_name,
          cardinality: oneToOne ? "one-to-one" : "one-to-many",
          reverse: fieldName(one.api_name),
          from_property: key.api_name,
          to_property: fk.api_name,
        },
      })
    }
  }
  return out
}

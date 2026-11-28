/** The ontology's definitions (prooflix/ontology.py on the server). */
export type Layer = "bronze" | "silver" | "gold" | "unclassified"
export type PropType = "auto" | "string" | "integer" | "number" | "decimal" | "boolean" | "date" | "timestamp"
export type Cardinality = "one-to-one" | "one-to-many" | "many-to-one" | "many-to-many"
export type LinkStorage = "property" | "table" | "computed"

export interface RowRules {
  filter?: string | null
  latest_by?: string | null
  latest_desc?: boolean
}

export interface Property {
  api_name: string
  column: string
  label?: string
  description?: string
  type?: PropType
  unit?: string
  searchable?: boolean
  sensitive?: boolean
}

export interface Link {
  api_name: string
  target: string
  cardinality: Cardinality
  reverse?: string | null
  from_property: string
  to_property: string
  description?: string
  /** property: a property on each side; table: a link table your pipelines build; computed: built from sql */
  storage?: LinkStorage
  table?: string | null
  from_column?: string
  to_column?: string
  sql?: string | null
  schedule?: string | null
}

/** role:admin, role:user (every signed-in user) or user:<name> */
export interface Access {
  view: string[]
  sensitive: string[]
}

export interface ActionParam {
  property: string
  label?: string
  required?: boolean
  choices?: string[]
}

export interface Action {
  api_name: string
  label?: string
  description?: string
  parameters: ActionParam[]
  allowed: string[]
  require_reason?: boolean
}

export interface ObjectType {
  api_name: string
  plural?: string
  description?: string
  icon?: string
  source: { table: string; layer?: Layer; rows?: RowRules }
  primary_key: string
  title: string
  properties: Property[]
  links: Link[]
  access?: Access
  actions?: Action[]
  /** Fast search: an OpenSearch index of its objects */
  index?: boolean
  /** Open to AI Assist: its objects' values (never sensitive ones) can go to Claude; an admin turns it on */
  ai?: boolean
}

export interface SourceTable {
  table: string
  layer: Layer
  delta: boolean
  rows: number
  columns: { name: string; type: string }[]
}

export interface Check {
  step: "source" | "identity" | "properties" | "links" | "actions" | "access"
  name: string
  status: "ok" | "fail" | "info"
  severity: "block" | "warn" | "info"
  detail: string
}

export interface RuleCounts {
  rows: number
  distinct_keys: number
  duplicate_keys: number
  empty_keys: number
}

export interface LinkStats {
  match_rate: number
  matched: number
  total: number
  found: string
  max_per_source: number
  max_per_target: number
}

export interface CheckResult {
  ok: boolean
  checks: Check[]
  stats: { before?: RuleCounts; after?: RuleCounts; links?: Record<string, LinkStats> }
}

export interface OntologyObject {
  type: string
  pk: string | null
  title: unknown
  properties: Record<string, unknown>
  /** properties an action changed: who, when, which action */
  edited?: Record<string, { by: string | null; at: string; action: string }>
}

export interface ObjectLink {
  name: string
  target: string
  here: string
  there: string
  many: boolean
  description: string
  count?: number
  error?: string | null
}

export interface PublishedType extends ObjectType {
  all_links: ObjectLink[]
  my_actions: string[]
  sees_sensitive: boolean
  indexed: boolean
}

export interface IndexJob {
  type: string
  kind: "full" | "update"
  state: "queued" | "running" | "done" | "failed" | "cancelled"
  done: number
  total: number | null
  started: string | null
  finished: string | null
  error: string | null
  note: string
}

export interface TypeIndex {
  enabled: boolean
  ready: boolean
  stale: boolean
  state: { docs: number; built: string; updated: string; fingerprint: string; last_changed?: number } | null
  job: IndexJob | null
}

export interface IndexStatus {
  configured: boolean
  ok: boolean
  error: string | null
  types: Record<string, TypeIndex>
}

export interface SearchStatus {
  configured: boolean
  ok: boolean
  version: string | null
  error: string | null
}

export interface Principal {
  principal: string
  label: string
  role?: string
}

export interface DatabaseStatus {
  configured: boolean
  ok: boolean
  kind: string | null
  error: string | null
}

export interface HistoryRun {
  run: string
  action: string
  reason: string | null
  by: string | null
  at: string
  values: Record<string, unknown>
}

export interface AuditEvent {
  id: number
  at: string
  user: string | null
  event: string
  type: string | null
  pk: string | null
  detail: Record<string, unknown>
}

export interface SetFilter {
  property: string
  op: "eq" | "ne" | "contains" | "gt" | "gte" | "lt" | "lte" | "in" | "is_null" | "not_null"
  value?: string | number | null
}

export interface SetStep {
  link: string
  filters: SetFilter[]
}

export interface ObjectSetDef {
  type: string
  filters: SetFilter[]
  steps: SetStep[]
}

export interface SavedSet {
  id: number
  name: string
  description: string
  owner: string | null
  shared: boolean
  set: ObjectSetDef
  created: string
  updated: string
}

export interface SetResult {
  steps: { type: string; link: string | null; count: number }[]
  objects: OntologyObject[]
  more: boolean
  sql: string
}

export interface ExportJob {
  id: string
  owner: string | null
  name: string
  type: string
  format: "csv" | "parquet"
  state: "queued" | "running" | "done" | "failed"
  rows: number
  total: number | null
  created: string
  finished: string | null
  error: string | null
  bytes: number
  truncated: boolean
}

/** An action AI Assist proposes; nothing changes until the user applies it */
export interface AssistProposal {
  id: string
  type: string
  key: string
  title: string | null
  action: string
  label: string
  values: Record<string, unknown>
  reason: string
}

export interface AssistReply {
  answer: string
  proposals: AssistProposal[]
  tool_calls: number
  model: string
}

/** The ontology's definitions (prooflix/ontology.py on the server). */
export type Layer = "bronze" | "silver" | "gold" | "unclassified"
export type PropType = "auto" | "string" | "integer" | "number" | "decimal" | "boolean" | "date" | "timestamp"
export type Cardinality = "one-to-one" | "one-to-many" | "many-to-one"

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

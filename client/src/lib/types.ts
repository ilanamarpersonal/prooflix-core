// Mirrors the server's API schemas (server/prooflix/api/schemas.py, runs/models.py).

export type TaskType = "python" | "shell" | "pipeline"

export type RunStatus = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "SKIPPED" | "CANCELLED"

export const TERMINAL_STATUSES: RunStatus[] = ["SUCCEEDED", "FAILED", "SKIPPED", "CANCELLED"]

export interface GraphNode {
  key: string
  type: TaskType
  description?: string | null
  pipeline?: string | null
  /** python tasks: the file holding the entrypoint's module, relative to the workspace */
  source_file?: string | null
}

export interface GraphEdge {
  source: string
  target: string
}

export interface PipelineSummary {
  id: string
  name: string
  description?: string | null
  valid: boolean
  errors: string[]
  task_count: number
  sub_pipelines: string[]
  parameters: Record<string, unknown>
  /** project folder relative to the workspace ("" for the workspace root) */
  project: string
  /** the pipeline's YAML file, relative to the workspace */
  file: string | null
  /** null: the pipeline only runs when started */
  schedule: ScheduleInfo | null
}

export interface ScheduleInfo {
  /** minute hour day-of-month month day-of-week */
  cron: string
  /** IANA time zone the cron times are in */
  timezone: string
  enabled: boolean
  /** null while paused */
  next_run: string | null
  last_run_id: string | null
  last_run_at: string | null
  /** a due run skipped because the previous run was still going */
  last_skipped_at: string | null
  last_error: string | null
}

export interface SchedulePreview {
  valid: boolean
  error: string | null
  cron: string | null
  next_runs: string[]
}

export interface PipelineDetail extends PipelineSummary {
  source: string
  spec: Record<string, unknown> | null
  graph: { nodes: GraphNode[]; edges: GraphEdge[] }
  used_by: string[]
}

export interface ValidationResult {
  valid: boolean
  errors: string[]
}

export interface TaskRun {
  key: string
  type: TaskType
  depends_on: string[]
  pipeline: string | null
  status: RunStatus
  attempt: number
  max_attempts: number
  started_at: string | null
  ended_at: string | null
  output: unknown
  error: string | null
  logs: string[]
  child_run_id: string | null
}

export interface Run {
  id: string
  pipeline: string
  pipeline_name: string | null
  status: RunStatus
  parameters: Record<string, unknown>
  outputs: Record<string, unknown>
  error: string | null
  created_at: string
  started_at: string | null
  ended_at: string | null
  parent_run_id: string | null
  parent_task_key: string | null
  root_run_id: string | null
  depth: number
  tasks: Record<string, TaskRun>
  /** what started it: "manual", "schedule" or "pipeline" (a parent run) */
  trigger?: string
  /** for scheduled runs: the cron time it was due */
  scheduled_for?: string | null
}

export interface RunTree extends Run {
  children: RunTree[]
}

// ---------------------------------------------------------------- workspace
export interface WorkspaceNode {
  name: string
  /** relative to the workspace root, "/" separated; "" for the root */
  path: string
  type: "dir" | "file"
  size?: number | null
  children?: WorkspaceNode[] | null
}

export interface WorkspaceFile {
  path: string
  size: number
  content: string | null
  truncated: boolean
  binary: boolean
  /** when it last changed; saving sends it back so a newer change isn't overwritten */
  modified: number | null
}

export interface ImportWorkspaceResult {
  workspace: WorkspaceEntry
  /** number of files written */
  written: number
  /** ids of the pipelines it brought */
  pipelines: string[]
}

/** The code a task runs (server/prooflix/api/pipelines.py). */
export interface TaskCode {
  task: string
  type: "python" | "shell" | "pipeline"
  language: "python" | "shell" | "yaml"
  /** relative to the workspace root; null for a shell command */
  path: string | null
  content: string
  /** 1-based line where the Python function is defined */
  line: number | null
  truncated: boolean
}

/** A workspace the server knows about (server/prooflix/api/workspaces.py). */
export interface WorkspaceEntry {
  name: string
  /** absolute path on the server */
  path: string
  active: boolean
  /** active until another is chosen: the first workspace in the workspaces folder */
  default: boolean
  /** in the workspaces folder, so listed for as long as its folder is there */
  in_root: boolean
  exists: boolean
  /** the git branch checked out in the folder, when it is a git working folder */
  branch: string | null
  /** a copy Prooflix keeps in PROOFLIX_HOME/workspaces */
  is_copy: boolean
}

export interface FoundFolder {
  path: string
  /** how many of the chosen folder's files it has */
  matches: number
  branch: string | null
}

export interface ImportPathResult {
  workspace: WorkspaceEntry
  mode: "in_place" | "copy"
  source: string
  copied_files: number | null
  pipelines: string[]
}

export interface WorkspaceList {
  /** null while there are no workspaces */
  active: string | null
  /** the folder holding the workspaces */
  root: string | null
  workspaces: WorkspaceEntry[]
}

export interface DirListing {
  path: string
  /** null at the filesystem root */
  parent: string | null
  dirs: { name: string; path: string }[]
}

export interface RemoveResult {
  path: string
  type: "dir" | "file"
  /** number of files removed */
  files: number
  /** where the item was moved, relative to the workspace */
  trash: string
}

// ---------------------------------------------------------------- sql
export interface SqlTable {
  /** table name inside its schema */
  name: string
  /** "main" (the workspace's own data), a project's schema, or "<catalog>.<schema>" such as "tenant1.bronze" */
  schema: string
  /** "tenant1" for three-level names (data/<catalog>/<schema>/), "" otherwise */
  catalog: string
  /** how to write it in SQL: "orders" in main, "my_project.orders", "tenant1.bronze.orders" */
  qualified: string
  /** file path: relative to the workspace, or "catalog/…" for the catalog folder */
  source: string
  /** the file is part of the workspace (a project's data), not the catalog folder */
  in_workspace: boolean
  row_count: number
  columns: { name: string; type: string }[]
}

export interface CatalogSchema {
  /** as written in SQL: "my_project" or "tenant1.bronze" */
  name: string
  /** "tenant1" for a schema inside a catalog folder, "" otherwise */
  catalog: string
  /** a project's data in the workspace, or the catalog folder */
  location: "workspace" | "catalog"
  /** project folder relative to the workspace; "" for the workspace's own data */
  project: string
  /** folder its tables come from; null when the project has no data/ folder */
  data_dir: string | null
  tables: SqlTable[]
}

export interface CatalogImportResult {
  schema: string
  /** the data folder the files were written to, relative to the workspace */
  folder: string
  tables: string[]
  created_schema: boolean
}

export interface SqlResult {
  columns: string[]
  rows: unknown[][]
  row_count: number
  truncated: boolean
  elapsed_ms: number
}

export type LinkedFolderKind = "source-data" | "data-lake"

/** where the active workspace's source/ (raw files) or data/ (data lake) points */
export interface LinkedFolder {
  kind: "source_data" | "data_lake"
  /** its name in the workspace: "source" or "data" */
  link: string
  path: string
  /** the workspace's own choice, the server default (PROOFLIX_SOURCE_DATA / PROOFLIX_DATA_LAKE), or its own folder */
  origin: "workspace" | "server" | "default"
  workspace_setting: string | null
  server_default: string | null
  /** the workspace's folder is a link to it */
  linked: boolean
}

/** A server setting, from a PROOFLIX_* environment variable (GET /api/system/parameters). */
export interface SystemParameter {
  name: string
  /** what the server uses now; null: not set */
  value: string | null
  /** what is used when the variable is not set */
  default: string
  /** where the value in use comes from */
  source: "saved" | "environment" | "default"
  description: string
  editable: boolean
  /** "folder": a path on the server, chosen with a folder browser; "date": a date picker */
  kind: "folder" | "date" | "text" | "secret"
  /** the value edited in the System tab, if any (used from the next start) */
  saved: string | null
  /** the saved value changed since the last (re)start */
  restart_needed: boolean
  /** applied by Restart server; false: only restarting the server process applies it */
  live: boolean
}

/** GET /api/clickhouse/status */
export interface ClickHouseStatus {
  configured: boolean
  reachable: boolean
  /** where Prooflix writes */
  url: string | null
  /** where people outside connect */
  public_url: string | null
  /** the read-only user they connect as */
  reader: string | null
  version: string | null
  error: string | null
  tables: { database: string; name: string; rows: number | null; bytes: number | null }[]
}

/** GET /api/clickhouse/gold-tables */
export interface GoldTable {
  /** "tenant1.gold.agg_transactions_per_date" */
  table: string
  /** the ClickHouse table it becomes: "tenant1.agg_transactions_per_date" */
  target: string
  rows: number
  columns: { name: string; clickhouse_type: string }[]
  error: string | null
}

/** POST /api/clickhouse/import, one per table */
export interface ClickHouseImportResult {
  table: string
  target: string | null
  ok: boolean
  rows: number | null
  columns: number | null
  replaced: boolean | null
  seconds: number | null
  error: string | null
}

// ------------------------------------------------------------ ingestion
export interface DbField {
  key: string
  label: string
  type: "text" | "number" | "password" | "select" | "bool"
  default: string | number | boolean | null
  required: boolean
  options: [string, string][]
  help: string | null
}

export interface DbKind {
  kind: string
  label: string
  fields: DbField[]
}

export interface DbConnection {
  name: string
  kind: string
  host: string
  port: number
  database: string
  user: string
  /** "********" when one is saved */
  password: string
  options: Record<string, unknown>
  jdbc_url: string
}

export interface DbConnectionIn {
  kind: string
  host: string
  port: number | null
  database: string
  user: string
  password: string
  options: Record<string, unknown>
}

export interface SourceColumn {
  name: string
  type: string
  /** a date, timestamp or integer column: can tell which rows are new */
  watermark: boolean
}

export interface SourceTable {
  schema: string
  name: string
  /** the source table's primary key columns, in order */
  primary_key: string[]
  columns: SourceColumn[]
}

export interface JobTable {
  /** "schema.table" in the database */
  source: string
  /** bronze table name */
  target: string
  /** [] = every column */
  columns: string[]
  /** null = full copy each run */
  watermark: string | null
  /** columns identifying a row: rows already in bronze are overwritten; [] = append. Missing in jobs saved before keys existed */
  keys?: string[]
}

export interface IngestionJobIn {
  name: string | null
  /** null: runs only when started */
  schedule: { cron: string; timezone: string; enabled: boolean } | null
  connection: string
  start_date: string | null
  tables: JobTable[]
}

export interface IngestionJob extends Omit<IngestionJobIn, "schedule"> {
  id: string
  name: string
  schedule: { cron: string; timezone: string; enabled: boolean; next_run: string | null } | null
  errors: string[]
}

export interface IngestionJobs {
  jobs: IngestionJob[]
  task_ready: boolean
  task_module: string
}

// ------------------------------------------------------------ users and sign-in
export interface AppUser {
  username: string
  role: "admin" | "user"
  /** the tabs an admin gave a user (admins see every tab) */
  tabs: string[]
  /** the tabs this user sees: every tab plus "users" for an admin */
  visible_tabs: string[]
  disabled: boolean
  created_at: string
  last_login: string | null
}

export interface AuthStatus {
  /** PROOFLIX_AUTH: false means no login and every tab */
  enabled: boolean
  /** no users yet: the login page creates the first admin */
  setup_needed: boolean
  user: AppUser | null
  /** every tab a user can be given */
  tabs: string[]
}

// ------------------------------------------------------------ alerts
export interface AlertChannelKind {
  kind: "email" | "slack" | "teams" | "webhook"
  label: string
  fields: { key: string; label: string; secret: boolean; required: boolean }[]
}

export interface AlertChannel {
  id: string
  kind: AlertChannelKind["kind"]
  name: string
  /** secrets are "********" */
  config: Record<string, string>
}

export interface AlertRuleIn {
  name: string
  enabled: boolean
  /** format: text with {fields}; regex: a regular expression */
  mode: "format" | "regex"
  pattern: string
  severity: "info" | "warning" | "critical"
  /** [] = every pipeline */
  pipelines: string[]
  /** [] = every channel */
  channels: string[]
  cooldown_seconds: number
}

export interface AlertRule extends AlertRuleIn {
  id: string
}

export interface AlertEvent {
  id: string
  at: string
  rule: string
  severity: string
  pipeline: string
  run_id: string
  task: string
  line: string
  fields: Record<string, string>
  suppressed: number
  note?: string
  deliveries: Record<
    string,
    { channel: string; kind: string; status: "sending" | "sent" | "failed"; error?: string | null }
  >
}

// ------------------------------------------------------------ semantic model
export interface SemDimension {
  name: string
  column?: string | null
  sql?: string | null
  type: "category" | "time" | "number"
  description?: string
}

export interface SemMeasure {
  name: string
  agg: "sum" | "count" | "count_distinct" | "avg" | "min" | "max"
  column?: string | null
  sql?: string | null
  description?: string
}

export interface SemJoin {
  entity: string
  column: string
  to_column: string
  kind: "left" | "inner"
}

export interface SemEntity {
  name: string
  table: string
  description?: string
  primary_key?: string | null
  dimensions: SemDimension[]
  measures: SemMeasure[]
  joins: SemJoin[]
}

export interface SemMetric {
  name: string
  /** a formula over {entity.measure} */
  sql: string
  description?: string
}

export interface SemanticModel {
  name: string
  description?: string
  entities: SemEntity[]
  metrics: SemMetric[]
}

export interface SemanticModelFile {
  path: string
  exists: boolean
  modified: number | null
  model: SemanticModel
}

/** AI Assist: Claude in Prooflix. The settings as the browser sees them (never the key itself). */
export interface AiAssistSettings {
  enabled: boolean
  model: string
  effort: "low" | "medium" | "high"
  key_source: "saved" | "environment" | "none"
  /** the key's last four characters, "…abcd" */
  key_hint: string | null
  /** the key's kind, "sk-ant-api03" (not secret); null when unknown */
  key_prefix: string | null
  /** when the saved key was set (UTC, ISO 8601); null for the environment's key */
  key_saved_at: string | null
  ready: boolean
  /** prices in US dollars per million tokens */
  models: { id: string; label: string; input_price: number; output_price: number }[]
}

export interface AiAssistSettingsIn {
  enabled: boolean
  model: string
  effort: string
  api_key?: string | null
  remove_key?: boolean
}

export interface AiAssistStatus {
  ready: boolean
  enabled: boolean
  model: string
}

/** AI Assist's answer about a failed SQL query */
export interface AiAssistSqlFix {
  diagnosis: string
  explanation: string
  fixed_sql: string
  confidence: "high" | "medium" | "low"
  /** fixed_sql is one read-only SELECT */
  runnable: boolean
  problem: string | null
  model: string
}

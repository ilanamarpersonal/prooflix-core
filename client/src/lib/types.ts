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

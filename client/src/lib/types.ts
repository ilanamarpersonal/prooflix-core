// Mirrors the server's API schemas (server/prooflix/api/schemas.py, runs/models.py).

export type TaskType = "python" | "shell" | "pipeline"

export type RunStatus = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "SKIPPED" | "CANCELLED"

export const TERMINAL_STATUSES: RunStatus[] = ["SUCCEEDED", "FAILED", "SKIPPED", "CANCELLED"]

export interface GraphNode {
  key: string
  type: TaskType
  description?: string | null
  pipeline?: string | null
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

export interface ImportResult {
  written: string[]
  /** ids of pipeline files that were added or replaced */
  pipelines: string[]
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
  /** "main" (the workspace's own data) or a project's schema */
  schema: string
  /** how to write it in SQL: "orders" in main, "my_project.orders" otherwise */
  qualified: string
  source: string
  row_count: number
  columns: { name: string; type: string }[]
}

export interface CatalogSchema {
  name: string
  /** project folder relative to the workspace; "" for the workspace's own data */
  project: string
  /** folder its tables come from; null when the project has no data/ folder */
  data_dir: string | null
  tables: SqlTable[]
}

export interface SqlResult {
  columns: string[]
  rows: unknown[][]
  row_count: number
  truncated: boolean
  elapsed_ms: number
}

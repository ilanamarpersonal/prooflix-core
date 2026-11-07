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

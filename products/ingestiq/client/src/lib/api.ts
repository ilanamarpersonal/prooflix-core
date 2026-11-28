import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { request, UNAUTHORIZED_EVENT } from "@prooflix/ui/app/request"
import { ApiError } from "@prooflix/ui/lib/api-error"

import {
  TERMINAL_STATUSES,
  type PipelineDetail,
  type AlertChannel,
  type AiAssistRunFix,
  type AiAssistRunHelp,
  type AiAssistRunReply,
  type AiAssistRunTurn,
  type AlertChannelKind,
  type AlertEvent,
  type AlertRule,
  type AlertRuleIn,
  type DbConnection,
  type DbConnectionIn,
  type DbKind,
  type IngestionJob,
  type IngestionJobIn,
  type IngestionJobs,
  type SourceTable,
  type PipelineSummary,
  type Run,
  type RunTree,
  type SchedulePreview,
  type TaskCode,
  type LinkedFolder,
  type LinkedFolderKind,
  type FoundFolder,
  type ImportPathResult,
  type ImportWorkspaceResult,
  type RemoveResult,
  type ValidationResult,
  type WorkspaceEntry,
  type WorkspaceFile,
  type WorkspaceList,
  type WorkspaceNode,
  type SqlTable,
  type CatalogSchema,
  type CatalogImportResult,
  type DropSchemaMode,
  type DropSchemaResult,
  type DropCatalogResult,
  type SqlResult,
  type ClickHouseStatus,
  type GoldTable,
  type ClickHouseImportResult,
  type SemanticModel,
  type SemanticModelFile,
  type AiAssistSqlFix,
} from "./types"

// shared by every product: the API helper, its error and the 401 event
export { ApiError, UNAUTHORIZED_EVENT }
const POLL_MS = 1000

export const api = {
  listPipelines: () => request<PipelineSummary[]>("/pipelines"),
  getPipeline: (id: string) => request<PipelineDetail>(`/pipelines/${id}`),
  validatePipeline: (id: string, source: string) =>
    request<ValidationResult>(`/pipelines/${id}/validate`, {
      method: "POST",
      body: JSON.stringify({ source }),
    }),
  savePipeline: (id: string, source: string, createOnly = false) =>
    request<PipelineDetail>(`/pipelines/${id}${createOnly ? "?create_only=true" : ""}`, {
      method: "PUT",
      body: JSON.stringify({ source }),
    }),
  taskCode: (id: string, task: string) =>
    request<TaskCode>(`/pipelines/${encodeURIComponent(id)}/tasks/${encodeURIComponent(task)}/code`),
  deletePipeline: (id: string) => request<void>(`/pipelines/${id}`, { method: "DELETE" }),
  setSchedule: (id: string, schedule: { cron: string; timezone: string; enabled: boolean }) =>
    request<PipelineDetail>(`/pipelines/${id}/schedule`, { method: "PUT", body: JSON.stringify(schedule) }),
  removeSchedule: (id: string) => request<PipelineDetail>(`/pipelines/${id}/schedule`, { method: "DELETE" }),
  previewSchedule: (cron: string, timezone: string) =>
    request<SchedulePreview>("/schedules/preview", { method: "POST", body: JSON.stringify({ cron, timezone }) }),
  startRun: (id: string, parameters: Record<string, unknown>) =>
    request<Run>(`/pipelines/${id}/runs`, {
      method: "POST",
      body: JSON.stringify({ parameters }),
    }),
  listRuns: (params: { pipeline?: string; rootOnly?: boolean; limit?: number } = {}) => {
    const q = new URLSearchParams()
    if (params.pipeline) q.set("pipeline", params.pipeline)
    q.set("root_only", String(params.rootOnly ?? true))
    if (params.limit) q.set("limit", String(params.limit))
    return request<Run[]>(`/runs?${q}`)
  },
  getRun: (id: string) => request<Run>(`/runs/${id}`),
  getRunTree: (id: string) => request<RunTree>(`/runs/${id}/tree`),
  cancelRun: (id: string) => request<Run>(`/runs/${id}/cancel`, { method: "POST" }),
  workspaceTree: () => request<WorkspaceNode>("/workspace/tree"),
  linkedFolder: (kind: LinkedFolderKind) => request<LinkedFolder>(`/workspace/folders/${kind}`),
  setLinkedFolder: (kind: LinkedFolderKind, path: string | null) =>
    request<LinkedFolder>(`/workspace/folders/${kind}`, { method: "PUT", body: JSON.stringify({ path }) }),
  workspaceFile: (path: string) => request<WorkspaceFile>(`/workspace/file?${new URLSearchParams({ path })}`),
  saveWorkspaceFile: (path: string, content: string, modified: number | null) =>
    request<WorkspaceFile>("/workspace/file", { method: "PUT", body: JSON.stringify({ path, content, modified }) }),
  removeWorkspaceItem: (path: string) =>
    request<RemoveResult>(`/workspace/item?${new URLSearchParams({ path })}`, { method: "DELETE" }),
  workspaces: () => request<WorkspaceList>("/workspaces"),
  createWorkspace: (parent: string, name: string) =>
    request<WorkspaceEntry>("/workspaces", { method: "POST", body: JSON.stringify({ parent, name }) }),
  activateWorkspace: (path: string) =>
    request<WorkspaceList>("/workspaces/active", { method: "PUT", body: JSON.stringify({ path }) }),
  findFolder: (name: string, files: string[]) =>
    request<FoundFolder[]>("/workspaces/find", { method: "POST", body: JSON.stringify({ name, files }) }),
  importPath: (body: { path: string; mode: "in_place" | "copy"; name: string | null; activate: boolean }) =>
    request<ImportPathResult>("/workspaces/import-path", { method: "POST", body: JSON.stringify(body) }),
  importWorkspace: (
    name: string,
    files: { path: string; content_base64: string }[],
    activate = true,
    overwrite = false,
  ) =>
    request<ImportWorkspaceResult>("/workspaces/import", {
      method: "POST",
      body: JSON.stringify({ name, files, activate, overwrite }),
    }),
  forgetWorkspace: (path: string) =>
    request<WorkspaceList>(`/workspaces?${new URLSearchParams({ path })}`, { method: "DELETE" }),
  alertKinds: () => request<{ channels: AlertChannelKind[]; severities: string[] }>("/alerts/kinds"),
  aiAssistRunHelp: (runId: string) =>
    request<AiAssistRunHelp>(`/ai-assist/runs/${encodeURIComponent(runId)}/explain`, { method: "POST" }),
  aiAssistRunFix: (runId: string, explanation: AiAssistRunHelp | null) =>
    request<AiAssistRunFix>(`/ai-assist/runs/${encodeURIComponent(runId)}/fix`, {
      method: "POST",
      body: JSON.stringify({ explanation }),
    }),
  aiAssistRunAsk: (runId: string, question: string, explanation: AiAssistRunHelp | null, turns: AiAssistRunTurn[]) =>
    request<AiAssistRunReply>(`/ai-assist/runs/${encodeURIComponent(runId)}/ask`, {
      method: "POST",
      body: JSON.stringify({ question, explanation, turns }),
    }),
  alertChannels: () => request<AlertChannel[]>("/alerts/channels"),
  saveAlertChannel: (id: string, body: { kind: string; name: string; config: Record<string, string> }) =>
    request<AlertChannel>(`/alerts/channels/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteAlertChannel: (id: string) => request<void>(`/alerts/channels/${encodeURIComponent(id)}`, { method: "DELETE" }),
  testAlertChannel: (id: string) =>
    request<{ ok: boolean; error: string | null }>(`/alerts/channels/${encodeURIComponent(id)}/test`, {
      method: "POST",
    }),
  alertRules: () => request<AlertRule[]>("/alerts/rules"),
  saveAlertRule: (id: string | null, body: AlertRuleIn) =>
    id
      ? request<AlertRule>(`/alerts/rules/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(body) })
      : request<AlertRule>("/alerts/rules", { method: "POST", body: JSON.stringify(body) }),
  deleteAlertRule: (id: string) => request<void>(`/alerts/rules/${encodeURIComponent(id)}`, { method: "DELETE" }),
  tryAlertFormat: (mode: string, pattern: string, line: string) =>
    request<{ matches: boolean; fields: Record<string, string> }>("/alerts/try", {
      method: "POST",
      body: JSON.stringify({ mode, pattern, line }),
    }),
  alertHistory: () => request<AlertEvent[]>("/alerts/history"),
  deleteAlerts: (ids: string[] | null) =>
    request<{ deleted: number }>("/alerts/history/delete", { method: "POST", body: JSON.stringify({ ids }) }),
  dbKinds: () => request<DbKind[]>("/ingestion/kinds"),
  dbConnections: () => request<DbConnection[]>("/ingestion/connections"),
  saveDbConnection: (name: string, body: DbConnectionIn) =>
    request<DbConnection>(`/ingestion/connections/${encodeURIComponent(name)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  deleteDbConnection: (name: string) =>
    request<void>(`/ingestion/connections/${encodeURIComponent(name)}`, { method: "DELETE" }),
  testDbConnection: (name: string) =>
    request<{ ok: boolean; tables: number | null; error: string | null }>(
      `/ingestion/connections/${encodeURIComponent(name)}/test`,
      { method: "POST" },
    ),
  sourceTables: (name: string) => request<SourceTable[]>(`/ingestion/connections/${encodeURIComponent(name)}/tables`),
  ingestionJobs: () => request<IngestionJobs>("/ingestion/jobs"),
  saveIngestionJob: (id: string, body: IngestionJobIn, createOnly: boolean) =>
    request<IngestionJob>(`/ingestion/jobs/${encodeURIComponent(id)}${createOnly ? "?create_only=true" : ""}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  runJobForDates: (id: string, from_date: string | null, to_date: string | null) =>
    request<Run>(`/ingestion/jobs/${encodeURIComponent(id)}/runs`, {
      method: "POST",
      body: JSON.stringify({ from_date, to_date }),
    }),
  deleteIngestionJob: (id: string) => request<void>(`/ingestion/jobs/${encodeURIComponent(id)}`, { method: "DELETE" }),
  validateSemanticYaml: (text: string) =>
    request<{ ok: boolean; error: string | null; entities?: number; metrics?: number }>("/semantic/yaml/validate", {
      method: "POST",
      body: JSON.stringify({ text }),
    }),
  catalog: () => request<CatalogSchema[]>("/catalog"),
  catalogImport: (schema: string, files: { name: string; content_base64: string }[], overwrite = false) =>
    request<CatalogImportResult>("/catalog/import", {
      method: "POST",
      body: JSON.stringify({ schema, files, overwrite }),
    }),
  dropSchema: (schema: string, mode: DropSchemaMode) =>
    request<DropSchemaResult>(`/catalog/schemas/${encodeURIComponent(schema)}?${new URLSearchParams({ mode })}`, {
      method: "DELETE",
    }),
  dropCatalog: (catalog: string, mode: DropSchemaMode) =>
    request<DropCatalogResult>(`/catalog/catalogs/${encodeURIComponent(catalog)}?${new URLSearchParams({ mode })}`, {
      method: "DELETE",
    }),
  hiddenSchemas: () => request<string[]>("/catalog/hidden"),
  restoreSchema: (schema: string) =>
    request<void>(`/catalog/hidden/${encodeURIComponent(schema)}`, { method: "DELETE" }),
  sqlTables: () => request<SqlTable[]>("/sql/tables"),
  sqlQuery: (sql: string, limit = 1000) =>
    request<SqlResult>("/sql/query", { method: "POST", body: JSON.stringify({ sql, limit }) }),
  clickhouseStatus: () => request<ClickHouseStatus>("/clickhouse/status"),
  goldTables: () => request<GoldTable[]>("/clickhouse/gold-tables"),
  aiAssistSqlFix: (sql: string, error: string) =>
    request<AiAssistSqlFix>("/ai-assist/sql/fix", { method: "POST", body: JSON.stringify({ sql, error }) }),
  semanticModel: () => request<SemanticModelFile>("/semantic"),
  saveSemanticModel: (model: SemanticModel, modified: number | null) =>
    request<SemanticModelFile>("/semantic", { method: "PUT", body: JSON.stringify({ model, modified }) }),
  semanticYaml: () => request<{ path: string; text: string; modified: number | null }>("/semantic/yaml"),
  saveSemanticYaml: (text: string, modified: number | null) =>
    request<SemanticModelFile>("/semantic/yaml", { method: "PUT", body: JSON.stringify({ text, modified }) }),
  semanticTables: () => request<{ table: string; columns: { name: string; type: string }[] }[]>("/semantic/tables"),
  checkSemanticModel: (model: SemanticModel) =>
    request<{ ok: boolean; problems: { where: string; problem: string }[] }>("/semantic/check", {
      method: "POST",
      body: JSON.stringify({ model }),
    }),
  querySemantic: (model: SemanticModel, measures: string[], dimensions: string[], limit: number) =>
    request<{ sql: string; result: SqlResult }>("/semantic/query", {
      method: "POST",
      body: JSON.stringify({ model, measures, dimensions, limit }),
    }),
  importToClickHouse: (tables: string[]) =>
    request<ClickHouseImportResult[]>("/clickhouse/import", { method: "POST", body: JSON.stringify({ tables }) }),
}

const isActive = (r?: { status: Run["status"] }) => !!r && !TERMINAL_STATUSES.includes(r.status)
const anyActive = (tree?: RunTree): boolean => !!tree && (isActive(tree) || tree.children.some(anyActive))

// ---------------------------------------------------------------- query hooks
export const usePipelines = () => useQuery({ queryKey: ["pipelines"], queryFn: api.listPipelines })

export const usePipeline = (id: string) =>
  useQuery({ queryKey: ["pipelines", id], queryFn: () => api.getPipeline(id), enabled: !!id })

// under ["pipelines"] so saving a pipeline refreshes it
export const useTaskCode = (id: string, task: string | null) =>
  useQuery({
    queryKey: ["pipelines", id, "task-code", task],
    queryFn: () => api.taskCode(id, task!),
    enabled: !!task,
  })

export const useRuns = (params: { pipeline?: string; rootOnly?: boolean; limit?: number } = {}) =>
  useQuery({
    queryKey: ["runs", params],
    queryFn: () => api.listRuns(params),
    refetchInterval: (q) => (q.state.data?.some(isActive) ? POLL_MS : 5000),
  })

export const useRunTree = (id: string) =>
  useQuery({
    queryKey: ["runs", id, "tree"],
    queryFn: () => api.getRunTree(id),
    refetchInterval: (q) => (anyActive(q.state.data) || !q.state.data ? POLL_MS : false),
  })

export function useStartRun() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, parameters }: { id: string; parameters: Record<string, unknown> }) =>
      api.startRun(id, parameters),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["runs"] }),
  })
}

export function useCancelRun() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.cancelRun(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["runs"] }),
  })
}

export function useSavePipeline() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, source, createOnly }: { id: string; source: string; createOnly?: boolean }) =>
      api.savePipeline(id, source, createOnly),
    onSuccess: (data) => {
      qc.setQueryData(["pipelines", data.id], data)
      qc.invalidateQueries({ queryKey: ["pipelines"] })
    },
  })
}

/** Set (schedule given) or remove (null) a pipeline's schedule. */
export function useSetSchedule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      id,
      schedule,
    }: {
      id: string
      schedule: { cron: string; timezone: string; enabled: boolean } | null
    }) => (schedule ? api.setSchedule(id, schedule) : api.removeSchedule(id)),
    onSuccess: (data) => {
      qc.setQueryData(["pipelines", data.id], data)
      qc.invalidateQueries({ queryKey: ["pipelines"] })
    },
  })
}

export function useDeletePipeline() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.deletePipeline(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pipelines"] }),
  })
}

export const useLinkedFolder = (kind: LinkedFolderKind) =>
  useQuery({ queryKey: ["workspace", "folders", kind], queryFn: () => api.linkedFolder(kind) })

/** Point the active workspace's source/ or data/ at another folder: the tree, catalog and SQL change with it. */
export function useSetLinkedFolder(kind: LinkedFolderKind) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (path: string | null) => api.setLinkedFolder(kind, path),
    onSuccess: (data) => {
      qc.setQueryData(["workspace", "folders", kind], data)
      qc.invalidateQueries({ queryKey: ["workspace", "tree"] })
      qc.invalidateQueries({ queryKey: ["sql"] })
    },
  })
}

export const useWorkspaceTree = () => useQuery({ queryKey: ["workspace", "tree"], queryFn: api.workspaceTree })

export function useSaveWorkspaceFile() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ path, content, modified }: { path: string; content: string; modified: number | null }) =>
      api.saveWorkspaceFile(path, content, modified),
    onSuccess: (data) => {
      qc.setQueryData(["workspace", "file", data.path], data)
      qc.invalidateQueries({ queryKey: ["workspace", "tree"] })
      qc.invalidateQueries({ queryKey: ["pipelines"] }) // a pipeline's YAML may have changed
    },
  })
}

export const useWorkspaceFile = (path: string | null) =>
  useQuery({
    queryKey: ["workspace", "file", path],
    queryFn: () => api.workspaceFile(path!),
    enabled: !!path,
  })

export const useAlertKinds = () =>
  useQuery({ queryKey: ["alerts", "kinds"], queryFn: api.alertKinds, staleTime: Infinity })
export const useAlertChannels = () => useQuery({ queryKey: ["alerts", "channels"], queryFn: api.alertChannels })
export const useAlertRules = () => useQuery({ queryKey: ["alerts", "rules"], queryFn: api.alertRules })
export const useAlertHistory = () =>
  useQuery({ queryKey: ["alerts", "history"], queryFn: api.alertHistory, refetchInterval: 5000 })

/** A change on the Alerts tab: refetch its lists afterwards. */
export function useAlertMutation<A, R = unknown>(fn: (a: A) => Promise<R>) {
  const qc = useQueryClient()
  return useMutation({ mutationFn: fn, onSuccess: () => qc.invalidateQueries({ queryKey: ["alerts"] }) })
}

export const useAiAssistRunHelp = () => useMutation({ mutationFn: api.aiAssistRunHelp })
/** Changes to the workspace files behind a failed run that would fix it, for the user to review (nothing saved). */
export const useAiAssistRunFix = () =>
  useMutation({
    mutationFn: ({ runId, explanation }: { runId: string; explanation: AiAssistRunHelp | null }) =>
      api.aiAssistRunFix(runId, explanation),
  })

/** A follow-up question about a failed run, with its explanation and the earlier questions and answers. */
export const useAiAssistRunAsk = () =>
  useMutation({
    mutationFn: ({
      runId,
      question,
      explanation,
      turns,
    }: {
      runId: string
      question: string
      explanation: AiAssistRunHelp | null
      turns: AiAssistRunTurn[]
    }) => api.aiAssistRunAsk(runId, question, explanation, turns),
  })
// AI Assist on every screen and its setting fixes are shared by every product
export {
  useAiAssistAsk,
  useAiAssistFix,
  useAiAssistStatus,
  useRestartServer,
  useSetSystemParameter,
} from "@prooflix/ui/ai-assist/api"

// sign-in state and actions are shared by every product (the portal signs users in)
export { useAuthStatus, useChangePassword, useLogin, useLogout, useSetupAdmin } from "@prooflix/ui/auth/api"

export const useDbKinds = () =>
  useQuery({ queryKey: ["ingestion", "kinds"], queryFn: api.dbKinds, staleTime: Infinity })

export const useDbConnections = () => useQuery({ queryKey: ["ingestion", "connections"], queryFn: api.dbConnections })

export const useSourceTables = (name: string | null) =>
  useQuery({
    queryKey: ["ingestion", "tables", name],
    queryFn: () => api.sourceTables(name!),
    enabled: !!name,
    retry: false,
  })

export const useIngestionJobs = () =>
  useQuery({ queryKey: ["ingestion", "jobs"], queryFn: api.ingestionJobs, refetchInterval: 10_000 })

export function useSaveDbConnection() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ name, body }: { name: string; body: DbConnectionIn }) => api.saveDbConnection(name, body),
    onSuccess: (_, { name }) => {
      qc.invalidateQueries({ queryKey: ["ingestion", "connections"] })
      qc.invalidateQueries({ queryKey: ["ingestion", "tables", name] })
    },
  })
}

export function useDeleteDbConnection() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (name: string) => api.deleteDbConnection(name),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ingestion", "connections"] }),
  })
}

export function useSaveIngestionJob() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body, createOnly }: { id: string; body: IngestionJobIn; createOnly: boolean }) =>
      api.saveIngestionJob(id, body, createOnly),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ingestion", "jobs"] })
      qc.invalidateQueries({ queryKey: ["pipelines"] })
    },
  })
}

export function useDeleteIngestionJob() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.deleteIngestionJob(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ingestion", "jobs"] })
      qc.invalidateQueries({ queryKey: ["pipelines"] })
    },
  })
}

export const useWorkspaces = () => useQuery({ queryKey: ["workspaces"], queryFn: api.workspaces })

export function useCreateWorkspace() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ parent, name }: { parent: string; name: string }) => api.createWorkspace(parent, name),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["workspaces"] })
      qc.invalidateQueries({ queryKey: ["fs"] })
    },
  })
}

/** Switch the server to another workspace: every page's data changes with it. */
export function useActivateWorkspace() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (path: string) => api.activateWorkspace(path),
    onSuccess: (data) => {
      qc.setQueryData(["workspaces"], data)
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "workspaces" })
      qc.invalidateQueries()
    },
  })
}

export function useForgetWorkspace() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (path: string) => api.forgetWorkspace(path),
    onSuccess: (data) => {
      const before = qc.getQueryData<WorkspaceList>(["workspaces"])?.active
      qc.setQueryData(["workspaces"], data)
      // removing the active workspace switched to another: every page's data changes with it
      if (before !== data.active) qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "workspaces" })
    },
  })
}

/** Upload a folder as a new workspace; when it is made active, every page's data changes with it. */
export function useImportPath() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: api.importPath,
    onSuccess: (r) => {
      if (r.workspace.active) qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "workspaces" })
      qc.invalidateQueries({ queryKey: ["workspaces"] })
    },
  })
}

export function useImportWorkspace() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      name,
      files,
      activate,
      overwrite = false,
    }: {
      name: string
      files: { path: string; content_base64: string }[]
      activate: boolean
      /** update the existing workspace of that name */
      overwrite?: boolean
    }) => api.importWorkspace(name, files, activate, overwrite),
    onSuccess: (r) => {
      if (r.workspace.active) qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "workspaces" })
      qc.invalidateQueries({ queryKey: ["workspaces"] })
    },
  })
}

export function useRemoveWorkspaceItem() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (path: string) => api.removeWorkspaceItem(path),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["workspace"] })
      qc.invalidateQueries({ queryKey: ["pipelines"] })
      qc.invalidateQueries({ queryKey: ["sql"] })
    },
  })
}

export const useClickHouseStatus = () => useQuery({ queryKey: ["clickhouse", "status"], queryFn: api.clickhouseStatus })

export const useGoldTables = () => useQuery({ queryKey: ["clickhouse", "gold"], queryFn: api.goldTables })

export function useImportToClickHouse() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (tables: string[]) => api.importToClickHouse(tables),
    onSettled: () => qc.invalidateQueries({ queryKey: ["clickhouse", "status"] }),
  })
}

export const useAiAssistSqlFix = () =>
  useMutation({ mutationFn: ({ sql, error }: { sql: string; error: string }) => api.aiAssistSqlFix(sql, error) })

export const useSemanticModel = () => useQuery({ queryKey: ["semantic", "model"], queryFn: api.semanticModel })

export const useSemanticTables = () =>
  useQuery({ queryKey: ["semantic", "tables"], queryFn: api.semanticTables, staleTime: 60_000 })

export function useSaveSemanticModel() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ model, modified }: { model: SemanticModel; modified: number | null }) =>
      api.saveSemanticModel(model, modified),
    onSuccess: (data) => {
      qc.setQueryData(["semantic", "model"], data)
      qc.invalidateQueries({ queryKey: ["semantic", "yaml"] })
    },
  })
}

// under ["sql"] so imports and removals refresh it too
export const useCatalog = () => useQuery({ queryKey: ["sql", "catalog"], queryFn: api.catalog })

export const useSqlTables = () => useQuery({ queryKey: ["sql", "tables"], queryFn: api.sqlTables })

export const useSqlQuery = () =>
  useMutation({ mutationFn: ({ sql, limit }: { sql: string; limit?: number }) => api.sqlQuery(sql, limit) })

/** Download link for a table (CSV), a schema (ZIP) or the whole catalog (ZIP). */
export function catalogExportUrl(target: { table?: string; schema?: string; format?: "csv" | "parquet" } = {}) {
  const q = new URLSearchParams()
  if (target.table) q.set("table", target.table)
  else if (target.schema) q.set("schema", target.schema)
  if (target.format && target.format !== "csv") q.set("format", target.format)
  const qs = q.toString()
  return `/api/catalog/export${qs ? `?${qs}` : ""}`
}

/** Schemas hidden from the GUI (their data is still in the data lake). */
export const useHiddenSchemas = () => useQuery({ queryKey: ["sql", "catalog", "hidden"], queryFn: api.hiddenSchemas })

/** Drop a schema: hide it from the GUI, or delete its tables' files permanently. */
export function useDropSchema() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ schema, mode }: { schema: string; mode: DropSchemaMode }) => api.dropSchema(schema, mode),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sql"] }),
  })
}

/** Drop every schema of a catalog (a tenant): hide them from the GUI, or delete their tables' files. */
export function useDropCatalog() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ catalog, mode }: { catalog: string; mode: DropSchemaMode }) => api.dropCatalog(catalog, mode),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sql"] }),
  })
}

/** Show a hidden schema in the GUI again. */
export function useRestoreSchema() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (schema: string) => api.restoreSchema(schema),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sql"] }),
  })
}

export function useCatalogImport() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      schema,
      files,
      overwrite,
    }: {
      schema: string
      files: { name: string; content_base64: string }[]
      overwrite?: boolean
    }) => api.catalogImport(schema, files, overwrite),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sql"] })
      qc.invalidateQueries({ queryKey: ["workspace"] })
    },
  })
}

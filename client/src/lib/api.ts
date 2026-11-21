import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import {
  TERMINAL_STATUSES,
  type PipelineDetail,
  type SystemParameter,
  type ClickHouseImportResult,
  type AlertChannel,
  type AiAssistSettings,
  type AiAssistSettingsIn,
  type AiAssistSqlFix,
  type AiAssistStatus,
  type AlertChannelKind,
  type AlertEvent,
  type AlertRule,
  type AlertRuleIn,
  type AppUser,
  type SemanticModel,
  type SemanticModelFile,
  type AuthStatus,
  type ClickHouseStatus,
  type DbConnection,
  type DbConnectionIn,
  type DbKind,
  type IngestionJob,
  type IngestionJobIn,
  type IngestionJobs,
  type SourceTable,
  type GoldTable,
  type PipelineSummary,
  type Run,
  type RunTree,
  type SchedulePreview,
  type SqlResult,
  type SqlTable,
  type TaskCode,
  type CatalogImportResult,
  type CatalogSchema,
  type LinkedFolder,
  type LinkedFolderKind,
  type FoundFolder,
  type ImportPathResult,
  type ImportWorkspaceResult,
  type RemoveResult,
  type DirListing,
  type ValidationResult,
  type WorkspaceEntry,
  type WorkspaceFile,
  type WorkspaceList,
  type WorkspaceNode,
} from "./types"

const BASE = "/api"
/** fired when an API call answers 401, so the app shows the login page */
export const UNAUTHORIZED_EVENT = "prooflix:unauthorized"
const POLL_MS = 1000

export class ApiError extends Error {
  status: number
  errors: string[]
  /** the server's raw error detail, for responses that carry more than messages */
  detail: unknown

  constructor(status: number, message: string, errors: string[] = [], detail?: unknown) {
    super(message)
    this.status = status
    this.errors = errors
    this.detail = detail
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  })
  if (res.status === 204) return undefined as T
  // the session ended (expired, signed out elsewhere, password changed): show the login page
  if (res.status === 401 && !path.startsWith("/auth/")) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT))
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    const detail = body?.detail
    const errors: string[] = Array.isArray(detail?.errors)
      ? detail.errors
      : typeof detail === "string"
        ? [detail]
        : Array.isArray(detail)
          ? detail.map((d: { msg?: string }) => d.msg ?? JSON.stringify(d))
          : []
    throw new ApiError(res.status, errors[0] ?? res.statusText, errors, detail)
  }
  return body as T
}

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
  listDirs: (path?: string) => request<DirListing>(`/fs/dirs${path ? `?${new URLSearchParams({ path })}` : ""}`),
  catalog: () => request<CatalogSchema[]>("/catalog"),
  catalogImport: (schema: string, files: { name: string; content_base64: string }[], overwrite = false) =>
    request<CatalogImportResult>("/catalog/import", {
      method: "POST",
      body: JSON.stringify({ schema, files, overwrite }),
    }),
  sqlTables: () => request<SqlTable[]>("/sql/tables"),
  sqlQuery: (sql: string, limit = 1000) =>
    request<SqlResult>("/sql/query", { method: "POST", body: JSON.stringify({ sql, limit }) }),
  systemParameters: () => request<SystemParameter[]>("/system/parameters"),
  clickhouseStatus: () => request<ClickHouseStatus>("/clickhouse/status"),
  goldTables: () => request<GoldTable[]>("/clickhouse/gold-tables"),
  alertKinds: () => request<{ channels: AlertChannelKind[]; severities: string[] }>("/alerts/kinds"),
  aiAssistStatus: () => request<AiAssistStatus>("/ai-assist/status"),
  aiAssistSettings: () => request<AiAssistSettings>("/ai-assist/settings"),
  saveAiAssistSettings: (body: AiAssistSettingsIn) =>
    request<AiAssistSettings>("/ai-assist/settings", { method: "PUT", body: JSON.stringify(body) }),
  testAiAssist: () =>
    request<{ ok: boolean; model: string; display_name: string }>("/ai-assist/settings/test", { method: "POST" }),
  aiAssistSqlFix: (sql: string, error: string) =>
    request<AiAssistSqlFix>("/ai-assist/sql/fix", { method: "POST", body: JSON.stringify({ sql, error }) }),
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
  semanticModel: () => request<SemanticModelFile>("/semantic"),
  saveSemanticModel: (model: SemanticModel, modified: number | null) =>
    request<SemanticModelFile>("/semantic", { method: "PUT", body: JSON.stringify({ model, modified }) }),
  semanticYaml: () => request<{ path: string; text: string; modified: number | null }>("/semantic/yaml"),
  validateSemanticYaml: (text: string) =>
    request<{ ok: boolean; error: string | null; entities?: number; metrics?: number }>("/semantic/yaml/validate", {
      method: "POST",
      body: JSON.stringify({ text }),
    }),
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
  authStatus: () => request<AuthStatus>("/auth/status"),
  login: (username: string, password: string) =>
    request<AuthStatus>("/auth/login", { method: "POST", body: JSON.stringify({ username, password }) }),
  setupAdmin: (username: string, password: string) =>
    request<AuthStatus>("/auth/setup", { method: "POST", body: JSON.stringify({ username, password }) }),
  logout: () => request<void>("/auth/logout", { method: "POST" }),
  changePassword: (current: string, next: string) =>
    request<AuthStatus>("/auth/password", { method: "POST", body: JSON.stringify({ current, new: next }) }),
  users: () => request<AppUser[]>("/users"),
  createUser: (body: { username: string; password: string; role: string; tabs: string[] }) =>
    request<AppUser>("/users", { method: "POST", body: JSON.stringify(body) }),
  updateUser: (
    username: string,
    body: { role?: string; tabs?: string[]; password?: string | null; disabled?: boolean },
  ) => request<AppUser>(`/users/${encodeURIComponent(username)}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteUser: (username: string) => request<void>(`/users/${encodeURIComponent(username)}`, { method: "DELETE" }),
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
  importToClickHouse: (tables: string[]) =>
    request<ClickHouseImportResult[]>("/clickhouse/import", { method: "POST", body: JSON.stringify({ tables }) }),
  restartServer: () => request<SystemParameter[]>("/system/restart", { method: "POST" }),
  setSystemParameter: (name: string, value: string | null) =>
    request<SystemParameter[]>(`/system/parameters/${encodeURIComponent(name)}`, {
      method: "PUT",
      body: JSON.stringify({ value }),
    }),
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

export const useSystemParameters = () => useQuery({ queryKey: ["system", "parameters"], queryFn: api.systemParameters })

export function useSetSystemParameter() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ name, value }: { name: string; value: string | null }) => api.setSystemParameter(name, value),
    onSuccess: (data) => qc.setQueryData(["system", "parameters"], data),
  })
}

/** Apply the edited parameters: the server rebuilds its services, so everything is refetched. */
export function useRestartServer() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: api.restartServer,
    onSuccess: (data) => {
      qc.setQueryData(["system", "parameters"], data)
      qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== "system" })
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

export const useAiAssistStatus = () => useQuery({ queryKey: ["ai-assist", "status"], queryFn: api.aiAssistStatus })
export const useAiAssistSettings = () =>
  useQuery({ queryKey: ["ai-assist", "settings"], queryFn: api.aiAssistSettings })
export function useSaveAiAssistSettings() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: api.saveAiAssistSettings,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ai-assist"] }),
  })
}
export const useTestAiAssist = () => useMutation({ mutationFn: api.testAiAssist })
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

export const useAuthStatus = () => useQuery({ queryKey: ["auth"], queryFn: api.authStatus, staleTime: 60_000 })

/** After signing in, out, or changing the password: new status, and every query fetched again. */
function useAuthChange<A>(fn: (a: A) => Promise<AuthStatus | void>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["auth"] })
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "auth" })
    },
  })
}

export const useLogin = () =>
  useAuthChange((c: { username: string; password: string }) => api.login(c.username, c.password))
export const useSetupAdmin = () =>
  useAuthChange((c: { username: string; password: string }) => api.setupAdmin(c.username, c.password))
export const useLogout = () => useAuthChange(() => api.logout())

export function useChangePassword() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ current, next }: { current: string; next: string }) => api.changePassword(current, next),
    onSuccess: (data) => qc.setQueryData(["auth"], data),
  })
}

export const useUsers = () => useQuery({ queryKey: ["users"], queryFn: api.users })

export function useUserMutation<A>(fn: (a: A) => Promise<unknown>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["users"] })
      qc.invalidateQueries({ queryKey: ["auth"] })
    },
  })
}

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

export const useDirs = (path: string | undefined) =>
  useQuery({
    queryKey: ["fs", "dirs", path ?? ""],
    queryFn: () => api.listDirs(path),
    placeholderData: keepPreviousData,
  })

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

// under ["sql"] so imports and removals refresh it too
export const useCatalog = () => useQuery({ queryKey: ["sql", "catalog"], queryFn: api.catalog })

export const useSqlTables = () => useQuery({ queryKey: ["sql", "tables"], queryFn: api.sqlTables })

export const useSqlQuery = () =>
  useMutation({ mutationFn: ({ sql, limit }: { sql: string; limit?: number }) => api.sqlQuery(sql, limit) })

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

/** Download link for a table (CSV), a schema (ZIP) or the whole catalog (ZIP). */
export function catalogExportUrl(target: { table?: string; schema?: string; format?: "csv" | "parquet" } = {}) {
  const q = new URLSearchParams()
  if (target.table) q.set("table", target.table)
  else if (target.schema) q.set("schema", target.schema)
  if (target.format && target.format !== "csv") q.set("format", target.format)
  const qs = q.toString()
  return `${BASE}/catalog/export${qs ? `?${qs}` : ""}`
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

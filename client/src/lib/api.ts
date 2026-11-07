import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import {
  TERMINAL_STATUSES,
  type PipelineDetail,
  type PipelineSummary,
  type Run,
  type RunTree,
  type ValidationResult,
} from "./types"

const BASE = "/api"
const POLL_MS = 1000

export class ApiError extends Error {
  status: number
  errors: string[]

  constructor(status: number, message: string, errors: string[] = []) {
    super(message)
    this.status = status
    this.errors = errors
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  })
  if (res.status === 204) return undefined as T
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
    throw new ApiError(res.status, errors[0] ?? res.statusText, errors)
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
  deletePipeline: (id: string) => request<void>(`/pipelines/${id}`, { method: "DELETE" }),
  startRun: (id: string, parameters: Record<string, unknown>) =>
    request<Run>(`/pipelines/${id}/runs`, {
      method: "POST",
      body: JSON.stringify({ parameters }),
    }),
  listRuns: (params: { pipeline?: string; rootOnly?: boolean } = {}) => {
    const q = new URLSearchParams()
    if (params.pipeline) q.set("pipeline", params.pipeline)
    q.set("root_only", String(params.rootOnly ?? true))
    return request<Run[]>(`/runs?${q}`)
  },
  getRun: (id: string) => request<Run>(`/runs/${id}`),
  getRunTree: (id: string) => request<RunTree>(`/runs/${id}/tree`),
  cancelRun: (id: string) => request<Run>(`/runs/${id}/cancel`, { method: "POST" }),
}

const isActive = (r?: { status: Run["status"] }) => !!r && !TERMINAL_STATUSES.includes(r.status)
const anyActive = (tree?: RunTree): boolean =>
  !!tree && (isActive(tree) || tree.children.some(anyActive))

// ---------------------------------------------------------------- query hooks
export const usePipelines = () => useQuery({ queryKey: ["pipelines"], queryFn: api.listPipelines })

export const usePipeline = (id: string) =>
  useQuery({ queryKey: ["pipelines", id], queryFn: () => api.getPipeline(id) })

export const useRuns = (params: { pipeline?: string; rootOnly?: boolean } = {}) =>
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

export function useDeletePipeline() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.deletePipeline(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pipelines"] }),
  })
}

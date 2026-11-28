import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { request } from "@prooflix/ui/app/request"

import type {
  AuditEvent,
  CheckResult,
  DatabaseStatus,
  HistoryRun,
  Layer,
  ObjectLink,
  ObjectType,
  OntologyObject,
  Principal,
  PublishedType,
  SourceTable,
} from "./types"

export { ApiError } from "@prooflix/ui/lib/api-error"

const json = (body: unknown) => ({ body: JSON.stringify(body) })
const enc = encodeURIComponent

export const api = {
  sources: () => request<SourceTable[]>("/ontology/sources"),
  types: () =>
    request<{ types: ObjectType[]; drafts: ObjectType[]; broken: string[]; versions: Record<string, number> }>(
      "/ontology/types",
    ),
  type: (name: string) => request<{ type: ObjectType; modified: number; path: string }>(`/ontology/types/${enc(name)}`),
  unpublish: (name: string) => request<void>(`/ontology/types/${enc(name)}`, { method: "DELETE" }),
  draft: (name: string) => request<{ type: ObjectType; modified: number }>(`/ontology/drafts/${enc(name)}`),
  saveDraft: (name: string, type: ObjectType, modified: number | null) =>
    request<{ type: ObjectType; modified: number }>(`/ontology/drafts/${enc(name)}`, {
      method: "PUT",
      ...json({ type, modified }),
    }),
  deleteDraft: (name: string) => request<void>(`/ontology/drafts/${enc(name)}`, { method: "DELETE" }),
  check: (type: ObjectType, steps?: string[]) =>
    request<CheckResult>("/ontology/check", { method: "POST", ...json(steps ? { type, steps } : { type }) }),
  preview: (type: ObjectType, limit = 5, asUser?: string) =>
    request<{ sql: string; visible: boolean; objects: OntologyObject[] }>("/ontology/preview", {
      method: "POST",
      ...json({ type, limit, as_user: asUser || null }),
    }),
  principals: () => request<Principal[]>("/ontology/principals"),
  versions: (name: string) =>
    request<{ version: number; by: string | null; at: string }[]>(`/ontology/types/${enc(name)}/versions`),
  audit: (params: { event?: string; type?: string; user?: string }) =>
    request<AuditEvent[]>(
      `/ontology/audit?${new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][])}`,
    ),
  objectsStatus: () => request<{ database: DatabaseStatus; admin: boolean }>("/ontology/objects/status"),
  runAction: (type: string, pk: string, action: string, values: Record<string, unknown>, reason: string) =>
    request<{ object: OntologyObject }>(`/ontology/objects/${enc(type)}/${enc(pk)}/actions/${enc(action)}`, {
      method: "POST",
      ...json({ values, reason }),
    }),
  history: (type: string, pk: string) =>
    request<{ available: boolean; error: string | null; runs: HistoryRun[] }>(
      `/ontology/objects/${enc(type)}/${enc(pk)}/history`,
    ),
  publish: (type: ObjectType, modified: number | null) =>
    request<{ type: ObjectType; modified: number; path: string }>("/ontology/publish", {
      method: "POST",
      ...json({ type, modified }),
    }),

  objectTypes: () => request<PublishedType[]>("/ontology/objects/types"),
  search: (q: string, type?: string, limit = 10) =>
    request<{
      groups: { type: string; objects: OntologyObject[]; more: boolean; error: string | null }[]
    }>(`/ontology/objects/search?${new URLSearchParams({ q, limit: String(limit), ...(type ? { type } : {}) })}`),
  object: (type: string, pk: string) =>
    request<{
      object: OntologyObject
      layer: Layer
      table: string
      links: ObjectLink[]
      database_error?: string | null
    }>(`/ontology/objects/${enc(type)}/${enc(pk)}`),
  linked: (type: string, pk: string, link: string) =>
    request<{ link: ObjectLink; layer: Layer; objects: OntologyObject[]; more: boolean }>(
      `/ontology/objects/${enc(type)}/${enc(pk)}/links/${enc(link)}`,
    ),
}

export const useSources = () => useQuery({ queryKey: ["ontology", "sources"], queryFn: api.sources })
export const useOntologyTypes = () => useQuery({ queryKey: ["ontology", "types"], queryFn: api.types })

/** The wizard's checks for a draft (only the steps given), re-run when the draft settles. */
export const useChecks = (type: ObjectType | null, steps: string[]) =>
  useQuery({
    queryKey: ["ontology", "check", steps, type],
    queryFn: () => api.check(type!, steps),
    enabled: !!type,
    placeholderData: keepPreviousData,
  })

export const usePreview = (type: ObjectType | null, asUser?: string) =>
  useQuery({
    queryKey: ["ontology", "preview", type, asUser ?? null],
    queryFn: () => api.preview(type!, 5, asUser),
    enabled: !!type,
    placeholderData: keepPreviousData,
  })

export function usePublish() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ type, modified }: { type: ObjectType; modified: number | null }) => api.publish(type, modified),
    // refresh the lists, not the wizard's checks (they would run on the whole table again), and don't wait
    onSuccess: () => {
      void qc.invalidateQueries({
        predicate: (q) => q.queryKey[0] === "ontology" && !["check", "preview", "edit"].includes(String(q.queryKey[1])),
      })
    },
  })
}

export const useObjectTypes = () => useQuery({ queryKey: ["ontology", "objects", "types"], queryFn: api.objectTypes })
export const useSearch = (q: string, type?: string) =>
  useQuery({
    queryKey: ["ontology", "objects", "search", q, type ?? null],
    queryFn: () => api.search(q, type, type ? 50 : 8),
    placeholderData: keepPreviousData,
  })
export const useObject = (type: string, pk: string) =>
  useQuery({ queryKey: ["ontology", "objects", type, pk], queryFn: () => api.object(type, pk) })
export const useLinked = (type: string, pk: string, link: string | null) =>
  useQuery({
    queryKey: ["ontology", "objects", type, pk, "links", link],
    queryFn: () => api.linked(type, pk, link!),
    enabled: !!link,
  })

export const usePrincipals = () => useQuery({ queryKey: ["ontology", "principals"], queryFn: api.principals })
export const useObjectsStatus = () =>
  useQuery({ queryKey: ["ontology", "objects", "status"], queryFn: api.objectsStatus })
export const useHistory = (type: string, pk: string, enabled: boolean) =>
  useQuery({ queryKey: ["ontology", "objects", type, pk, "history"], queryFn: () => api.history(type, pk), enabled })
export const useAudit = (params: { event?: string; type?: string; user?: string }) =>
  useQuery({ queryKey: ["ontology", "audit", params], queryFn: () => api.audit(params) })

export function useRunAction(type: string, pk: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ action, values, reason }: { action: string; values: Record<string, unknown>; reason: string }) =>
      api.runAction(type, pk, action, values, reason),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["ontology", "objects", type, pk] })
      void qc.invalidateQueries({ queryKey: ["ontology", "objects", "search"] })
    },
  })
}

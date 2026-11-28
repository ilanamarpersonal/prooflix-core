import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { request } from "@prooflix/ui/app/request"

import type { AiAssistSettings, AiAssistSettingsIn, AppUser, SystemParameter } from "./types"

// shared by every product: the API error, sign-in state and the System tab's setting changes
export { ApiError } from "@prooflix/ui/lib/api-error"
export { useAuthStatus } from "@prooflix/ui/auth/api"
export { useRestartServer, useSetSystemParameter } from "@prooflix/ui/ai-assist/api"

export const api = {
  aiAssistSettings: () => request<AiAssistSettings>("/ai-assist/settings"),
  saveAiAssistSettings: (body: AiAssistSettingsIn) =>
    request<AiAssistSettings>("/ai-assist/settings", { method: "PUT", body: JSON.stringify(body) }),
  testAiAssist: () =>
    request<{ ok: boolean; model: string; display_name: string }>("/ai-assist/settings/test", { method: "POST" }),
  systemParameters: () => request<SystemParameter[]>("/system/parameters"),
  users: () => request<AppUser[]>("/users"),
  createUser: (body: { username: string; password: string; role: string; tabs: string[] }) =>
    request<AppUser>("/users", { method: "POST", body: JSON.stringify(body) }),
  updateUser: (
    username: string,
    body: { role?: string; tabs?: string[]; password?: string | null; disabled?: boolean },
  ) => request<AppUser>(`/users/${encodeURIComponent(username)}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteUser: (username: string) => request<void>(`/users/${encodeURIComponent(username)}`, { method: "DELETE" }),
}

export const useSystemParameters = () => useQuery({ queryKey: ["system", "parameters"], queryFn: api.systemParameters })

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

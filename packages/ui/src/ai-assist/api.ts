import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { request } from "../app/request"

/** AI Assist's state as every signed-in user sees it. */
export interface AiAssistStatus {
  ready: boolean
  enabled: boolean
  model: string
}

/** A question and AI Assist's answer. */
export interface AiAssistRunTurn {
  question: string
  answer: string
}

/** A System tab setting AI Assist proposes to change; saved only when the user applies it. */
export interface AiAssistSettingChange {
  name: string
  current: string | null
  /** "" removes the saved value (back to the default) */
  value: string
  reason: string
  /** applied by Restart server (otherwise only a restart of the server process applies it) */
  live: boolean
}

export interface AiAssistSettingsFix {
  summary: string
  changes: AiAssistSettingChange[]
  /** what the user has to do by hand */
  steps: string[]
  model: string
}

/** An answer from the AI Assist chat on any screen. */
export interface AiAssistGeneralReply {
  answer: string
  /** a setting change might fix what the user asked about: the panel offers Fix it */
  can_fix: boolean
  /** a screen (tab id) to offer a button to; "" for none */
  open_screen: string
  model: string
}

export const aiAssistApi = {
  status: () => request<AiAssistStatus>("/ai-assist/status"),
  ask: (question: string, page: string, error: string, turns: AiAssistRunTurn[]) =>
    request<AiAssistGeneralReply>("/ai-assist/ask", {
      method: "POST",
      body: JSON.stringify({
        question,
        page,
        error,
        turns: turns.map((t) => ({ question: t.question, answer: t.answer })),
      }),
    }),
  fix: (page: string, error: string, turns: AiAssistRunTurn[]) =>
    request<AiAssistSettingsFix>("/ai-assist/fix", { method: "POST", body: JSON.stringify({ page, error, turns }) }),
  restartServer: () => request<unknown[]>("/system/restart", { method: "POST" }),
  setSystemParameter: (name: string, value: string | null) =>
    request<unknown[]>(`/system/parameters/${encodeURIComponent(name)}`, {
      method: "PUT",
      body: JSON.stringify({ value }),
    }),
}

export const useAiAssistStatus = () => useQuery({ queryKey: ["ai-assist", "status"], queryFn: aiAssistApi.status })

/** A question from the AI Assist panel on any screen, with the screen's name and the error it shows. */
export const useAiAssistAsk = () =>
  useMutation({
    mutationFn: ({
      question,
      page,
      error,
      turns,
    }: {
      question: string
      page: string
      error: string
      turns: AiAssistRunTurn[]
    }) => aiAssistApi.ask(question, page, error, turns),
  })

/** Setting changes (and manual steps) that would fix what a screen shows, for the user to review (nothing saved). */
export const useAiAssistFix = () =>
  useMutation({
    mutationFn: ({ page, error, turns }: { page: string; error: string; turns: AiAssistRunTurn[] }) =>
      aiAssistApi.fix(page, error, turns),
  })

/** Save one System tab setting (applied by Restart server). */
export function useSetSystemParameter() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ name, value }: { name: string; value: string | null }) =>
      aiAssistApi.setSystemParameter(name, value),
    onSuccess: (data) => qc.setQueryData(["system", "parameters"], data),
  })
}

/** Apply the edited settings: the server rebuilds its services, so everything is refetched. */
export function useRestartServer() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: aiAssistApi.restartServer,
    onSuccess: (data) => {
      qc.setQueryData(["system", "parameters"], data)
      qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== "system" })
    },
  })
}

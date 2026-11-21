import { useEffect, useState } from "react"
import { CheckCircle2, KeyRound, Loader2, PlugZap, Save, Trash2 } from "lucide-react"

import { AiAssistIcon } from "@/components/ai-assist-icon"
import { ErrorAlert } from "@/components/error-alert"
import { PageHeader } from "@/components/page-header"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { useAiAssistSettings, useSaveAiAssistSettings, useTestAiAssist } from "@/lib/api"
import type { AiAssistSettings } from "@/lib/types"

const EFFORTS = [
  { id: "low", label: "Low: quickest answers" },
  { id: "medium", label: "Medium (recommended)" },
  { id: "high", label: "High: most thorough" },
]

/** Admins set the Claude account AI Assist uses: the API key, the model and how hard it thinks. */
export function AiAssistPage() {
  const settings = useAiAssistSettings()
  return (
    <div>
      <PageHeader
        title="AI Assist"
        description="Claude inside Prooflix. When a query fails in the SQL editor, AI Assist offers to look at it, explains the error and suggests a fix you can run. Only the query, the error and the catalog's table and column names are sent to Claude, and only after the user agrees."
      />
      {settings.error && <ErrorAlert title="Could not load the AI Assist settings" error={settings.error} />}
      {settings.isLoading && <Skeleton className="h-64 w-full max-w-2xl" />}
      {settings.data && <SettingsForm key={JSON.stringify(settings.data)} current={settings.data} />}
    </div>
  )
}

function SettingsForm({ current }: { current: AiAssistSettings }) {
  const [enabled, setEnabled] = useState(current.enabled)
  const [model, setModel] = useState(current.model)
  const [effort, setEffort] = useState<string>(current.effort)
  const [apiKey, setApiKey] = useState("")
  const save = useSaveAiAssistSettings()
  const test = useTestAiAssist()
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    if (!saved) return
    const t = setTimeout(() => setSaved(false), 3000)
    return () => clearTimeout(t)
  }, [saved])

  const changed =
    enabled !== current.enabled || model !== current.model || effort !== current.effort || apiKey.trim() !== ""
  const submit = (remove_key = false) => {
    test.reset()
    save.mutate(
      { enabled, model, effort, api_key: apiKey.trim() || null, remove_key },
      {
        onSuccess: () => {
          setApiKey("")
          setSaved(true)
        },
      },
    )
  }

  return (
    <div className="grid max-w-2xl gap-4">
      <Card className="gap-0 py-0">
        <CardHeader className="flex flex-row items-center gap-3 border-b px-4 py-3">
          <AiAssistIcon className="size-5" />
          <CardTitle className="flex-1 text-base">Claude account</CardTitle>
          {current.ready ? (
            <Badge variant="secondary" className="gap-1">
              <CheckCircle2 className="size-3 text-emerald-600" /> Ready
            </Badge>
          ) : (
            <Badge variant="outline">{current.enabled ? "No API key" : "Off"}</Badge>
          )}
        </CardHeader>
        <CardContent className="grid gap-5 px-4 py-4 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              className="accent-primary size-4"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            Turn AI Assist on
          </label>

          <div className="grid gap-1.5">
            <label htmlFor="ai-assist-key" className="font-medium">
              Claude API key
            </label>
            <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
              <KeyRound className="size-3.5" />
              {current.key_source === "saved" && <>A key ending in {current.key_hint} is saved.</>}
              {current.key_source === "environment" && (
                <>
                  Using the server's <code className="font-mono">ANTHROPIC_API_KEY</code> ({current.key_hint}). A key
                  saved here takes its place.
                </>
              )}
              {current.key_source === "none" && <>No key yet.</>}
            </div>
            <Input
              id="ai-assist-key"
              type="password"
              autoComplete="off"
              placeholder={current.key_source === "saved" ? "Leave empty to keep the saved key" : "sk-ant-…"}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
            <p className="text-muted-foreground text-xs">
              Create one in the Claude Console under API keys. It is kept on the server in{" "}
              <code className="font-mono">PROOFLIX_HOME/ai_assist.json</code> (readable only by the server's user) and
              is never shown again.
            </p>
          </div>

          <div className="grid gap-1.5">
            <label htmlFor="ai-assist-model" className="font-medium">
              Model
            </label>
            <select
              id="ai-assist-model"
              className="border-input bg-background h-9 rounded-md border px-3 text-sm"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            >
              {current.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>

          <div className="grid gap-1.5">
            <label htmlFor="ai-assist-effort" className="font-medium">
              Effort
            </label>
            <select
              id="ai-assist-effort"
              className="border-input bg-background h-9 rounded-md border px-3 text-sm"
              value={effort}
              onChange={(e) => setEffort(e.target.value)}
            >
              {EFFORTS.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.label}
                </option>
              ))}
            </select>
            <p className="text-muted-foreground text-xs">
              How much Claude thinks before answering. Higher effort takes longer and uses more tokens.
            </p>
          </div>

          {save.error && <ErrorAlert title="Not saved" error={save.error} />}
          {test.error && <ErrorAlert title="The connection test failed" error={test.error} />}
          {test.data && (
            <p className="flex items-center gap-2 text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 className="size-4" /> Connected: the key works with {test.data.display_name}.
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => submit()} disabled={!changed || save.isPending}>
              {save.isPending ? <Loader2 className="animate-spin" /> : <Save />} Save
            </Button>
            <Button
              variant="outline"
              onClick={() => test.mutate()}
              disabled={changed || !current.ready || test.isPending}
              title={changed ? "Save first" : undefined}
            >
              {test.isPending ? <Loader2 className="animate-spin" /> : <PlugZap />} Test connection
            </Button>
            {current.key_source === "saved" && (
              <Button
                variant="ghost"
                className="text-destructive"
                onClick={() => submit(true)}
                disabled={save.isPending}
              >
                <Trash2 /> Remove the key
              </Button>
            )}
            {saved && <span className="text-muted-foreground text-xs">Saved</span>}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

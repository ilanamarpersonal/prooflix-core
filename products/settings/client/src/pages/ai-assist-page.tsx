import { useEffect, useState } from "react"
import { CheckCircle2, KeyRound, Loader2, PlugZap, RefreshCw, Save, Trash2 } from "lucide-react"

import { AiAssistIcon } from "@prooflix/ui/ai-assist/icon"
import { ErrorAlert } from "@prooflix/ui/app/error-alert"
import { PageHeader } from "@prooflix/ui/app/page-header"
import { Badge } from "@prooflix/ui/components/ui/badge"
import { Button } from "@prooflix/ui/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@prooflix/ui/components/ui/card"
import { Input } from "@prooflix/ui/components/ui/input"
import { Skeleton } from "@prooflix/ui/components/ui/skeleton"
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

/** dollars as in a price list: $4, $0.10, $0.042, $0.0011 */
function usd(n: number) {
  if (Number.isInteger(n)) return `$${n}`
  if (n >= 0.1) return `$${n.toFixed(2)}`
  return `$${n.toPrecision(2)}`
}

// A typical request: the query, the error and a small catalog in (~3,000 tokens), the answer
// with its thinking out (~1,500 tokens). Only a guide; the Claude Console shows what was spent.
const TYPICAL_INPUT_TOKENS = 3000
const TYPICAL_OUTPUT_TOKENS = 1500
function fixCost(m: { input_price: number; output_price: number }) {
  return (TYPICAL_INPUT_TOKENS * m.input_price + TYPICAL_OUTPUT_TOKENS * m.output_price) / 1_000_000
}

function SettingsForm({ current }: { current: AiAssistSettings }) {
  const [enabled, setEnabled] = useState(current.enabled)
  const [model, setModel] = useState(current.model)
  const [effort, setEffort] = useState<string>(current.effort)
  const [apiKey, setApiKey] = useState("")
  // the key input shows when there is no key yet, or after "Replace"
  const [replacing, setReplacing] = useState(false)
  const selected = current.models.find((m) => m.id === model)
  const hasKey = current.key_source !== "none"
  const showInput = !hasKey || replacing
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
          setReplacing(false)
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
            <label htmlFor={showInput ? "ai-assist-key" : undefined} className="font-medium">
              Claude API key
            </label>
            {hasKey && (
              <div className="flex flex-wrap items-center gap-3 rounded-md border px-3 py-2">
                <KeyRound className="text-muted-foreground size-4 shrink-0" />
                <div className="grid min-w-0 flex-1 gap-0.5">
                  <code className="truncate font-mono text-sm">
                    {current.key_prefix ? `${current.key_prefix}-` : ""}
                    {"•".repeat(8)}
                    {current.key_hint?.replace("…", "")}
                  </code>
                  <span className="text-muted-foreground text-xs">
                    {current.key_source === "saved" ? (
                      current.key_saved_at ? (
                        <>Saved {new Date(current.key_saved_at).toLocaleString()}</>
                      ) : (
                        <>Saved</>
                      )
                    ) : (
                      <>
                        From the server's <code className="font-mono">ANTHROPIC_API_KEY</code>; a key saved here takes
                        its place
                      </>
                    )}
                  </span>
                </div>
                {!replacing && (
                  <Button variant="outline" size="sm" onClick={() => setReplacing(true)} disabled={save.isPending}>
                    <RefreshCw /> {current.key_source === "saved" ? "Replace" : "Save a key"}
                  </Button>
                )}
                {current.key_source === "saved" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive"
                    onClick={() => submit(true)}
                    disabled={save.isPending}
                  >
                    <Trash2 /> Remove
                  </Button>
                )}
              </div>
            )}
            {showInput && (
              <div className="flex items-center gap-2">
                <Input
                  id="ai-assist-key"
                  type="password"
                  autoComplete="off"
                  autoFocus={replacing}
                  placeholder={hasKey ? "Paste the new key" : "sk-ant-…"}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                />
                {replacing && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setReplacing(false)
                      setApiKey("")
                    }}
                  >
                    Cancel
                  </Button>
                )}
              </div>
            )}
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
                  {m.label} · {usd(m.input_price)} / {usd(m.output_price)} per 1M tokens
                </option>
              ))}
            </select>
            {selected && (
              <p className="text-muted-foreground text-xs">
                {usd(selected.input_price)} per million input tokens, {usd(selected.output_price)} per million output
                tokens. A suggested fix costs roughly {usd(fixCost(selected))}; a big catalog or higher effort costs
                more.
              </p>
            )}
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
            {saved && <span className="text-muted-foreground text-xs">Saved</span>}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

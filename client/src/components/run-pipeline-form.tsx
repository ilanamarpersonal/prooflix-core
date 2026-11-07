import { useState } from "react"
import { useNavigate } from "react-router"
import { Play } from "lucide-react"

import { ErrorAlert } from "@/components/error-alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useStartRun } from "@/lib/api"

const toText = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v))

/** JSON values keep their type (numbers, booleans, lists); anything else is sent as text. */
const fromText = (s: string): unknown => {
  try {
    return JSON.parse(s)
  } catch {
    return s
  }
}

export function RunPipelineForm({
  pipelineId,
  parameters,
  onDone,
}: {
  pipelineId: string
  parameters: Record<string, unknown>
  onDone?: () => void
}) {
  const navigate = useNavigate()
  const start = useStartRun()
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(parameters).map(([k, v]) => [k, toText(v)])),
  )

  const submit = (ev: React.FormEvent) => {
    ev.preventDefault()
    const changed: Record<string, unknown> = {}
    for (const [k, text] of Object.entries(values)) {
      if (text !== toText(parameters[k])) changed[k] = fromText(text)
    }
    start.mutate(
      { id: pipelineId, parameters: changed },
      {
        onSuccess: (run) => {
          onDone?.()
          navigate(`/runs/${run.id}`)
        },
      },
    )
  }

  const keys = Object.keys(parameters)
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle>Run with parameters</CardTitle>
        <CardDescription>
          {keys.length
            ? "Values are read as JSON when possible (numbers, true/false, lists); otherwise as text."
            : "This pipeline declares no parameters."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="grid gap-4">
          {keys.map((k) => (
            <div key={k} className="grid gap-1.5">
              <Label htmlFor={`param-${k}`}>{k}</Label>
              <Input
                id={`param-${k}`}
                value={values[k] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [k]: e.target.value }))}
                className="font-mono"
              />
            </div>
          ))}
          {start.error && <ErrorAlert title="Could not start the run" error={start.error} />}
          <div className="flex gap-2">
            <Button type="submit" disabled={start.isPending}>
              <Play /> {start.isPending ? "Starting…" : "Start run"}
            </Button>
            {onDone && (
              <Button type="button" variant="ghost" onClick={onDone}>
                Cancel
              </Button>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

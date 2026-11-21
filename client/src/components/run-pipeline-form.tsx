import { useState } from "react"
import { useNavigate } from "react-router"
import { Loader2, Play } from "lucide-react"

import { ErrorAlert } from "@/components/error-alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useStartRun } from "@/lib/api"
import type { ParameterSpec } from "@/lib/types"

const selectClass =
  "border-input bg-background h-9 w-full rounded-md border px-2 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"

const toText = (v: unknown) => (v === null || v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v))

/** JSON values keep their type (numbers, booleans, lists); anything else is sent as text. */
const fromText = (s: string): unknown => {
  try {
    return JSON.parse(s)
  } catch {
    return s
  }
}

// a preview only: the server checks every value again before the run starts
const IDENTIFIER = /^[a-z][a-z0-9_]{0,31}$/
const INPUT_TYPE: Partial<Record<ParameterSpec["type"], string>> = { integer: "number", number: "number", date: "date" }
const HINT: Partial<Record<ParameterSpec["type"], string>> = {
  identifier: "a letter, then lowercase letters, digits or _ (at most 32), like tenant1",
  list: "a JSON list, like [1, 2]",
  object: 'a JSON object, like {"a": 1}',
  any: "read as JSON when possible (numbers, true/false, lists); otherwise as text",
}

/** What is wrong with the typed text, before sending it (the server has the last word). */
function problem(spec: ParameterSpec, text: string): string | null {
  const value = text.trim()
  if (!value) return spec.required && spec.default == null ? "Required" : null
  if (spec.type === "identifier" && !IDENTIFIER.test(value)) return "Must be a short lowercase identifier"
  if (spec.type === "integer" && !/^[+-]?\d+$/.test(value)) return "Must be a whole number"
  if (spec.pattern) {
    try {
      if (!new RegExp(`^(?:${spec.pattern})$`).test(value)) return `Must match ${spec.pattern}`
    } catch {
      return null
    }
  }
  return null
}

/** The value sent for a parameter: typed text goes as text (the server converts it), any-typed text as JSON. */
function toValue(spec: ParameterSpec, text: string): unknown {
  if (spec.type === "any") return fromText(text)
  if (spec.type === "boolean") return text === "true"
  if (spec.choices) return spec.choices.find((c) => toText(c) === text) ?? text
  return text.trim()
}

/**
 * The content of the Run with parameters panel: one field per parameter the pipeline declares in its YAML
 * (in the workspace bundle), defaults filled in, typed when the declaration has a type, and a Run button.
 */
export function RunPipelineForm({
  pipelineId,
  parameters,
  onDone,
}: {
  pipelineId: string
  parameters: Record<string, ParameterSpec>
  onDone?: () => void
}) {
  const navigate = useNavigate()
  const start = useStartRun()
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(parameters).map(([k, p]) => [k, toText(p.default)])),
  )
  const [touched, setTouched] = useState(false)
  const problems = Object.fromEntries(Object.entries(parameters).map(([k, p]) => [k, problem(p, values[k] ?? "")]))
  const invalid = Object.values(problems).some(Boolean)

  const submit = (ev: React.FormEvent) => {
    ev.preventDefault()
    setTouched(true)
    if (invalid) return
    const changed: Record<string, unknown> = {}
    for (const [k, p] of Object.entries(parameters)) {
      const text = values[k] ?? ""
      if (text !== toText(p.default)) changed[k] = toValue(p, text)
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

  const set = (k: string, text: string) => setValues((v) => ({ ...v, [k]: text }))
  const keys = Object.keys(parameters)
  return (
    <div className="grid gap-3">
      <div className="grid gap-0.5">
        <h3 className="text-sm font-semibold">Run with parameters</h3>
        <p className="text-muted-foreground text-xs">
          {keys.length
            ? "Declared in the pipeline's YAML. The server checks each value before the run starts."
            : "This pipeline declares no parameters."}
        </p>
      </div>
      <form onSubmit={submit} className="grid gap-3" noValidate>
        {keys.map((k) => {
          const p = parameters[k]
          const id = `param-${k}`
          const error = touched ? problems[k] : null
          const hint = p.description || HINT[p.type]
          return (
            <div key={k} className="grid gap-1.5">
              <Label htmlFor={id} className="flex flex-wrap items-center gap-2">
                <span className="font-mono">{k}</span>
                {p.required && <span className="text-status-failed">*</span>}
                {p.type !== "any" && (
                  <Badge variant="outline" className="font-normal">
                    {p.type}
                  </Badge>
                )}
              </Label>
              {p.type === "boolean" ? (
                <label className="flex items-center gap-2 text-sm">
                  <input
                    id={id}
                    type="checkbox"
                    className="accent-primary size-4"
                    checked={values[k] === "true"}
                    onChange={(e) => set(k, e.target.checked ? "true" : "false")}
                  />
                  {values[k] === "true" ? "true" : "false"}
                </label>
              ) : p.choices ? (
                <select
                  id={id}
                  className={selectClass}
                  value={values[k] ?? ""}
                  onChange={(e) => set(k, e.target.value)}
                >
                  {!p.required && <option value="">(none)</option>}
                  {p.choices.map((c) => (
                    <option key={toText(c)} value={toText(c)}>
                      {toText(c)}
                    </option>
                  ))}
                </select>
              ) : (
                <Input
                  id={id}
                  type={INPUT_TYPE[p.type] ?? "text"}
                  value={values[k] ?? ""}
                  placeholder={p.default == null ? (p.required ? "required" : "optional") : toText(p.default)}
                  onChange={(e) => set(k, e.target.value)}
                  aria-invalid={!!error}
                  aria-describedby={hint ? `${id}-hint` : undefined}
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                />
              )}
              {error ? (
                <p className="text-status-failed text-xs">{error}</p>
              ) : (
                hint && (
                  <p id={`${id}-hint`} className="text-muted-foreground text-xs">
                    {hint}
                  </p>
                )
              )}
            </div>
          )
        })}
        {start.error && <ErrorAlert title="Could not start the run" error={start.error} />}
        <div className="flex justify-end gap-2">
          {onDone && (
            <Button type="button" size="sm" variant="ghost" onClick={onDone}>
              Cancel
            </Button>
          )}
          <Button type="submit" size="sm" disabled={start.isPending}>
            {start.isPending ? <Loader2 className="animate-spin" /> : <Play />} Run
          </Button>
        </div>
      </form>
    </div>
  )
}

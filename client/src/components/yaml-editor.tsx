import { useState } from "react"
import { CheckCircle2, Save, ShieldCheck } from "lucide-react"

import { ErrorAlert, ValidationErrors } from "@/components/error-alert"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { api, useSavePipeline } from "@/lib/api"
import type { PipelineDetail } from "@/lib/types"

/**
 * Plain-text YAML editor with server-side validation.
 * Validation runs against the whole workspace, so sub-pipeline references and
 * recursion are checked too.
 */
export function YamlEditor({
  pipelineId,
  savedSource,
  startingSource,
  onSaved,
}: {
  pipelineId: string
  /** The YAML currently on disk; null for a pipeline that does not exist yet. */
  savedSource: string | null
  /** Text to start with when it differs from the saved file (e.g. a template). */
  startingSource?: string
  onSaved?: (detail: PipelineDetail) => void
}) {
  const [source, setSource] = useState(startingSource ?? savedSource ?? "")
  const [errors, setErrors] = useState<string[] | null>(null)
  const [validating, setValidating] = useState(false)
  const save = useSavePipeline()

  const dirty = savedSource === null || source !== savedSource

  const validate = async () => {
    setValidating(true)
    try {
      setErrors((await api.validatePipeline(pipelineId, source)).errors)
    } catch (e) {
      setErrors([e instanceof Error ? e.message : String(e)])
    } finally {
      setValidating(false)
    }
  }

  const submit = () =>
    save.mutate(
      { id: pipelineId, source, createOnly: savedSource === null },
      {
        onSuccess: (detail) => {
          setErrors([])
          onSaved?.(detail)
        },
      },
    )

  return (
    <div className="grid gap-3">
      <Textarea
        value={source}
        onChange={(e) => {
          setSource(e.target.value)
          setErrors(null)
        }}
        spellCheck={false}
        aria-label="Pipeline YAML"
        className="min-h-[28rem] font-mono text-sm leading-relaxed md:text-[13px]"
        onKeyDown={(e) => {
          // Insert two spaces on Tab instead of moving focus.
          if (e.key === "Tab" && !e.shiftKey) {
            e.preventDefault()
            const el = e.currentTarget
            const { selectionStart: s, selectionEnd: end } = el
            const next = source.slice(0, s) + "  " + source.slice(end)
            setSource(next)
            requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2))
          }
          if ((e.metaKey || e.ctrlKey) && e.key === "s") {
            e.preventDefault()
            submit()
          }
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" onClick={validate} disabled={validating}>
          <ShieldCheck /> {validating ? "Validating…" : "Validate"}
        </Button>
        <Button onClick={submit} disabled={save.isPending || !dirty}>
          <Save /> {save.isPending ? "Saving…" : "Save"}
        </Button>
        {dirty && savedSource !== null && (
          <span className="text-muted-foreground text-sm">Unsaved changes</span>
        )}
        {errors?.length === 0 && (
          <span className="text-status-succeeded flex items-center gap-1 text-sm">
            <CheckCircle2 className="size-4" /> Valid
          </span>
        )}
      </div>
      {errors && <ValidationErrors errors={errors} />}
      {save.error && <ErrorAlert title="Could not save" error={save.error} />}
    </div>
  )
}

import { Loader2, Square } from "lucide-react"

import { Button } from "@prooflix/ui/components/ui/button"
import { useCancelRun } from "@/lib/api"
import type { Run } from "@/lib/types"

/**
 * Stops a pipeline's runs that are going (cancelling a run also cancels its
 * sub-pipeline runs). Shown only while the pipeline is running.
 */
export function StopButton({
  runs,
  size = "default",
  variant = "outline",
}: {
  /** the pipeline's active runs */
  runs: Run[] | undefined
  size?: "default" | "sm"
  variant?: "default" | "outline"
}) {
  const cancel = useCancelRun()
  if (!runs?.length) return null

  const stop = () => {
    const what = runs.length === 1 ? `run ${runs[0].id}` : `its ${runs.length} runs`
    const nested = runs.some((r) => r.depth > 0)
      ? "\n\nIt is running as a sub-pipeline, so the pipeline that called it fails too."
      : ""
    if (!window.confirm(`Stop ${what} of ${runs[0].pipeline}?${nested}`)) return
    // a run may finish meanwhile: one refused cancel shouldn't stop the others
    for (const r of runs) cancel.mutate(r.id)
  }

  return (
    <Button
      size={size}
      variant={variant}
      onClick={stop}
      disabled={cancel.isPending}
      className="text-destructive hover:text-destructive"
      title={cancel.error ? `Could not stop: ${cancel.error.message}` : "Stop the running pipeline"}
    >
      <span className="contents">{cancel.isPending ? <Loader2 className="animate-spin" /> : <Square />}</span> Stop
    </Button>
  )
}

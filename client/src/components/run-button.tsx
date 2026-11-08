import { useNavigate } from "react-router"
import { Loader2, Play } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useStartRun } from "@/lib/api"

/**
 * Starts a run and opens it, so you watch its tasks run.
 * A pipeline with parameters calls ``onNeedsParameters`` instead, to show the
 * parameter form first.
 */
export function RunButton({
  pipeline,
  onNeedsParameters,
  size = "default",
  variant = "default",
}: {
  pipeline: { id: string; valid: boolean; parameters: Record<string, unknown> }
  onNeedsParameters?: () => void
  size?: "default" | "sm"
  variant?: "default" | "outline"
}) {
  const navigate = useNavigate()
  const start = useStartRun()
  const hasParameters = Object.keys(pipeline.parameters).length > 0

  const click = () => {
    if (hasParameters && onNeedsParameters) return onNeedsParameters()
    start.mutate(
      { id: pipeline.id, parameters: {} },
      { onSuccess: (run) => navigate(`/runs/${run.id}`) },
    )
  }

  return (
    <Button
      size={size}
      variant={variant}
      onClick={click}
      disabled={!pipeline.valid || start.isPending}
      title={
        !pipeline.valid
          ? "Fix the pipeline's errors to run it"
          : start.error
            ? `Could not start: ${start.error.message}`
            : undefined
      }
    >
      {start.isPending ? <Loader2 className="animate-spin" /> : <Play />} Run
    </Button>
  )
}

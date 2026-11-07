import { CheckCircle2, CircleDashed, CircleSlash, Loader2, MinusCircle, XCircle } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import type { RunStatus } from "@/lib/types"
import { cn } from "@/lib/utils"

export const STATUS_STYLE: Record<RunStatus, { className: string; icon: typeof CheckCircle2 }> = {
  PENDING: { className: "text-status-pending border-status-pending/40", icon: CircleDashed },
  RUNNING: { className: "text-status-running border-status-running/40", icon: Loader2 },
  SUCCEEDED: { className: "text-status-succeeded border-status-succeeded/40", icon: CheckCircle2 },
  FAILED: { className: "text-status-failed border-status-failed/40", icon: XCircle },
  SKIPPED: { className: "text-status-skipped border-status-skipped/40", icon: MinusCircle },
  CANCELLED: { className: "text-status-cancelled border-status-cancelled/40", icon: CircleSlash },
}

export function StatusBadge({ status, className }: { status: RunStatus; className?: string }) {
  const { className: tone, icon: Icon } = STATUS_STYLE[status]
  return (
    <Badge variant="outline" className={cn(tone, className)}>
      <Icon className={cn(status === "RUNNING" && "animate-spin")} />
      {status.toLowerCase()}
    </Badge>
  )
}

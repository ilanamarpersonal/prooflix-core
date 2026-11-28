import { FileCode2, Terminal, Workflow } from "lucide-react"

import type { TaskType } from "@/lib/types"

const ICONS = { python: FileCode2, shell: Terminal, pipeline: Workflow } as const

export function TaskTypeIcon({ type, className }: { type: TaskType; className?: string }) {
  const Icon = ICONS[type] ?? FileCode2
  return <Icon className={className ?? "size-4"} aria-label={type} />
}

import { useEffect, useMemo, useRef } from "react"
import { Link } from "react-router"
import { ExternalLink, FileCode, SquareTerminal, Workflow } from "lucide-react"

import { ErrorAlert } from "@/components/error-alert"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { useTaskCode } from "@/lib/api"
import { cn } from "@/lib/utils"

const ICONS = { python: FileCode, shell: SquareTerminal, pipeline: Workflow }
const LABELS = { python: "Code", shell: "Command", pipeline: "Sub-pipeline" }

/** The code a selected task runs: its Python file (at the function), shell command, or sub-pipeline YAML. */
export function TaskCodeView({ pipelineId, taskKey }: { pipelineId: string; taskKey: string }) {
  const code = useTaskCode(pipelineId, taskKey)
  const lines = useMemo(() => code.data?.content.split("\n") ?? [], [code.data?.content])
  const scroller = useRef<HTMLDivElement>(null)
  const target = useRef<HTMLTableRowElement>(null)

  // bring the function into view inside the code box (not the whole page)
  useEffect(() => {
    const box = scroller.current
    const row = target.current
    if (box && row) box.scrollTop = Math.max(0, row.offsetTop - 8)
    else if (box) box.scrollTop = 0
  }, [code.data])

  if (code.isLoading) return <Skeleton className="h-40" />
  if (code.error) return <ErrorAlert title="Could not load the code" error={code.error} />
  if (!code.data) return null

  const { type, path, line, truncated } = code.data
  const Icon = ICONS[type]
  return (
    <div className="grid min-w-0 gap-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Icon className="text-muted-foreground size-4 shrink-0" />
        <span className="text-sm font-medium">{LABELS[type]}</span>
        {path && (
          <code className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-xs" title={path}>
            {path}
            {line ? `:${line}` : ""}
          </code>
        )}
        {path && (
          <Button variant="outline" size="sm" className="ml-auto" asChild>
            <Link to={`/workspace?${new URLSearchParams({ path })}`}>
              <ExternalLink /> Open in Workspace
            </Link>
          </Button>
        )}
      </div>
      <div ref={scroller} className="bg-muted/40 max-h-96 overflow-auto rounded-md border">
        <table className="w-full font-mono text-[13px] leading-relaxed">
          <tbody>
            {lines.map((text, i) => {
              const isTarget = line === i + 1
              return (
                <tr key={i} ref={isTarget ? target : undefined} className={cn(isTarget && "bg-primary/10")}>
                  <td
                    className={cn(
                      "text-muted-foreground/70 sticky left-0 w-px bg-inherit px-3 text-right align-top select-none",
                      isTarget && "text-primary font-semibold",
                    )}
                  >
                    {i + 1}
                  </td>
                  <td className="pr-4 whitespace-pre">{text || " "}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {truncated && (
          <div className="text-muted-foreground border-t px-3 py-1.5 text-xs">Showing the first 1 MB of this file.</div>
        )}
      </div>
    </div>
  )
}

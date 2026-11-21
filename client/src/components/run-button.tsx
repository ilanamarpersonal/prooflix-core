import { useEffect, useRef, useState } from "react"
import { useNavigate } from "react-router"
import { ChevronDown, Loader2, Play, SlidersHorizontal } from "lucide-react"

import { RunPipelineForm } from "@/components/run-pipeline-form"
import { Button } from "@/components/ui/button"
import { useStartRun } from "@/lib/api"
import type { ParameterSpec } from "@/lib/types"
import { cn } from "@/lib/utils"

const PANEL_WIDTH = 320

/** Closes a floating box on a click outside it, Escape, or the page scrolling (not scrolling inside it). */
function useDismiss(box: React.RefObject<HTMLElement | null>, onClose: () => void, ignore?: HTMLElement | null) {
  useEffect(() => {
    const outside = (target: EventTarget | null) =>
      !box.current?.contains(target as Node) && !(ignore && ignore.contains(target as Node))
    const click = (e: MouseEvent) => outside(e.target) && onClose()
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose()
    const scroll = (e: Event) => outside(e.target) && onClose()
    document.addEventListener("mousedown", click)
    document.addEventListener("keydown", key)
    window.addEventListener("scroll", scroll, true)
    return () => {
      document.removeEventListener("mousedown", click)
      document.removeEventListener("keydown", key)
      window.removeEventListener("scroll", scroll, true)
    }
  }, [box, onClose, ignore])
}

/**
 * Run: starts a run with the pipeline's default parameters and opens it, so you watch its tasks run.
 * The arrow on its right opens a menu with "Run with parameters…": a small panel with the parameters the
 * pipeline declares in its YAML (defaults filled in) and its own Run button. A pipeline
 * with a required parameter that has no default opens that panel on Run, since it can't run on defaults.
 */
export function RunButton({
  pipeline,
  size = "default",
  variant = "default",
  openParameters = false,
}: {
  pipeline: { id: string; valid: boolean; parameter_specs: Record<string, ParameterSpec> }
  size?: "default" | "sm"
  variant?: "default" | "outline"
  /** open the parameters panel at first (a link with ?run=1) */
  openParameters?: boolean
}) {
  const navigate = useNavigate()
  const start = useStartRun()
  const group = useRef<HTMLDivElement>(null)
  const [menu, setMenu] = useState(false)
  const [panel, setPanel] = useState(false)
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const specs = pipeline.parameter_specs
  const hasParameters = Object.keys(specs).length > 0
  const needsValues = Object.values(specs).some((p) => p.required && (p.default == null || p.default === ""))

  const place = () => setAnchor(group.current?.getBoundingClientRect() ?? null)
  const openPanel = () => {
    place()
    setMenu(false)
    setPanel(true)
  }

  useEffect(() => {
    if (openParameters && hasParameters && pipeline.valid) openPanel()
    // only when the page opens with ?run=1 (openPanel is the same each time)
  }, [openParameters, hasParameters, pipeline.valid])

  const run = () => {
    if (needsValues) return openPanel()
    start.mutate({ id: pipeline.id, parameters: {} }, { onSuccess: (r) => navigate(`/runs/${r.id}`) })
  }

  const disabledTitle = !pipeline.valid ? "Fix the pipeline's errors to run it" : undefined
  return (
    <>
      <div ref={group} className="inline-flex">
        <Button
          size={size}
          variant={variant}
          onClick={run}
          disabled={!pipeline.valid || start.isPending}
          className="rounded-r-none"
          title={
            disabledTitle ??
            (start.error
              ? `Could not start: ${start.error.message}`
              : needsValues
                ? "Run: asks for the required parameters first"
                : "Run with the default parameters")
          }
        >
          <span className="contents">{start.isPending ? <Loader2 className="animate-spin" /> : <Play />}</span> Run
        </Button>
        <Button
          size={size}
          variant={variant}
          disabled={!pipeline.valid}
          aria-label="More ways to run"
          aria-haspopup="menu"
          aria-expanded={menu}
          title={disabledTitle ?? "More ways to run"}
          className={cn(
            "rounded-l-none px-1.5 has-[>svg]:px-1.5",
            variant === "default" ? "border-primary-foreground/25 border-l" : "-ml-px",
          )}
          onClick={() => {
            place()
            setPanel(false)
            setMenu((m) => !m)
          }}
        >
          <ChevronDown />
        </Button>
      </div>
      {menu && anchor && (
        <RunMenu anchor={anchor} ignore={group.current} onClose={() => setMenu(false)} onParameters={openPanel} />
      )}
      {panel && anchor && (
        <ParametersPanel anchor={anchor} ignore={group.current} onClose={() => setPanel(false)}>
          <RunPipelineForm pipelineId={pipeline.id} parameters={specs} onDone={() => setPanel(false)} />
        </ParametersPanel>
      )}
    </>
  )
}

function RunMenu({
  anchor,
  ignore,
  onClose,
  onParameters,
}: {
  anchor: DOMRect
  ignore: HTMLElement | null
  onClose: () => void
  onParameters: () => void
}) {
  const box = useRef<HTMLDivElement>(null)
  useDismiss(box, onClose, ignore)
  return (
    <div
      ref={box}
      role="menu"
      className="bg-popover text-popover-foreground fixed z-50 min-w-52 rounded-md border p-1 shadow-md"
      style={{ left: Math.max(8, anchor.right - 208), top: anchor.bottom + 4 }}
    >
      <button
        type="button"
        role="menuitem"
        autoFocus
        onClick={onParameters}
        className="hover:bg-accent focus-visible:bg-accent flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm outline-none"
      >
        <SlidersHorizontal className="text-muted-foreground size-4" />
        Run with parameters…
      </button>
    </div>
  )
}

function ParametersPanel({
  anchor,
  ignore,
  onClose,
  children,
}: {
  anchor: DOMRect
  ignore: HTMLElement | null
  onClose: () => void
  children: React.ReactNode
}) {
  const box = useRef<HTMLDivElement>(null)
  useDismiss(box, onClose, ignore)
  const width = Math.min(PANEL_WIDTH, window.innerWidth - 16)
  const left = Math.min(Math.max(8, anchor.right - width), window.innerWidth - width - 8)
  return (
    <div
      ref={box}
      role="dialog"
      aria-label="Run with parameters"
      className="bg-popover text-popover-foreground fixed z-50 overflow-y-auto rounded-md border p-3 shadow-lg"
      style={{ left, top: anchor.bottom + 4, width, maxHeight: `calc(100vh - ${anchor.bottom + 16}px)` }}
    >
      {children}
    </div>
  )
}

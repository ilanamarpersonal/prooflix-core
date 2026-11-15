import { useEffect, useRef, useState } from "react"

import { cn } from "@/lib/utils"

/**
 * A bar that resizes the panel before it: horizontal (default) resizes the panel
 * above, vertical the panel on the left. Drag it, or focus it and use the arrow keys;
 * double-click to reset. `value` is that panel's height (or width) in px; the parent
 * clamps and stores it.
 */
export function ResizeDivider({
  value,
  label,
  onResize,
  onDone,
  onReset,
  step = 24,
  orientation = "horizontal",
  className,
}: {
  value: number
  label: string
  /** while dragging */
  onResize: (height: number) => void
  /** drag released or a key pressed: the parent may save it */
  onDone: (height: number) => void
  onReset: () => void
  step?: number
  /** vertical: a bar between side-by-side panels, resizing the left one */
  orientation?: "horizontal" | "vertical"
  className?: string
}) {
  const [dragging, setDragging] = useState(false)
  const start = useRef<{ at: number; size: number } | null>(null)
  const vertical = orientation === "vertical"
  const pos = (e: { clientX: number; clientY: number }) => (vertical ? e.clientX : e.clientY)

  // while dragging, the page doesn't select text and shows the resize cursor everywhere
  useEffect(() => {
    if (!dragging) return
    const { userSelect, cursor } = document.body.style
    document.body.style.userSelect = "none"
    document.body.style.cursor = vertical ? "col-resize" : "row-resize"
    return () => {
      document.body.style.userSelect = userSelect
      document.body.style.cursor = cursor
    }
  }, [dragging, vertical])

  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-valuenow={Math.round(value)}
      tabIndex={0}
      title={`${label} · drag, or use the arrow keys · double-click to reset`}
      className={cn(
        "group flex shrink-0 touch-none items-center outline-none",
        vertical ? "w-5 cursor-col-resize flex-col justify-center self-stretch" : "h-5 cursor-row-resize",
        className,
      )}
      onPointerDown={(e) => {
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        start.current = { at: pos(e), size: value }
        setDragging(true)
      }}
      onPointerMove={(e) => {
        if (start.current) onResize(start.current.size + pos(e) - start.current.at)
      }}
      onPointerUp={(e) => {
        if (!start.current) return
        onDone(start.current.size + pos(e) - start.current.at)
        start.current = null
        setDragging(false)
      }}
      onPointerCancel={() => {
        start.current = null
        setDragging(false)
      }}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        const [less, more] = vertical ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"]
        if (e.key === less || e.key === more) {
          e.preventDefault()
          onDone(value + (e.key === more ? step : -step))
        }
      }}
    >
      <div
        className={cn(
          "bg-border group-hover:bg-primary/60 group-focus-visible:bg-primary relative transition-colors",
          vertical ? "h-full w-px" : "h-px w-full",
          dragging && "bg-primary",
        )}
      >
        <span
          className={cn(
            "bg-border group-hover:bg-primary/60 group-focus-visible:bg-primary absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors",
            vertical ? "h-12 w-1" : "h-1 w-12",
            dragging && "bg-primary",
          )}
        />
      </div>
    </div>
  )
}

import { useEffect, useRef, useState } from "react"

import { cn } from "@/lib/utils"

/**
 * A horizontal bar that resizes the panel above it. Drag it, or focus it and use the
 * arrow keys; double-click to reset. `value` is the panel's height in px; the parent
 * clamps and stores it.
 */
export function ResizeDivider({
  value,
  label,
  onResize,
  onDone,
  onReset,
  step = 24,
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
  className?: string
}) {
  const [dragging, setDragging] = useState(false)
  const start = useRef<{ y: number; h: number } | null>(null)

  // while dragging, the page doesn't select text and shows the resize cursor everywhere
  useEffect(() => {
    if (!dragging) return
    const { userSelect, cursor } = document.body.style
    document.body.style.userSelect = "none"
    document.body.style.cursor = "row-resize"
    return () => {
      document.body.style.userSelect = userSelect
      document.body.style.cursor = cursor
    }
  }, [dragging])

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label={label}
      aria-valuenow={Math.round(value)}
      tabIndex={0}
      title={`${label} · drag, or use the arrow keys · double-click to reset`}
      className={cn("group flex h-5 shrink-0 cursor-row-resize touch-none items-center outline-none", className)}
      onPointerDown={(e) => {
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        start.current = { y: e.clientY, h: value }
        setDragging(true)
      }}
      onPointerMove={(e) => {
        if (start.current) onResize(start.current.h + e.clientY - start.current.y)
      }}
      onPointerUp={(e) => {
        if (!start.current) return
        onDone(start.current.h + e.clientY - start.current.y)
        start.current = null
        setDragging(false)
      }}
      onPointerCancel={() => {
        start.current = null
        setDragging(false)
      }}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault()
          onDone(value + (e.key === "ArrowDown" ? step : -step))
        }
      }}
    >
      <div
        className={cn(
          "bg-border group-hover:bg-primary/60 group-focus-visible:bg-primary relative h-px w-full transition-colors",
          dragging && "bg-primary",
        )}
      >
        <span
          className={cn(
            "bg-border group-hover:bg-primary/60 group-focus-visible:bg-primary absolute top-1/2 left-1/2 h-1 w-12 -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors",
            dragging && "bg-primary",
          )}
        />
      </div>
    </div>
  )
}

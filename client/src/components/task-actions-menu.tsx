import { useEffect, useRef, useState } from "react"
import { MoreHorizontal, type LucideIcon } from "lucide-react"

import { cn } from "@/lib/utils"

/** One entry of a task's ⋯ menu. */
export interface TaskAction {
  label: string
  icon?: LucideIcon
  onSelect: () => void
}

/**
 * A ⋯ button that opens a task's menu. The menu is fixed-positioned under the
 * button so scrolling containers (like the graph) don't clip it.
 */
export function TaskActionsMenu({
  taskKey,
  actions,
  className,
}: {
  taskKey: string
  actions: TaskAction[]
  className?: string
}) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)

  return (
    <>
      <button
        type="button"
        title={`Open ${taskKey}`}
        aria-label={`Open ${taskKey}`}
        aria-haspopup="menu"
        aria-expanded={!!pos}
        className={cn(
          "text-muted-foreground hover:text-foreground hover:bg-accent grid size-7 shrink-0 place-items-center rounded",
          className,
        )}
        onClick={(ev) => {
          ev.stopPropagation()
          const r = ev.currentTarget.getBoundingClientRect()
          setPos(pos ? null : { x: r.right, y: r.bottom })
        }}
      >
        <MoreHorizontal className="size-4" />
      </button>
      {pos && <Menu x={pos.x} y={pos.y} items={actions} onClose={() => setPos(null)} />}
    </>
  )
}

function Menu({ x, y, items, onClose }: { x: number; y: number; items: TaskAction[]; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !box.current?.contains(e.target as Node)) onClose()
    }
    document.addEventListener("mousedown", close)
    document.addEventListener("keydown", close)
    window.addEventListener("scroll", onClose, true)
    return () => {
      document.removeEventListener("mousedown", close)
      document.removeEventListener("keydown", close)
      window.removeEventListener("scroll", onClose, true)
    }
  }, [onClose])
  return (
    <div
      ref={box}
      role="menu"
      onClick={(e) => e.stopPropagation()}
      className="bg-popover text-popover-foreground fixed z-50 min-w-48 rounded-md border p-1 shadow-md"
      style={{ left: Math.max(8, x - 192), top: y + 4 }}
    >
      {items.map(({ label, icon: Icon, onSelect }) => (
        <button
          key={label}
          type="button"
          role="menuitem"
          onClick={() => {
            onClose()
            onSelect()
          }}
          className="hover:bg-accent flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm"
        >
          {Icon && <Icon className="text-muted-foreground size-4" />}
          {label}
        </button>
      ))}
    </div>
  )
}

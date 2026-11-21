import type { ReactNode } from "react"
import { useLocation } from "react-router"

import { IconTile } from "@/components/icon-tile"
import { sectionFor } from "@/lib/tabs"

export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  eyebrow?: ReactNode
}) {
  // the tab this page belongs to: its coloured tile, as in the menu, goes before the title
  const section = sectionFor(useLocation().pathname)
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        {section && (
          <IconTile icon={section.icon} color={section.color} className="mt-0.5 size-7 rounded-md [&>svg]:size-4" />
        )}
        <div className="min-w-0">
          {eyebrow && <div className="text-muted-foreground mb-1 text-sm">{eyebrow}</div>}
          <h1 className="truncate text-2xl font-semibold tracking-tight">{title}</h1>
          {description && <p className="text-muted-foreground mt-1 text-sm">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
    </div>
  )
}

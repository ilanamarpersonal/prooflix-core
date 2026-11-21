import { cn } from "@/lib/utils"

/**
 * A menu icon on a soft tile of its own colour: the colour at a light tint behind, the icon
 * in the colour itself (a little lighter in dark mode). Without a colour the icon is drawn as
 * it is, for icons that are tiles already (Cloudin's).
 */
export function IconTile({
  icon: Icon,
  color,
  className,
}: {
  icon: (props: { className?: string }) => React.ReactNode
  color?: string
  className?: string
}) {
  if (!color) return <Icon className={cn("size-6 shrink-0", className)} />
  return (
    <span
      style={{ "--tile": color } as React.CSSProperties}
      className={cn(
        "inline-flex size-6 shrink-0 items-center justify-center rounded-md",
        "bg-[color-mix(in_srgb,var(--tile)_15%,transparent)] text-[var(--tile)]",
        "dark:bg-[color-mix(in_srgb,var(--tile)_26%,transparent)] dark:text-[color-mix(in_srgb,var(--tile)_65%,white)]",
        className,
      )}
    >
      <Icon className="size-3.5" />
    </span>
  )
}

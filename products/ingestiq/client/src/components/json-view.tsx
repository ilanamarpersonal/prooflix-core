import { cn } from "@/lib/utils"

export function JsonView({ value, className }: { value: unknown; className?: string }) {
  if (value === null || value === undefined) {
    return <span className="text-muted-foreground text-sm">—</span>
  }
  return (
    <pre
      className={cn(
        "bg-muted max-h-72 max-w-full min-w-0 overflow-auto rounded-md p-3 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap",
        className,
      )}
    >
      {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
    </pre>
  )
}

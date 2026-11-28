import { plainText } from "@/components/task-run-panel"

/** "name: value" lines in plain text (no JSON). */
export function KeyValues({ values, empty = "None" }: { values: Record<string, unknown>; empty?: string }) {
  const entries = Object.entries(values).filter(([, v]) => v !== undefined)
  if (!entries.length) return <p className="text-muted-foreground text-sm">{empty}</p>
  return (
    <dl className="grid gap-1.5 text-sm">
      {entries.map(([k, v]) => (
        <div key={k} className="grid gap-0.5">
          <dt className="text-muted-foreground text-xs">{k}</dt>
          <dd className="break-words whitespace-pre-wrap">{plainText(v) || "—"}</dd>
        </div>
      ))}
    </dl>
  )
}

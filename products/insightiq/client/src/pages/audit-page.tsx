import { useState } from "react"
import { Link } from "react-router"
import { ScrollText } from "lucide-react"

import { ErrorAlert } from "@prooflix/ui/app/error-alert"
import { PageHeader } from "@prooflix/ui/app/page-header"
import { Badge } from "@prooflix/ui/components/ui/badge"
import { Card, CardContent } from "@prooflix/ui/components/ui/card"
import { Input } from "@prooflix/ui/components/ui/input"
import { Skeleton } from "@prooflix/ui/components/ui/skeleton"
import { useDebounced } from "@/components/ontology-ui"
import { useAudit } from "@/lib/api"
import { cn, formatDateTime } from "@/lib/utils"

const EVENTS: Record<string, { label: string; tone: string }> = {
  publish: { label: "Published", tone: "bg-status-succeeded/15 text-status-succeeded" },
  unpublish: { label: "Unpublished", tone: "bg-status-failed/15 text-status-failed" },
  action: { label: "Action", tone: "bg-violet-500/15 text-violet-700 dark:text-violet-300" },
  read_sensitive: { label: "Sensitive read", tone: "bg-status-cancelled/15 text-status-cancelled" },
  view_as: { label: "View as user", tone: "bg-status-running/15 text-status-running" },
}

/** The object model's audit log: publishing, actions, sensitive reads and "view as user" (admins only). */
export function AuditPage() {
  const [event, setEvent] = useState("")
  const [type, setType] = useState("")
  const [user, setUser] = useState("")
  const params = useDebounced({ event, type, user }, 300)
  const audit = useAudit(params)
  return (
    <div>
      <PageHeader
        eyebrow={
          <Link to="/ontology" className="hover:underline">
            Object Model
          </Link>
        }
        title="Audit log"
        description="Who published types, ran actions, read sensitive properties or viewed a type as another user. Kept in the object model's database."
      />
      <div className="mb-4 flex flex-wrap gap-2">
        <select
          className="border-input bg-background h-9 rounded-md border px-2 text-sm"
          value={event}
          onChange={(e) => setEvent(e.target.value)}
        >
          <option value="">Every event</option>
          {Object.entries(EVENTS).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
        </select>
        <Input className="w-48" placeholder="Object type" value={type} onChange={(e) => setType(e.target.value)} />
        <Input className="w-48" placeholder="User" value={user} onChange={(e) => setUser(e.target.value)} />
      </div>
      {audit.error && <ErrorAlert title="The audit log can't be read" error={audit.error} />}
      {audit.isLoading ? (
        <Skeleton className="h-64" />
      ) : audit.data?.length === 0 ? (
        <Card>
          <CardContent className="text-muted-foreground grid justify-items-center gap-2 py-12 text-sm">
            <ScrollText className="size-8" /> Nothing recorded yet.
          </CardContent>
        </Card>
      ) : (
        audit.data && (
          <Card>
            <CardContent className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-muted-foreground text-left text-xs">
                  <tr>
                    <th className="pr-3 pb-2 font-medium">When</th>
                    <th className="pr-3 pb-2 font-medium">Who</th>
                    <th className="pr-3 pb-2 font-medium">Event</th>
                    <th className="pr-3 pb-2 font-medium">Object</th>
                    <th className="pr-3 pb-2 font-medium">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.data.map((e) => {
                    const ev = EVENTS[e.event] ?? { label: e.event, tone: "bg-muted" }
                    return (
                      <tr key={e.id} className="border-t align-top">
                        <td className="py-2 pr-3 whitespace-nowrap">{formatDateTime(e.at)}</td>
                        <td className="py-2 pr-3">{e.user ?? "—"}</td>
                        <td className="py-2 pr-3">
                          <Badge className={cn("border-transparent", ev.tone)}>{ev.label}</Badge>
                        </td>
                        <td className="py-2 pr-3">
                          {e.type ? (
                            e.pk ? (
                              <Link
                                className="text-violet-700 hover:underline dark:text-violet-300"
                                to={`/objects/${e.type}/${encodeURIComponent(e.pk)}`}
                              >
                                {e.type}:{e.pk}
                              </Link>
                            ) : (
                              e.type
                            )
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="text-muted-foreground py-2 font-mono text-xs break-all">
                          {Object.entries(e.detail)
                            .filter(([, v]) => v !== null && v !== "")
                            .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
                            .join(" · ") || "—"}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </CardContent>
          </Card>
        )
      )}
    </div>
  )
}

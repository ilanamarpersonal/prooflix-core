import { useState } from "react"
import { Link } from "react-router"
import { useQueryClient } from "@tanstack/react-query"
import { Check, Inbox, Wrench, X } from "lucide-react"

import { ErrorAlert } from "@prooflix/ui/app/error-alert"
import { PageHeader } from "@prooflix/ui/app/page-header"
import { Badge } from "@prooflix/ui/components/ui/badge"
import { Button } from "@prooflix/ui/components/ui/button"
import { Card, CardContent } from "@prooflix/ui/components/ui/card"
import { Skeleton } from "@prooflix/ui/components/ui/skeleton"
import { api, useProposals } from "@/lib/api"
import type { Proposal } from "@/lib/types"
import { formatDateTime } from "@/lib/utils"
import { ObjectsNav } from "@/pages/sets-page"

/** "mcp:Claude Code" → "Claude Code" (the token's name) */
const sourceName = (s: string) => (s.startsWith("mcp:") ? s.slice(4) : s === "mcp" ? "an AI app" : s)

/** Actions AI apps proposed over MCP: the user applies them here (as themselves) or dismisses them. */
export function ProposalsPage() {
  const proposals = useProposals()
  const qc = useQueryClient()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<unknown>(null)
  const list = proposals.data?.proposals ?? []
  const pending = list.filter((p) => p.state === "pending")
  const decided = list.filter((p) => p.state !== "pending")

  const decide = async (p: Proposal, how: "apply" | "dismiss") => {
    setBusy(`${p.id}:${how}`)
    setError(null)
    try {
      await (how === "apply" ? api.applyProposal(p.id) : api.dismissProposal(p.id))
      if (how === "apply") void qc.invalidateQueries({ queryKey: ["ontology", "objects"] })
    } catch (e) {
      setError(e)
    } finally {
      setBusy(null)
      void qc.invalidateQueries({ queryKey: ["ontology", "proposals"] })
    }
  }

  const card = (p: Proposal) => (
    <Card key={p.id} className="gap-2 px-4 py-3" aria-label={`Proposal ${p.label} on ${p.type} ${p.key}`}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Wrench className="text-muted-foreground size-4" />
        <span className="font-medium">{p.label}</span>
        <span className="text-muted-foreground">on {p.type}</span>
        <Link
          to={`/objects/${encodeURIComponent(p.type)}/${encodeURIComponent(p.key)}`}
          className="text-primary font-medium hover:underline"
        >
          {p.title ?? p.key}
        </Link>
        <span className="flex-1" />
        {p.state !== "pending" && <Badge variant={p.state === "applied" ? "secondary" : "outline"}>{p.state}</Badge>}
      </div>
      <ul className="text-sm">
        {Object.entries(p.values).map(([k, v]) => (
          <li key={k}>
            <span className="text-muted-foreground">{k}</span> → {String(v ?? "")}
          </li>
        ))}
      </ul>
      {p.reason && <p className="text-muted-foreground text-sm">“{p.reason}”</p>}
      <p className="text-muted-foreground text-xs">
        Proposed by {sourceName(p.source)} · {formatDateTime(p.created)}
        {p.decided_at && ` · ${p.state} ${formatDateTime(p.decided_at)}`}
      </p>
      {p.state === "pending" && (
        <div className="flex gap-2">
          <Button size="sm" loading={busy === `${p.id}:apply`} disabled={!!busy} onClick={() => decide(p, "apply")}>
            <Check /> Apply
          </Button>
          <Button
            size="sm"
            variant="ghost"
            loading={busy === `${p.id}:dismiss`}
            disabled={!!busy}
            onClick={() => decide(p, "dismiss")}
          >
            <X /> Dismiss
          </Button>
        </div>
      )}
    </Card>
  )

  return (
    <div>
      <PageHeader
        title="Proposals"
        description="Actions AI apps connected to Prooflix proposed for you. Nothing changed yet: Apply runs the action as you (checked again now), Dismiss drops it. Kept 7 days."
        actions={<ObjectsNav active="proposals" />}
      />
      {proposals.error && <ErrorAlert title="The proposals can't be read" error={proposals.error} />}
      {proposals.data?.error && <ErrorAlert title="The object model's database" error={proposals.data.error} />}
      {!!error && <ErrorAlert title="The proposal wasn't applied" error={error} />}
      {proposals.isPending ? (
        <Skeleton className="h-40" />
      ) : proposals.data && !proposals.data.available && !proposals.data.error ? (
        <Card>
          <CardContent className="text-muted-foreground py-10 text-center text-sm">
            Proposals need the object model's database (PROOFLIX_DATABASE_URL in Settings & Management → System).
          </CardContent>
        </Card>
      ) : (
        <div className="grid max-w-3xl gap-6">
          <section className="grid gap-3">
            <h2 className="text-sm font-semibold">Waiting for you ({pending.length})</h2>
            {pending.length ? (
              pending.map(card)
            ) : (
              <Card>
                <CardContent className="text-muted-foreground grid justify-items-center gap-2 py-10 text-center text-sm">
                  <Inbox className="size-6" />
                  No proposals waiting. When an AI app you connected proposes an action, it shows here.
                  <Link to="/objects/connect" className="text-primary hover:underline">
                    Connect an AI app
                  </Link>
                </CardContent>
              </Card>
            )}
          </section>
          {decided.length > 0 && (
            <section className="grid gap-3">
              <h2 className="text-muted-foreground text-sm font-semibold">Decided</h2>
              {decided.map(card)}
            </section>
          )}
        </div>
      )}
    </div>
  )
}

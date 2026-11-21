import { useEffect, useState } from "react"
import { Link } from "react-router"
import { AlertTriangle, CheckCircle2, ClipboardPaste, Loader2, Play, RotateCcw, X } from "lucide-react"

import { CloudinIcon } from "@/components/cloudin-icon"
import { ErrorAlert } from "@/components/error-alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { useCloudinSqlFix } from "@/lib/api"
import { cn } from "@/lib/utils"

/** A query that failed in the SQL editor, for Cloudin to look at */
export interface SqlFailure {
  /** changes for every failure, so the panel starts over */
  id: number
  tabId: string
  sql: string
  error: string
}

/**
 * Cloudin's panel on the right of the SQL editor. It opens when a query fails and asks
 * first. Only when the user agrees is the query sent to Claude, which explains the
 * error and suggests a corrected query. The user can then run it or put it in the editor.
 */
export function CloudinSqlPanel({
  failure,
  ready,
  canSetUp,
  fixRan,
  onRun,
  onPaste,
  onClose,
}: {
  failure: SqlFailure
  /** Cloudin has an account and is on */
  ready: boolean
  /** the user is an admin, who can set Cloudin up */
  canSetUp: boolean
  /** the suggested query ran without an error */
  fixRan: boolean
  onRun: (sql: string) => void
  onPaste: (sql: string) => void
  onClose: () => void
}) {
  const fix = useCloudinSqlFix()
  const [asked, setAsked] = useState(false)
  // a new failure starts over
  useEffect(() => {
    setAsked(false)
    fix.reset()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failure.id])

  const ask = () => {
    setAsked(true)
    fix.mutate({ sql: failure.sql, error: failure.error })
  }
  const answer = fix.data

  return (
    // on wide screens a column next to the editor; on narrower ones it slides over from the right
    <div className="fixed inset-y-0 right-0 z-40 w-full max-w-sm p-3 xl:static xl:z-auto xl:max-w-none xl:p-0 xl:pl-4">
      <Card
        aria-label="Cloudin"
        className="flex h-full min-h-0 flex-col gap-0 overflow-hidden py-0 shadow-xl xl:shadow-none"
        data-cloudin-panel
      >
        <div className="flex items-center gap-2 border-b px-3 py-2.5">
          <CloudinIcon className="size-5" />
          <span className="flex-1 text-sm font-semibold">Cloudin</span>
          <Button variant="ghost" size="icon" className="size-7" onClick={onClose} aria-label="Close Cloudin">
            <X />
          </Button>
        </div>

        <div className="grid min-h-0 flex-1 content-start gap-4 overflow-auto p-3 text-sm">
          {!ready ? (
            <div className="grid gap-2">
              <p>The query failed. Cloudin can explain the error and suggest a fix, but it isn't set up yet.</p>
              {canSetUp ? (
                <Button asChild size="sm" className="justify-self-start">
                  <Link to="/cloudin">
                    <CloudinIcon /> Set up Cloudin
                  </Link>
                </Button>
              ) : (
                <p className="text-muted-foreground text-xs">
                  Ask an admin to add a Claude account in the Cloudin tab.
                </p>
              )}
            </div>
          ) : !asked ? (
            <div className="grid gap-3">
              <p>The query failed. Do you want Cloudin to look at it and suggest a fix?</p>
              <p className="text-muted-foreground text-xs">
                Cloudin sends the query, the error and the catalog's table and column names to Claude. No data rows are
                sent.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={ask}>
                  <CloudinIcon /> Yes, look at it
                </Button>
                <Button size="sm" variant="ghost" onClick={onClose}>
                  Not now
                </Button>
              </div>
            </div>
          ) : fix.isPending ? (
            <div className="text-muted-foreground flex items-center gap-2">
              <Loader2 className="size-4 animate-spin" /> Cloudin is looking at the query and the catalog…
            </div>
          ) : fix.error ? (
            <div className="grid gap-3">
              <ErrorAlert title="Cloudin couldn't answer" error={fix.error} />
              <Button size="sm" variant="outline" className="justify-self-start" onClick={ask}>
                <RotateCcw /> Try again
              </Button>
            </div>
          ) : answer ? (
            <div className="grid gap-4">
              <section className="grid gap-1">
                <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">What went wrong</h3>
                <p className="whitespace-pre-wrap">{answer.diagnosis}</p>
              </section>

              {answer.fixed_sql ? (
                <>
                  <section className="grid gap-1">
                    <div className="flex items-center gap-2">
                      <h3 className="text-muted-foreground flex-1 text-xs font-medium tracking-wide uppercase">
                        Suggested fix
                      </h3>
                      <Badge
                        variant="outline"
                        className={cn(
                          answer.confidence === "high" &&
                            "border-emerald-500/50 text-emerald-700 dark:text-emerald-400",
                          answer.confidence === "low" && "border-amber-500/50 text-amber-700 dark:text-amber-400",
                        )}
                      >
                        {answer.confidence} confidence
                      </Badge>
                    </div>
                    {answer.explanation && <p className="whitespace-pre-wrap">{answer.explanation}</p>}
                    <pre className="bg-muted mt-1 max-h-72 overflow-auto rounded-md p-2.5 font-mono text-xs leading-relaxed whitespace-pre">
                      {answer.fixed_sql}
                    </pre>
                  </section>

                  {!answer.runnable && answer.problem && (
                    <p className="flex gap-2 text-amber-700 dark:text-amber-400">
                      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                      The suggestion can't run in the SQL editor: {answer.problem}. You can still put it in the editor
                      and change it.
                    </p>
                  )}

                  {fixRan ? (
                    <p className="flex items-center gap-2 text-emerald-700 dark:text-emerald-400">
                      <CheckCircle2 className="size-4" /> The fix ran; its results are on the left.
                    </p>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" onClick={() => onRun(answer.fixed_sql)} disabled={!answer.runnable}>
                        <Play /> Run the fix
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => onPaste(answer.fixed_sql)}>
                        <ClipboardPaste /> Put in the editor
                      </Button>
                    </div>
                  )}
                </>
              ) : (
                <p className="text-muted-foreground">Cloudin has no fix to suggest for this one.</p>
              )}

              <p className="text-muted-foreground text-xs">
                Suggested by {answer.model}. Check the query before you rely on its results.
              </p>
            </div>
          ) : null}
        </div>
      </Card>
    </div>
  )
}

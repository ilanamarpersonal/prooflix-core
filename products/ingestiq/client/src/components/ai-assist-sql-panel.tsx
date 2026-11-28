import { useEffect, useState } from "react"
import { AlertTriangle, CheckCircle2, ClipboardPaste, Loader2, Play, RotateCcw } from "lucide-react"

import { productHref } from "@prooflix/ui/lib/products"
import { AiAssistHeader } from "@prooflix/ui/ai-assist/dock"
import { AiAssistIcon } from "@prooflix/ui/ai-assist/icon"
import { ErrorAlert } from "@prooflix/ui/app/error-alert"
import { Badge } from "@prooflix/ui/components/ui/badge"
import { Button } from "@prooflix/ui/components/ui/button"
import { Card } from "@prooflix/ui/components/ui/card"
import { useAiAssistSqlFix } from "@/lib/api"
import { cn } from "@/lib/utils"

/** A query that failed in the SQL editor, for AI Assist to look at */
export interface SqlFailure {
  /** changes for every failure, so the panel starts over */
  id: number
  tabId: string
  sql: string
  error: string
}

/**
 * AI Assist's panel on the right of the SQL editor. The user shows or hides it (hidden by
 * default). When a query fails it offers to look at it and asks first. Only when the user agrees is the query sent to Claude, which explains the
 * error and suggests a corrected query. The user can then run it or put it in the editor.
 */
export function AiAssistSqlPanel({
  failure,
  ready,
  canSetUp,
  fixRan,
  onRun,
  onPaste,
  onDismiss,
  onClose,
}: {
  /** the last failed query of the open tab, if any */
  failure: SqlFailure | null
  /** AI Assist has an account and is on */
  ready: boolean
  /** the user is an admin, who can set AI Assist up */
  canSetUp: boolean
  /** the suggested query ran without an error */
  fixRan: boolean
  onRun: (sql: string) => void
  onPaste: (sql: string) => void
  /** forget the failed query ("Not now") */
  onDismiss: () => void
  /** hide the panel */
  onClose: () => void
}) {
  const fix = useAiAssistSqlFix()
  const [asked, setAsked] = useState(false)
  // a new failure starts over
  useEffect(() => {
    setAsked(false)
    fix.reset()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failure?.id])

  const ask = () => {
    if (!failure) return
    setAsked(true)
    fix.mutate({ sql: failure.sql, error: failure.error })
  }
  const answer = fix.data

  return (
    // shown in the AI Assist panel on the right of the screen (AiAssistSlot)
    <div className="flex flex-1 flex-col">
      <Card
        aria-label="AI Assist"
        className="flex flex-[1_0_auto] flex-col gap-0 overflow-hidden py-0"
        data-ai-assist-panel
      >
        <AiAssistHeader onClose={onClose} />

        <div className="grid min-h-0 flex-1 content-start gap-4 overflow-auto p-3 text-sm">
          {!ready ? (
            <div className="grid gap-2">
              <p>
                {failure ? "The query failed. " : "When a query fails, "}AI Assist can explain the error and suggest a
                fix, but it isn't set up yet.
              </p>
              {canSetUp ? (
                <Button asChild size="sm" className="justify-self-start">
                  <a href={productHref("settings", "/ai-assist")}>
                    <AiAssistIcon /> Set up AI Assist
                  </a>
                </Button>
              ) : (
                <p className="text-muted-foreground text-xs">
                  Ask an admin to add a Claude account in Settings & Management (AI Assist).
                </p>
              )}
            </div>
          ) : !failure ? (
            <div className="text-muted-foreground grid gap-2">
              <p>When a query fails, AI Assist can explain the error and suggest a fix you can run.</p>
              <p className="text-xs">Nothing is sent to Claude until you ask.</p>
            </div>
          ) : !asked ? (
            <div className="grid gap-3">
              <p>The query failed. Do you want AI Assist to look at it and suggest a fix?</p>
              <p className="text-muted-foreground text-xs">
                AI Assist sends the query, the error and the catalog's table and column names to Claude. No data rows
                are sent.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={ask}>
                  <AiAssistIcon /> Yes, look at it
                </Button>
                <Button size="sm" variant="ghost" onClick={onDismiss}>
                  Not now
                </Button>
              </div>
            </div>
          ) : fix.isPending ? (
            <div className="text-muted-foreground flex items-center gap-2">
              <Loader2 className="size-4 animate-spin" /> AI Assist is looking at the query and the catalog…
            </div>
          ) : fix.error ? (
            <div className="grid gap-3">
              <ErrorAlert title="AI Assist couldn't answer" error={fix.error} assist={false} />
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
                <p className="text-muted-foreground">AI Assist has no fix to suggest for this one.</p>
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

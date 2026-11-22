import { useEffect, useRef, useState } from "react"
import { Link } from "react-router"
import { Check, ChevronRight, FileCode2, Loader2, RotateCcw, SendHorizontal, Wrench } from "lucide-react"

import { AiAssistIcon } from "@/components/ai-assist-icon"
import { ErrorAlert } from "@/components/error-alert"
import { FileDiff } from "@/components/file-diff"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Textarea } from "@/components/ui/textarea"
import {
  useAiAssistRunAsk,
  useAiAssistRunFix,
  useAiAssistRunHelp,
  useAuthStatus,
  useSaveWorkspaceFile,
} from "@/lib/api"
import type { AiAssistRunFix, AiAssistRunTurn } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * AI Assist on a failed run's page. It asks first; only when the user agrees are the run, its
 * tasks' errors and the last lines they printed (values that look like secrets masked) sent to
 * Claude, which says what went wrong and how to fix it. Then the user can ask follow-up questions
 * (the run is sent again with the conversation so far). Nothing is changed or re-run.
 * Remount it (key) for another run.
 */
export function AiAssistRunPanel({
  runId,
  ready,
  canSetUp,
  onClose,
}: {
  runId: string
  /** AI Assist has an account and is on */
  ready: boolean
  /** the user is an admin, who can set AI Assist up */
  canSetUp: boolean
  /** hide the panel */
  onClose: () => void
}) {
  const help = useAiAssistRunHelp()
  const [asked, setAsked] = useState(false)
  const [turns, setTurns] = useState<AiAssistRunTurn[]>([])
  const ask = () => {
    setAsked(true)
    help.mutate(runId) // questions already asked stay
  }
  const answer = help.data
  // "Let AI Assist fix it": changes to the run's workspace files, saved only when the user applies them
  const auth = useAuthStatus().data
  const canFix = !auth?.enabled || auth.user?.role === "admin" || !!auth.user?.visible_tabs.includes("workspace")
  const fix = useAiAssistRunFix()
  const save = useSaveWorkspaceFile()
  const [applied, setApplied] = useState<string[] | null>(null)
  const [applyError, setApplyError] = useState<unknown>(null)
  const proposeFix = () => {
    setApplied(null)
    setApplyError(null)
    fix.mutate({ runId, explanation: answer ?? null })
  }
  const applyFix = async () => {
    if (!fix.data) return
    setApplyError(null)
    const done: string[] = []
    try {
      for (const c of fix.data.changes) {
        await save.mutateAsync({ path: c.path, content: c.after, modified: c.modified })
        done.push(c.path)
      }
      setApplied(done)
    } catch (e) {
      setApplied(done.length ? done : null)
      setApplyError(e)
    }
  }
  const followUp = useAiAssistRunAsk()
  const [question, setQuestion] = useState("")
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (turns.length || followUp.isPending) end.current?.scrollIntoView({ block: "nearest", behavior: "smooth" })
  }, [turns.length, followUp.isPending])
  const busy = help.isPending || followUp.isPending
  const send = () => {
    const q = question.trim()
    if (!q || busy) return
    followUp.mutate(
      { runId, question: q, explanation: answer ?? null, turns },
      {
        onSuccess: (r) => {
          setTurns((t) => [...t, { question: q, answer: r.answer }])
          setQuestion("")
        },
      },
    )
  }

  return (
    <Card aria-label="AI Assist" className="flex-[1_0_auto] gap-0 overflow-hidden py-0" data-ai-assist-panel>
      <div className="flex items-center gap-2 border-b px-3 py-2.5">
        <AiAssistIcon className="size-5" />
        <span className="flex-1 text-sm font-semibold">AI Assist</span>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={onClose}
          aria-label="Hide AI Assist"
          title="Hide AI Assist"
        >
          <ChevronRight />
        </Button>
      </div>

      {/* the question box sits at the bottom of the panel */}
      <div className="flex flex-1 flex-col gap-4 p-3 text-sm">
        {!ready ? (
          <div className="grid gap-2">
            <p>The run failed. AI Assist can explain why and how to fix it, but it isn't set up yet.</p>
            {canSetUp ? (
              <Button asChild size="sm" className="justify-self-start">
                <Link to="/ai-assist">
                  <AiAssistIcon /> Set up AI Assist
                </Link>
              </Button>
            ) : (
              <p className="text-muted-foreground text-xs">
                Ask an admin to add a Claude account in the AI Assist tab.
              </p>
            )}
          </div>
        ) : !asked ? (
          <div className="grid gap-3">
            <p>The run failed. Do you want AI Assist to find out why and suggest how to fix it?</p>
            <p className="text-muted-foreground text-xs">
              AI Assist sends the run, its parameters, each task's error and the last lines it printed to Claude, with
              values that look like passwords or keys masked. No table data is sent. Asking a question below sends the
              same.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={ask}>
                <AiAssistIcon /> Yes, look at it
              </Button>
              <Button size="sm" variant="ghost" onClick={onClose}>
                Not now
              </Button>
            </div>
          </div>
        ) : help.isPending ? (
          <div className="text-muted-foreground flex items-center gap-2">
            <Loader2 className="size-4 animate-spin" /> AI Assist is looking at the run…
          </div>
        ) : help.error ? (
          <div className="grid gap-3">
            <ErrorAlert title="AI Assist couldn't answer" error={help.error} assist={false} />
            <Button size="sm" variant="outline" className="justify-self-start" onClick={ask}>
              <RotateCcw /> Try again
            </Button>
          </div>
        ) : answer ? (
          <div className="grid gap-4">
            <section className="grid gap-1">
              <div className="flex items-center gap-2">
                <h3 className="text-muted-foreground flex-1 text-xs font-medium tracking-wide uppercase">
                  What went wrong
                </h3>
                <Badge
                  variant="outline"
                  className={cn(
                    answer.confidence === "high" && "border-emerald-500/50 text-emerald-700 dark:text-emerald-400",
                    answer.confidence === "low" && "border-amber-500/50 text-amber-700 dark:text-amber-400",
                  )}
                >
                  {answer.confidence} confidence
                </Badge>
              </div>
              <p className="whitespace-pre-wrap">{answer.diagnosis}</p>
              {answer.failed_task && (
                <p className="text-muted-foreground text-xs">
                  Started in <span className="font-mono">{answer.failed_task}</span>
                </p>
              )}
            </section>

            {answer.steps.length > 0 && (
              <section className="grid gap-1">
                <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">How to fix it</h3>
                <ol className="grid list-decimal gap-1.5 pl-5">
                  {answer.steps.map((step, i) => (
                    <li key={i} className="whitespace-pre-wrap">
                      {step}
                    </li>
                  ))}
                </ol>
              </section>
            )}

            <p className="text-muted-foreground text-xs">
              Suggested by {answer.model}. Check the steps before you act on them, then use Run again.
            </p>

            {canFix && (
              <section className="grid gap-3 border-t pt-3" aria-label="Fix with AI Assist">
                {!fix.data && !fix.isPending && (
                  <>
                    <p>Do you want AI Assist to fix it?</p>
                    <p className="text-muted-foreground text-xs">
                      It proposes changes to this run's pipeline files (their YAML and the Python their tasks call) and
                      sends those files to Claude. You see every change first; nothing is saved until you apply it.
                    </p>
                    <Button size="sm" className="justify-self-start" onClick={proposeFix}>
                      <Wrench /> Fix it
                    </Button>
                  </>
                )}
                {fix.isPending && (
                  <p className="text-muted-foreground flex items-center gap-2">
                    <Loader2 className="size-4 animate-spin" /> AI Assist is preparing a fix…
                  </p>
                )}
                {fix.error && (
                  <div className="grid gap-2">
                    <ErrorAlert title="AI Assist couldn't propose a fix" error={fix.error} assist={false} />
                    <Button size="sm" variant="outline" className="justify-self-start" onClick={proposeFix}>
                      <RotateCcw /> Try again
                    </Button>
                  </div>
                )}
                {fix.data && <FixProposal fix={fix.data} applied={applied} />}
                {fix.data && fix.data.changes.length > 0 && !applied?.length && (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      onClick={() => void applyFix()}
                      disabled={save.isPending || fix.data.changes.some((c) => c.problems.length > 0)}
                    >
                      {save.isPending ? <Loader2 className="animate-spin" /> : <Check />} Apply changes
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => fix.reset()} disabled={save.isPending}>
                      Discard
                    </Button>
                  </div>
                )}
                {applyError != null && (
                  <ErrorAlert title="Could not save the changes" error={applyError} assist={false} />
                )}
                {applied && applied.length > 0 && (
                  <p className="flex items-start gap-2 text-emerald-700 dark:text-emerald-400">
                    <Check className="mt-0.5 size-4 shrink-0" />
                    Saved {applied.length} file{applied.length === 1 ? "" : "s"}. Use Run again to check the fix.
                  </p>
                )}
              </section>
            )}
          </div>
        ) : null}

        {/* always there once AI Assist is set up: the questions so far and a box for the next one */}
        {ready && (
          <>
            {(turns.length > 0 || followUp.isPending) && (
              <section className="grid gap-3 border-t pt-3" aria-label="Follow-up questions">
                {turns.map((t, i) => (
                  <div key={i} className="grid gap-2">
                    <p className="bg-muted justify-self-end rounded-lg px-2.5 py-1.5 whitespace-pre-wrap">
                      {t.question}
                    </p>
                    <p className="whitespace-pre-wrap">{t.answer}</p>
                  </div>
                ))}
                {followUp.isPending && (
                  <div className="grid gap-2">
                    <p className="bg-muted justify-self-end rounded-lg px-2.5 py-1.5 whitespace-pre-wrap">
                      {followUp.variables?.question}
                    </p>
                    <p className="text-muted-foreground flex items-center gap-2">
                      <Loader2 className="size-4 animate-spin" /> AI Assist is thinking…
                    </p>
                  </div>
                )}
              </section>
            )}
            {followUp.error && <ErrorAlert title="AI Assist couldn't answer" error={followUp.error} assist={false} />}
            <div ref={end} />

            <form
              className="mt-auto grid gap-2 border-t pt-3"
              onSubmit={(e) => {
                e.preventDefault()
                send()
              }}
            >
              <Textarea
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  // Enter sends; Shift+Enter starts a new line
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    send()
                  }
                }}
                placeholder={answer || turns.length ? "Ask a follow-up question…" : "Ask about this run…"}
                aria-label="Ask AI Assist about this run"
                maxLength={2000}
                rows={2}
                disabled={busy}
                className="min-h-16 resize-none text-sm"
              />
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground flex-1 text-xs">Enter to send · Shift+Enter for a new line</span>
                <Button type="submit" size="sm" disabled={!question.trim() || busy}>
                  <SendHorizontal /> Ask
                </Button>
              </div>
            </form>
          </>
        )}
      </div>
    </Card>
  )
}

/** The changes AI Assist proposes: its summary, then each file's reason, problems and diff. */
function FixProposal({ fix, applied }: { fix: AiAssistRunFix; applied: string[] | null }) {
  return (
    <div className="grid gap-3">
      <p className="whitespace-pre-wrap">{fix.summary}</p>
      {fix.changes.length === 0 ? (
        <p className="text-muted-foreground text-xs">No file change can fix this; follow the steps above.</p>
      ) : (
        fix.changes.map((c) => (
          <div key={c.path} className="grid gap-1.5">
            <p className="flex items-center gap-1.5 font-mono text-xs font-medium">
              <FileCode2 className="text-muted-foreground size-3.5 shrink-0" />
              <span className="truncate">{c.path}</span>
              {applied?.includes(c.path) && <Check className="size-3.5 shrink-0 text-emerald-600" />}
            </p>
            {c.reason && <p className="text-muted-foreground text-xs">{c.reason}</p>}
            {c.problems.length > 0 && (
              <ul className="text-destructive list-disc pl-4 text-xs">
                {c.problems.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            )}
            <FileDiff before={c.before} after={c.after} />
          </div>
        ))
      )}
      {fix.changes.some((c) => c.problems.length > 0) && (
        <p className="text-destructive text-xs">A change doesn't pass the pipeline checks, so it can't be applied.</p>
      )}
      <p className="text-muted-foreground text-xs">Proposed by {fix.model}. Read the changes before you apply them.</p>
    </div>
  )
}

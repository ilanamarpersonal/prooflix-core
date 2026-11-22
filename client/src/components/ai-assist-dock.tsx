import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { Link, useLocation } from "react-router"
import { AlertCircle, ChevronRight, Loader2, SendHorizontal } from "lucide-react"

import { AiAssistIcon } from "@/components/ai-assist-icon"
import { ErrorAlert } from "@/components/error-alert"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Textarea } from "@/components/ui/textarea"
import { useAiAssistAsk, useAiAssistStatus, useAuthStatus } from "@/lib/api"
import { sectionFor } from "@/lib/tabs"
import type { AiAssistRunTurn } from "@/lib/types"
import { cn } from "@/lib/utils"

/** An error a screen shows (an ErrorAlert), offered to AI Assist. */
export interface ScreenError {
  title: string
  messages: string[]
}

interface Dock {
  /** AI Assist can be offered here: it is set up, or the user is an admin who can set it up */
  available: boolean
  ready: boolean
  canSetUp: boolean
  open: boolean
  setOpen: (open: boolean) => void
  /** open the panel because something failed (only when AI Assist can answer or be set up) */
  popUp: () => void
  /** an error shown on the screen: opens the panel once with an offer to explain it */
  reportError: (error: ScreenError) => void
  /** where a screen's own panel (SQL editor, failed run) goes instead of the general one */
  slot: HTMLElement | null
  claimSlot: () => () => void
  // for the panel and the top bar button
  error: ScreenError | null
  dismissError: () => void
  claims: number
  setSlot: (el: HTMLElement | null) => void
}

const NOOP_DOCK: Dock = {
  available: false,
  ready: false,
  canSetUp: false,
  open: false,
  setOpen: () => {},
  popUp: () => {},
  reportError: () => {},
  slot: null,
  claimSlot: () => () => {},
  error: null,
  dismissError: () => {},
  claims: 0,
  setSlot: () => {},
}

const DockContext = createContext<Dock>(NOOP_DOCK)

/** The AI Assist panel on the right of every screen (outside the app shell, a no-op). */
export const useAiAssistDock = () => useContext(DockContext)

const errorKey = (e: ScreenError) => `${e.title}\n${e.messages.join("\n")}`

/**
 * AI Assist on every screen: hidden until the user opens it with the button at the top right, and
 * opened by itself when something fails (a failed run, a failed query, an error a screen shows). A screen
 * with its own AI Assist panel puts it here with AiAssistSlot; elsewhere it is a chat about Prooflix
 * and the current screen.
 */
export function AiAssistDockProvider({ children }: { children: React.ReactNode }) {
  const status = useAiAssistStatus()
  const auth = useAuthStatus()
  const location = useLocation()
  const canSetUp = auth.data ? !auth.data.enabled || auth.data.user?.role === "admin" : false
  const ready = !!status.data?.ready
  const available = ready || (canSetUp && status.data?.enabled !== false && !!status.data)
  const [open, setOpen] = useState(false)
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  const [claims, setClaims] = useState(0)
  const [error, setError] = useState<ScreenError | null>(null)
  const seen = useRef(new Set<string>()) // errors already offered on this screen

  // a new screen starts without the last one's error
  useEffect(() => {
    setError(null)
    seen.current = new Set()
  }, [location.pathname])

  const popUp = useCallback(() => {
    if (available) setOpen(true)
  }, [available])
  const reportError = useCallback(
    (e: ScreenError) => {
      const key = errorKey(e)
      if (seen.current.has(key)) return
      seen.current.add(key)
      setError(e)
      if (ready) setOpen(true) // pops up only when it can answer
    },
    [ready],
  )
  const claimSlot = useCallback(() => {
    setClaims((n) => n + 1)
    return () => setClaims((n) => n - 1)
  }, [])

  const dismissError = useCallback(() => setError(null), [])
  const dock = useMemo<Dock>(
    () => ({
      available,
      ready,
      canSetUp,
      open,
      setOpen,
      popUp,
      reportError,
      slot,
      claimSlot,
      error,
      dismissError,
      claims,
      setSlot,
    }),
    [available, ready, canSetUp, open, popUp, reportError, slot, claimSlot, error, dismissError, claims],
  )
  return <DockContext.Provider value={dock}>{children}</DockContext.Provider>
}

/** The button at the top right of every screen that shows or hides AI Assist; a red dot when the screen shows an error. */
export function AiAssistToggle() {
  const { available, open, setOpen, error } = useAiAssistDock()
  if (!available) return null
  return (
    <Button
      variant={open ? "secondary" : "outline"}
      size="sm"
      onClick={() => setOpen(!open)}
      aria-pressed={open}
      aria-label={open ? "Hide AI Assist" : "Show AI Assist"}
      title={open ? "Hide AI Assist" : "Show AI Assist"}
      className="relative"
    >
      <AiAssistIcon className="size-4" />
      <span className="max-sm:hidden">AI Assist</span>
      {error && !open && (
        <span
          aria-label="this screen shows an error"
          className="bg-destructive ring-background absolute -top-1 -right-1 size-2.5 rounded-full ring-2"
        />
      )}
    </Button>
  )
}

/** The AI Assist panel itself, on the right of the page (placed next to the page in the app shell). */
export function AiAssistDockPanel() {
  const { available, open, claims, setSlot, error, dismissError } = useAiAssistDock()
  const location = useLocation()
  const page = sectionFor(location.pathname)
  if (!available) return null
  return (
    // kept mounted while hidden, so a conversation survives closing and opening the panel
    <aside
      aria-label="AI Assist panel"
      className={cn(
        // a column: the panel inside grows to the bottom of the screen
        "bg-background z-30 flex shrink-0 flex-col overflow-y-auto border-l p-3",
        // a column beside the page on wide screens; over the page from the right on narrower ones
        "max-xl:fixed max-xl:top-14 max-xl:right-0 max-xl:bottom-0 max-xl:w-full max-xl:shadow-xl sm:max-xl:w-[24rem]",
        "xl:sticky xl:top-14 xl:h-[calc(100svh-3.5rem)] xl:w-[24rem]",
        !open && "hidden",
      )}
    >
      <div ref={setSlot} className={cn("flex flex-1 flex-col", !claims && "hidden")} />
      {!claims && (
        <GeneralPanel
          page={page ? `${page.label} (${location.pathname})` : location.pathname}
          error={error}
          onDismissError={dismissError}
        />
      )}
    </aside>
  )
}

/** Puts a screen's own AI Assist panel in the dock (instead of the general chat) while it is mounted. */
export function AiAssistSlot({ children }: { children: React.ReactNode }) {
  const { slot, claimSlot } = useAiAssistDock()
  useEffect(() => claimSlot(), [claimSlot])
  return slot ? createPortal(children, slot) : null
}

/** The header every AI Assist panel shares: the icon, its name and › to hide it. */
export function AiAssistHeader({ onClose }: { onClose: () => void }) {
  return (
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
  )
}

/** The chat on screens without a panel of their own: questions about Prooflix, this screen and its error. */
function GeneralPanel({
  page,
  error,
  onDismissError,
}: {
  page: string
  error: ScreenError | null
  onDismissError: () => void
}) {
  const dock = useAiAssistDock()
  const ask = useAiAssistAsk()
  const [turns, setTurns] = useState<AiAssistRunTurn[]>([])
  const [question, setQuestion] = useState("")
  const end = useRef<HTMLDivElement>(null)
  const errorText = error ? `${error.title}\n${error.messages.join("\n")}` : ""

  useEffect(() => {
    if (turns.length || ask.isPending) end.current?.scrollIntoView({ block: "nearest", behavior: "smooth" })
  }, [turns.length, ask.isPending])

  const send = (text: string) => {
    const q = text.trim()
    if (!q || ask.isPending) return
    ask.mutate(
      { question: q, page, error: errorText, turns },
      {
        onSuccess: (r) => {
          setTurns((t) => [...t, { question: q, answer: r.answer }])
          setQuestion("")
        },
      },
    )
  }

  return (
    <Card aria-label="AI Assist" className="flex-1 gap-0 overflow-hidden py-0">
      <AiAssistHeader onClose={() => dock.setOpen(false)} />
      {/* the question box sits at the bottom of the panel */}
      <div className="flex flex-1 flex-col gap-4 p-3 text-sm">
        {!dock.ready ? (
          <div className="grid gap-2">
            <p>AI Assist answers questions about Prooflix and explains errors, but it isn't set up yet.</p>
            {dock.canSetUp ? (
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
        ) : (
          <>
            {error ? (
              <div className="grid gap-2">
                <div className="flex items-start gap-2">
                  <AlertCircle className="text-destructive mt-0.5 size-4 shrink-0" />
                  <div className="grid min-w-0 gap-0.5">
                    <p className="font-medium">{error.title}</p>
                    <p className="text-muted-foreground line-clamp-4 text-xs break-words">{error.messages.join(" ")}</p>
                  </div>
                </div>
                <p>This screen shows an error. Do you want AI Assist to explain it and how to fix it?</p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    onClick={() => send("Explain this error and how to fix it.")}
                    disabled={ask.isPending}
                  >
                    <AiAssistIcon /> Yes, explain it
                  </Button>
                  <Button size="sm" variant="ghost" onClick={onDismissError}>
                    Not now
                  </Button>
                </div>
              </div>
            ) : (
              !turns.length &&
              !ask.isPending && (
                <p>Ask anything about Prooflix or this screen: how to do something, what a setting means.</p>
              )
            )}

            {(turns.length > 0 || ask.isPending) && (
              <section className="grid gap-3 border-t pt-3" aria-label="Questions and answers">
                {turns.map((t, i) => (
                  <div key={i} className="grid gap-2">
                    <p className="bg-muted justify-self-end rounded-lg px-2.5 py-1.5 whitespace-pre-wrap">
                      {t.question}
                    </p>
                    <p className="whitespace-pre-wrap">{t.answer}</p>
                  </div>
                ))}
                {ask.isPending && (
                  <div className="grid gap-2">
                    <p className="bg-muted justify-self-end rounded-lg px-2.5 py-1.5 whitespace-pre-wrap">
                      {ask.variables?.question}
                    </p>
                    <p className="text-muted-foreground flex items-center gap-2">
                      <Loader2 className="size-4 animate-spin" /> AI Assist is thinking…
                    </p>
                  </div>
                )}
              </section>
            )}
            {ask.error && <ErrorAlert title="AI Assist couldn't answer" error={ask.error} assist={false} />}
            <div ref={end} />

            <form
              className="mt-auto grid gap-2 border-t pt-3"
              onSubmit={(e) => {
                e.preventDefault()
                send(question)
              }}
            >
              <Textarea
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  // Enter sends; Shift+Enter starts a new line
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    send(question)
                  }
                }}
                placeholder={turns.length ? "Ask a follow-up question…" : "Ask AI Assist…"}
                aria-label="Ask AI Assist"
                maxLength={2000}
                rows={2}
                disabled={ask.isPending}
                className="min-h-16 resize-none text-sm"
              />
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground flex-1 text-xs">
                  Sends your question, this screen's name{error ? " and its error" : ""} to Claude. No data.
                </span>
                <Button type="submit" size="sm" disabled={!question.trim() || ask.isPending}>
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

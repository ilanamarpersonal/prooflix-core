import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { useLocation } from "react-router"
import {
  AlertCircle,
  Check,
  ChevronRight,
  Loader2,
  Maximize2,
  Minimize2,
  PanelRightClose,
  PanelRightOpen,
  RotateCcw,
  RotateCw,
  SendHorizontal,
  Wrench,
} from "lucide-react"

import { ErrorAlert } from "../app/error-alert"
import { useCurrentSection, useScreens } from "../app/sections"
import { useAuthStatus } from "../auth/api"
import { ResizeDivider } from "../components/resize-divider"
import { Button } from "../components/ui/button"
import { Card } from "../components/ui/card"
import { Input } from "../components/ui/input"
import { Textarea } from "../components/ui/textarea"
import { cn } from "../lib/utils"
import {
  useAiAssistAsk,
  useAiAssistFix,
  useAiAssistStatus,
  useRestartServer,
  useSetSystemParameter,
  type AiAssistRunTurn,
  type AiAssistSettingsFix,
} from "./api"
import { AiAssistIcon } from "./icon"

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
  /** a question typed in the top bar, for the panel that answers it */
  question: { id: number; text: string } | null
  /** ask from the top bar: opens the panel and hands it the question */
  ask: (text: string) => void
  /** the panel that answered the question (so it isn't asked twice) */
  consumeQuestion: (id: number) => void
  /** a screen panel that answers top-bar questions itself (the failed run's); else the general chat does */
  takeQuestions: () => () => void
  takers: number
  /** the general chat was asked on a screen with its own panel (SQL Editor): shown under it */
  generalWanted: boolean
  /** the panel fills the screen under the top bar (the page is hidden); remembered in the browser */
  expanded: boolean
  setExpanded: (expanded: boolean) => void
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
  question: null,
  ask: () => {},
  consumeQuestion: () => {},
  takeQuestions: () => () => {},
  takers: 0,
  generalWanted: false,
  expanded: false,
  setExpanded: () => {},
}

const DockContext = createContext<Dock>(NOOP_DOCK)

/** The AI Assist panel on the right of every screen (outside the app shell, a no-op). */
export const useAiAssistDock = () => useContext(DockContext)

const EXPANDED_KEY = "prooflix-ai-assist-expanded"

function loadExpanded(): boolean {
  try {
    return localStorage.getItem(EXPANDED_KEY) === "1"
  } catch {
    return false
  }
}

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
  const [question, setQuestion] = useState<{ id: number; text: string } | null>(null)
  const [takers, setTakers] = useState(0)
  const [generalWanted, setGeneralWanted] = useState(false)
  const [expanded, setExpandedState] = useState(loadExpanded)
  const setExpanded = useCallback((next: boolean) => {
    setExpandedState(next)
    try {
      localStorage.setItem(EXPANDED_KEY, next ? "1" : "0")
    } catch {
      /* storage unavailable */
    }
  }, [])

  // a new screen starts without the last one's error, and shows the page (an object link in an answer opens it)
  const firstPath = useRef(true)
  useEffect(() => {
    setError(null)
    seen.current = new Set()
    setGeneralWanted(false)
    if (firstPath.current) firstPath.current = false
    else setExpanded(false)
  }, [location.pathname, setExpanded])

  // Esc shrinks the full-screen panel back beside the page
  useEffect(() => {
    if (!expanded || !open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented && !document.querySelector("[role=dialog]")) setExpanded(false)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [expanded, open, setExpanded])

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
  const ask = useCallback(
    (text: string) => {
      const q = text.trim()
      if (!q) return
      setQuestion((prev) => ({ id: (prev?.id ?? 0) + 1, text: q }))
      if (!takers) setGeneralWanted(true)
      setOpen(true)
    },
    [takers],
  )
  const consumeQuestion = useCallback((id: number) => setQuestion((q) => (q?.id === id ? null : q)), [])
  const takeQuestions = useCallback(() => {
    setTakers((n) => n + 1)
    return () => setTakers((n) => n - 1)
  }, [])
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
      question,
      ask,
      consumeQuestion,
      takeQuestions,
      takers,
      generalWanted,
      expanded,
      setExpanded,
    }),
    [
      available,
      ready,
      canSetUp,
      open,
      popUp,
      reportError,
      slot,
      claimSlot,
      error,
      dismissError,
      claims,
      question,
      ask,
      consumeQuestion,
      takeQuestions,
      takers,
      generalWanted,
      expanded,
      setExpanded,
    ],
  )
  return <DockContext.Provider value={dock}>{children}</DockContext.Provider>
}

/**
 * The top bar's AI Assist on every screen: an "Ask AI Assist…" box (Enter opens the panel and asks right away)
 * and a button that shows or hides the panel, with a red dot when the screen shows an error. On small
 * screens only the button shows.
 */
export function AiAssistToggle() {
  const { available, open, setOpen, error, ask } = useAiAssistDock()
  const [text, setText] = useState("")
  if (!available) return null
  return (
    <div className="flex items-center gap-1">
      <form
        role="search"
        className="relative max-md:hidden"
        onSubmit={(e) => {
          e.preventDefault()
          if (!text.trim()) return setOpen(true)
          ask(text)
          setText("")
        }}
      >
        <AiAssistIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && setText("")}
          placeholder="Ask AI Assist…"
          aria-label="Ask AI Assist"
          maxLength={2000}
          className="h-8 w-56 pl-8 text-sm lg:w-72"
        />
      </form>
      <Button
        variant={open ? "secondary" : "ghost"}
        size="icon"
        onClick={() => setOpen(!open)}
        aria-pressed={open}
        aria-label={open ? "Hide AI Assist" : "Show AI Assist"}
        title={open ? "Hide AI Assist" : "Show AI Assist"}
        className="relative size-8"
      >
        <span className="md:hidden">
          <AiAssistIcon className="size-4" />
        </span>
        <span className="max-md:hidden">{open ? <PanelRightClose /> : <PanelRightOpen />}</span>
        {error && !open && (
          <span
            aria-label="this screen shows an error"
            className="bg-destructive ring-background absolute -top-1 -right-1 size-2.5 rounded-full ring-2"
          />
        )}
      </Button>
    </div>
  )
}

// the panel's width, set with the divider on its left edge and remembered in the browser
const WIDTH_KEY = "prooflix-ai-assist-width"
const DEFAULT_WIDTH = 384 // 24rem
const clampWidth = (w: number) =>
  Math.round(Math.min(Math.max(w, 300), Math.max(300, Math.min(960, window.innerWidth - 360))))

function loadWidth(): number {
  try {
    const w = Number(localStorage.getItem(WIDTH_KEY))
    return w ? clampWidth(w) : DEFAULT_WIDTH
  } catch {
    return DEFAULT_WIDTH
  }
}

/** The AI Assist panel itself, on the right of the page (placed next to the page in the app shell). */
export function AiAssistDockPanel() {
  const { available, open, claims, setSlot, error, dismissError, takers, generalWanted, expanded } = useAiAssistDock()
  const location = useLocation()
  const page = useCurrentSection()
  const [width, setWidth] = useState(loadWidth)
  const resize = (w: number, save = false) => {
    const next = clampWidth(w)
    setWidth(next)
    if (save)
      try {
        localStorage.setItem(WIDTH_KEY, String(next))
      } catch {
        /* storage unavailable */
      }
  }
  if (!available) return null
  return (
    // kept mounted while hidden, so a conversation survives closing and opening the panel
    <aside
      aria-label="AI Assist panel"
      data-assist-expanded={open && expanded ? "" : undefined}
      style={{ ["--assist-w" as string]: `${width}px` }}
      className={cn(
        "bg-background z-30 flex shrink-0",
        open && expanded
          ? // in the page's place, between the menu and the right edge (the shell hides the page)
            "sticky top-14 h-[calc(100svh-3.5rem)] min-w-0 flex-1"
          : [
              // a column beside the page on wide screens; over the page from the right on narrower ones
              "max-xl:fixed max-xl:top-14 max-xl:right-0 max-xl:bottom-0 max-xl:w-full max-xl:shadow-xl sm:max-xl:w-(--assist-w)",
              "xl:sticky xl:top-14 xl:h-[calc(100svh-3.5rem)] xl:w-(--assist-w)",
            ],
        !open && "hidden",
      )}
    >
      {/* drag the bar between the page and the panel to make the panel wider or narrower */}
      {!expanded && (
        <ResizeDivider
          orientation="vertical"
          after
          className="-mr-2 max-sm:hidden"
          label="Resize the AI Assist panel"
          value={width}
          onResize={(w) => resize(w)}
          onDone={(w) => resize(w, true)}
          onReset={() => resize(DEFAULT_WIDTH, true)}
        />
      )}
      {/* a column: the panel inside grows to the bottom of the screen */}
      <div
        className={cn(
          "flex min-w-0 flex-1 flex-col overflow-y-auto p-3",
          // full screen: a readable column in the middle
          expanded ? "mx-auto w-full max-w-3xl md:py-6" : "max-sm:border-l",
        )}
      >
        <div ref={setSlot} className={cn("flex flex-1 flex-col", !claims && "hidden")} />
        {/* the general chat; on a screen with its own panel, under it once asked from the top bar */}
        {(!claims || (!takers && generalWanted)) && (
          <GeneralPanel
            page={page ? `${page.label} (${location.pathname})` : location.pathname}
            error={error}
            onDismissError={dismissError}
          />
        )}
      </div>
    </aside>
  )
}

/** Puts a screen's own AI Assist panel in the dock (instead of the general chat) while it is mounted. */
export function AiAssistSlot({ children }: { children: React.ReactNode }) {
  const { slot, claimSlot } = useAiAssistDock()
  useEffect(() => claimSlot(), [claimSlot])
  return slot ? createPortal(children, slot) : null
}

/** The header every AI Assist panel shares: the icon, its name, expand to full screen, and › to hide it. */
export function AiAssistHeader({ onClose }: { onClose: () => void }) {
  const { expanded, setExpanded } = useAiAssistDock()
  return (
    <div className="flex items-center gap-2 border-b px-3 py-2.5">
      <AiAssistIcon className="size-5" />
      <span className="flex-1 text-sm font-semibold">AI Assist</span>
      <Button
        variant="ghost"
        size="icon"
        className="size-7 max-md:hidden"
        onClick={() => setExpanded(!expanded)}
        aria-pressed={expanded}
        aria-label={expanded ? "Shrink AI Assist (Esc)" : "Expand AI Assist to full screen"}
        title={expanded ? "Shrink beside the page (Esc)" : "Expand to full screen"}
      >
        {expanded ? <Minimize2 /> : <Maximize2 />}
      </Button>
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
  // each answer says whether a setting change might fix it and which screen to offer a button to
  const [turns, setTurns] = useState<(AiAssistRunTurn & { canFix: boolean; openScreen: string })[]>([])
  // a screen of this product or another one the user has (null otherwise)
  const screenFor = useScreens()
  const [question, setQuestion] = useState("")
  const end = useRef<HTMLDivElement>(null)
  const errorText = error ? `${error.title}\n${error.messages.join("\n")}` : ""

  useEffect(() => {
    if (turns.length || ask.isPending) end.current?.scrollIntoView({ block: "nearest", behavior: "smooth" })
  }, [turns.length, ask.isPending])

  // a question typed in the top bar, unless a screen panel (a failed run's) answers it
  const { question: asked, takers, consumeQuestion } = dock
  const sendRef = useRef<(text: string) => void>(() => {})
  useEffect(() => {
    if (!asked || takers || ask.isPending) return // a question asked while answering waits for the answer
    consumeQuestion(asked.id)
    sendRef.current(asked.text)
  }, [asked, takers, ask.isPending, consumeQuestion])

  const send = (text: string) => {
    const q = text.trim()
    if (!q || ask.isPending) return
    ask.mutate(
      { question: q, page, error: errorText, turns },
      {
        onSuccess: (r) => {
          setTurns((t) => [...t, { question: q, answer: r.answer, canFix: r.can_fix, openScreen: r.open_screen }])
          setQuestion("")
        },
      },
    )
  }

  sendRef.current = send

  return (
    <Card aria-label="AI Assist" className="flex-[1_0_auto] gap-0 overflow-hidden py-0">
      <AiAssistHeader onClose={() => dock.setOpen(false)} />
      {/* the question box sits at the bottom of the panel */}
      <div className="flex flex-1 flex-col gap-4 p-3 text-sm">
        {!dock.ready ? (
          <div className="grid gap-2">
            <p>AI Assist answers questions about Prooflix and explains errors, but it isn't set up yet.</p>
            {dock.canSetUp ? (
              <Button size="sm" className="justify-self-start" onClick={() => screenFor("ai-assist")?.open()}>
                <AiAssistIcon /> Set up AI Assist
              </Button>
            ) : (
              <p className="text-muted-foreground text-xs">
                Ask an admin to add a Claude account in Settings & Management (AI Assist).
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
                {/* step 1: the offer to explain; once asked, the explanation follows below */}
                {!turns.length && !ask.isPending && (
                  <>
                    <p>This screen shows an error. Do you want AI Assist to explain it?</p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        onClick={() => send("Explain this error and how it can be fixed.")}
                        disabled={ask.isPending}
                      >
                        <AiAssistIcon /> Yes, explain it
                      </Button>
                      <Button size="sm" variant="ghost" onClick={onDismissError}>
                        Not now
                      </Button>
                    </div>
                  </>
                )}
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
                    {screenFor(t.openScreen) && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="justify-self-start"
                        onClick={() => screenFor(t.openScreen)!.open()}
                      >
                        Open {screenFor(t.openScreen)!.label}
                      </Button>
                    )}
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
            {/* step 2, after an answer: the offer to fix it */}
            {turns.length > 0 && turns[turns.length - 1].canFix && !ask.isPending && (
              <SettingsFixOffer key={turns.length} page={page} error={errorText} turns={turns} />
            )}
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

/**
 * "Do you want AI Assist to fix it?" on any screen: it proposes System tab settings to change (never secrets)
 * and the steps to do by hand. Apply saves the settings; Restart server applies them. Users with the System tab.
 */
function SettingsFixOffer({ page, error, turns }: { page: string; error: string; turns: AiAssistRunTurn[] }) {
  const auth = useAuthStatus().data
  const canFix = !auth?.enabled || auth.user?.role === "admin" || !!auth.user?.visible_tabs.includes("system")
  const fix = useAiAssistFix()
  const save = useSetSystemParameter()
  const restart = useRestartServer()
  const [applied, setApplied] = useState(false)
  const [applyError, setApplyError] = useState<unknown>(null)
  if (!canFix) return null

  const propose = () => {
    setApplied(false)
    setApplyError(null)
    restart.reset()
    fix.mutate({ page, error, turns })
  }
  const apply = async (proposal: AiAssistSettingsFix) => {
    setApplyError(null)
    try {
      for (const c of proposal.changes) await save.mutateAsync({ name: c.name, value: c.value || null })
      setApplied(true)
    } catch (e) {
      setApplyError(e)
    }
  }

  return (
    <section className="grid gap-3 border-t pt-3" aria-label="Fix with AI Assist">
      {!fix.data && !fix.isPending && (
        <>
          <p>Do you want AI Assist to fix it?</p>
          <p className="text-muted-foreground text-xs">
            It proposes changes to the server's settings (the System tab, never passwords or keys) and the steps to do
            yourself, and sends the settings to Claude. You see every change first; nothing is saved until you apply it.
          </p>
          <Button size="sm" className="justify-self-start" onClick={propose}>
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
          <Button size="sm" variant="outline" className="justify-self-start" onClick={propose}>
            <RotateCcw /> Try again
          </Button>
        </div>
      )}
      {fix.data && (
        <div className="grid gap-3">
          <p className="whitespace-pre-wrap">{fix.data.summary}</p>
          {fix.data.changes.length > 0 && (
            <div className="grid gap-2">
              <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">Settings to change</h3>
              {fix.data.changes.map((c) => (
                <div key={c.name} className="grid gap-1 rounded-md border p-2">
                  <p className="flex items-center gap-1.5 font-mono text-xs font-medium break-all">
                    {c.name}
                    {applied && <Check className="size-3.5 shrink-0 text-emerald-600" />}
                  </p>
                  <p className="font-mono text-xs break-all">
                    <span className="text-red-700 line-through dark:text-red-400">{c.current || "(not set)"}</span>
                    {" → "}
                    <span className="text-emerald-700 dark:text-emerald-400">{c.value || "(default)"}</span>
                  </p>
                  {c.reason && <p className="text-muted-foreground text-xs">{c.reason}</p>}
                </div>
              ))}
            </div>
          )}
          {fix.data.steps.length > 0 && (
            <div className="grid gap-1">
              <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">Do yourself</h3>
              <ol className="grid list-decimal gap-1 pl-5">
                {fix.data.steps.map((step, i) => (
                  <li key={i} className="whitespace-pre-wrap">
                    {step}
                  </li>
                ))}
              </ol>
            </div>
          )}
          {fix.data.changes.length === 0 && fix.data.steps.length === 0 && (
            <p className="text-muted-foreground text-xs">AI Assist found nothing it can change here.</p>
          )}
          <p className="text-muted-foreground text-xs">
            Proposed by {fix.data.model}. Read the changes before you apply them.
          </p>
          {fix.data.changes.length > 0 && !applied && (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => void apply(fix.data)} disabled={save.isPending}>
                {save.isPending ? <Loader2 className="animate-spin" /> : <Check />} Apply changes
              </Button>
              <Button size="sm" variant="ghost" onClick={() => fix.reset()} disabled={save.isPending}>
                Discard
              </Button>
            </div>
          )}
          {applyError != null && <ErrorAlert title="Could not save the settings" error={applyError} assist={false} />}
          {applied && !restart.isSuccess && (
            <div className="grid gap-2">
              <p className="text-emerald-700 dark:text-emerald-400">
                Saved. They take effect when the server restarts.
                {fix.data.changes.some((c) => !c.live) &&
                  " Some only apply after the server process itself is restarted."}
              </p>
              <Button
                size="sm"
                className="justify-self-start"
                onClick={() => restart.mutate()}
                disabled={restart.isPending}
              >
                {restart.isPending ? <Loader2 className="animate-spin" /> : <RotateCw />} Restart server
              </Button>
              {restart.error && <ErrorAlert title="Could not restart" error={restart.error} assist={false} />}
            </div>
          )}
          {restart.isSuccess && (
            <p className="flex items-start gap-2 text-emerald-700 dark:text-emerald-400">
              <Check className="mt-0.5 size-4 shrink-0" /> Restarted with the new settings. Try again on this screen.
            </p>
          )}
        </div>
      )}
    </section>
  )
}

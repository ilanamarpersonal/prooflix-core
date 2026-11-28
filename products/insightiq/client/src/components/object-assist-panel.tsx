import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import { Check, Loader2, RotateCcw, SendHorizontal, ShieldCheck, Wrench, X } from "lucide-react"
import { Link } from "react-router"
import { useQueryClient } from "@tanstack/react-query"

import { AiAssistHeader, AiAssistSlot, useAiAssistDock } from "@prooflix/ui/ai-assist/dock"
import { AiAssistIcon } from "@prooflix/ui/ai-assist/icon"
import { ErrorAlert } from "@prooflix/ui/app/error-alert"
import { productHref } from "@prooflix/ui/lib/products"
import { Button } from "@prooflix/ui/components/ui/button"
import { Card } from "@prooflix/ui/components/ui/card"
import { Textarea } from "@prooflix/ui/components/ui/textarea"
import { api, useAssist, useObjectTypes } from "@/lib/api"
import type { AssistProposal } from "@/lib/types"

interface Turn {
  question: string
  answer: string
  proposals: (AssistProposal & { state?: "applied" | "dismissed" | "failed"; error?: string })[]
  model: string
  calls: number
}

// the conversation outlives moving between the Objects screens (each mounts its own panel)
let turns: Turn[] = []
const listeners = new Set<() => void>()
const store = {
  get: () => turns,
  set: (next: Turn[]) => {
    turns = next
    listeners.forEach((l) => l())
  },
  subscribe: (l: () => void) => {
    listeners.add(l)
    return () => listeners.delete(l)
  },
}

/** `[[Customer:10442|Dana Cohen]]` in an answer becomes a link to that object */
const OBJECT_REF = /\[\[([A-Za-z][A-Za-z0-9_]*):([^|\]]+)\|([^\]]+)\]\]/g

/** **bold** in a line of an answer */
function Bold({ text }: { text: string }) {
  return text.split(/\*\*(.+?)\*\*/g).map((s, i) => (i % 2 ? <strong key={i}>{s}</strong> : s))
}

/** One line of an answer: bold and object links */
function Inline({ text }: { text: string }) {
  const parts: React.ReactNode[] = []
  let last = 0
  for (const m of text.matchAll(OBJECT_REF)) {
    parts.push(<Bold key={`t${m.index}`} text={text.slice(last, m.index)} />)
    const [, type, key, label] = m
    parts.push(
      <Link
        key={m.index}
        to={`/objects/${encodeURIComponent(type)}/${encodeURIComponent(key)}`}
        className="text-primary font-medium underline-offset-2 hover:underline"
      >
        {label}
      </Link>,
    )
    last = m.index + m[0].length
  }
  parts.push(<Bold key="end" text={text.slice(last)} />)
  return parts
}

/** An answer: paragraphs and "- " bullet lists, with bold and object links (Claude writes light Markdown) */
function AnswerText({ text }: { text: string }) {
  const blocks: React.ReactNode[] = []
  let items: string[] = []
  let para: string[] = []
  const flush = () => {
    if (para.length)
      blocks.push(
        <p key={blocks.length} className="whitespace-pre-wrap">
          <Inline text={para.join("\n")} />
        </p>,
      )
    if (items.length)
      blocks.push(
        <ul key={blocks.length} className="list-disc space-y-0.5 pl-5">
          {items.map((it, i) => (
            <li key={i}>
              <Inline text={it} />
            </li>
          ))}
        </ul>,
      )
    para = []
    items = []
  }
  for (const line of text.split("\n")) {
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/)
    if (bullet) {
      if (para.length) flush() // the paragraph before the list
      items.push(bullet[1])
    } else if (!line.trim()) flush()
    else {
      if (items.length) flush()
      para.push(line)
    }
  }
  flush()
  return <div className="grid gap-2">{blocks}</div>
}

/**
 * AI Assist on the Objects screens: questions about objects, answered by Claude with tools that read the
 * Object API as the signed-in user. Only types an admin opened to AI Assist are used, sensitive values are
 * never sent, and actions are only proposed: the user applies them here.
 */
export function ObjectAssistPanel({ context }: { context?: string }) {
  const dock = useAiAssistDock()
  const ready = dock.ready
  const types = useObjectTypes()
  const open = (types.data ?? []).filter((t) => t.ai)
  const ask = useAssist()
  const qc = useQueryClient()
  const history = useSyncExternalStore(store.subscribe, store.get)
  const [question, setQuestion] = useState("")
  const end = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (history.length || ask.isPending) end.current?.scrollIntoView({ block: "nearest", behavior: "smooth" })
  }, [history.length, ask.isPending])

  const send = (text: string) => {
    const q = text.trim()
    if (!q || ask.isPending) return
    // what the user is looking at, so "this customer" means something
    const full = context ? `(On screen: ${context})\n${q}` : q
    ask.mutate(
      { question: full, turns: history.map((t) => ({ question: t.question, answer: t.answer })) },
      {
        onSuccess: (r) => {
          store.set([
            ...store.get(),
            { question: q, answer: r.answer, proposals: r.proposals, model: r.model, calls: r.tool_calls },
          ])
          setQuestion("")
        },
      },
    )
  }

  // a question typed in the top bar's "Ask AI Assist…" box is answered here
  const { takeQuestions, question: topQuestion, consumeQuestion } = dock
  const canAnswer = ready && open.length > 0
  useEffect(() => (canAnswer ? takeQuestions() : undefined), [canAnswer, takeQuestions])
  const sendRef = useRef(send)
  sendRef.current = send
  useEffect(() => {
    if (!topQuestion || !canAnswer || ask.isPending) return
    consumeQuestion(topQuestion.id)
    sendRef.current(topQuestion.text)
  }, [topQuestion, canAnswer, ask.isPending, consumeQuestion])

  const mark = (turn: number, id: string, change: Partial<Turn["proposals"][number]>) =>
    store.set(
      store
        .get()
        .map((t, i) =>
          i === turn ? { ...t, proposals: t.proposals.map((p) => (p.id === id ? { ...p, ...change } : p)) } : t,
        ),
    )
  const [applying, setApplying] = useState<string | null>(null)
  const apply = async (turn: number, p: AssistProposal) => {
    setApplying(p.id)
    try {
      await api.runAction(p.type, p.key, p.action, p.values, p.reason)
      mark(turn, p.id, { state: "applied", error: undefined })
      void qc.invalidateQueries({ queryKey: ["ontology", "objects"] })
    } catch (e) {
      mark(turn, p.id, { state: "failed", error: e instanceof Error ? e.message : String(e) })
    } finally {
      setApplying(null)
    }
  }

  return (
    <AiAssistSlot>
      <Card aria-label="AI Assist" className="flex flex-[1_0_auto] flex-col gap-0 overflow-hidden py-0">
        <AiAssistHeader onClose={() => dock.setOpen(false)} />
        <div className="flex flex-1 flex-col gap-4 p-3 text-sm">
          {!ready ? (
            <div className="grid gap-2">
              <p>AI Assist answers questions about your objects, but it isn't set up yet.</p>
              {dock.canSetUp ? (
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
          ) : types.isPending ? (
            <p className="text-muted-foreground flex items-center gap-2">
              <Loader2 className="size-4 animate-spin" /> Loading…
            </p>
          ) : !open.length ? (
            <div className="text-muted-foreground grid gap-2">
              <p>No object type you see is open to AI Assist yet.</p>
              <p className="text-xs">
                An admin opens a type in the Object Model: edit the type, step Access, "Open to AI Assist".
              </p>
            </div>
          ) : (
            <>
              <div className="grid flex-1 content-start gap-4">
                {!history.length && !ask.isPending && (
                  <div className="text-muted-foreground grid gap-2">
                    <p>
                      Ask about your objects, for example "which customers in Haifa have accounts over 20,000?". AI
                      Assist can propose an action; nothing changes until you apply it.
                    </p>
                    <p className="text-xs">Types it uses: {open.map((t) => t.api_name).join(", ")}.</p>
                  </div>
                )}
                {history.map((t, i) => (
                  <div key={i} className="grid gap-2">
                    <p className="bg-muted justify-self-end rounded-lg px-3 py-2 whitespace-pre-wrap">{t.question}</p>
                    <AnswerText text={t.answer} />
                    {t.proposals.map((p) => (
                      <Card key={p.id} className="gap-2 px-3 py-2.5" aria-label={`Proposed action ${p.label}`}>
                        <div className="flex items-center gap-2">
                          <Wrench className="text-muted-foreground size-4" />
                          <span className="font-medium">{p.label}</span>
                          <span className="text-muted-foreground">on</span>
                          <Link
                            to={`/objects/${encodeURIComponent(p.type)}/${encodeURIComponent(p.key)}`}
                            className="text-primary truncate font-medium hover:underline"
                          >
                            {p.title ?? p.key}
                          </Link>
                        </div>
                        <ul className="text-xs">
                          {Object.entries(p.values).map(([k, v]) => (
                            <li key={k}>
                              <span className="text-muted-foreground">{k}</span> → {String(v ?? "")}
                            </li>
                          ))}
                        </ul>
                        {p.reason && <p className="text-muted-foreground text-xs">{p.reason}</p>}
                        {p.state === "applied" ? (
                          <p className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400">
                            <Check className="size-4" /> Applied
                          </p>
                        ) : p.state === "dismissed" ? (
                          <p className="text-muted-foreground text-xs">Dismissed</p>
                        ) : (
                          <>
                            {p.state === "failed" && <p className="text-destructive text-xs">{p.error}</p>}
                            <div className="flex gap-2">
                              <Button size="sm" loading={applying === p.id} onClick={() => apply(i, p)}>
                                <Check /> Apply
                              </Button>
                              <Button size="sm" variant="ghost" onClick={() => mark(i, p.id, { state: "dismissed" })}>
                                <X /> Dismiss
                              </Button>
                            </div>
                          </>
                        )}
                      </Card>
                    ))}
                    <p className="text-muted-foreground text-xs">
                      {t.model} · {t.calls} {t.calls === 1 ? "lookup" : "lookups"}
                    </p>
                  </div>
                ))}
                {ask.isPending && (
                  <p className="text-muted-foreground flex items-center gap-2">
                    <Loader2 className="size-4 animate-spin" /> AI Assist is looking at your objects…
                  </p>
                )}
                {ask.error && <ErrorAlert title="AI Assist couldn't answer" error={ask.error} assist={false} />}
                <div ref={end} />
              </div>
              <div className="sticky bottom-0 grid gap-2 pt-1">
                <form
                  className="flex items-end gap-2"
                  onSubmit={(e) => {
                    e.preventDefault()
                    send(question)
                  }}
                >
                  <Textarea
                    aria-label="Question for AI Assist"
                    placeholder="Ask about your objects…"
                    className="min-h-10 resize-none"
                    rows={2}
                    value={question}
                    onChange={(e) => setQuestion(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault()
                        send(question)
                      }
                    }}
                  />
                  <Button
                    type="submit"
                    size="icon"
                    loading={ask.isPending}
                    disabled={!question.trim()}
                    aria-label="Ask"
                    title="Ask"
                  >
                    <SendHorizontal />
                  </Button>
                </form>
                <div className="text-muted-foreground flex items-center gap-2 text-xs">
                  <ShieldCheck className="size-3.5 shrink-0" />
                  <span className="flex-1">Runs with your access. Sensitive values are never sent to Claude.</span>
                  {history.length > 0 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs"
                      onClick={() => {
                        store.set([])
                        ask.reset()
                      }}
                    >
                      <RotateCcw className="size-3" /> New chat
                    </Button>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </Card>
    </AiAssistSlot>
  )
}

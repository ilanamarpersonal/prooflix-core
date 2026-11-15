import { AlertCircle, Check, Copy } from "lucide-react"
import { useEffect, useState } from "react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { ApiError } from "@/lib/api"

export function ErrorAlert({ title = "Something went wrong", error }: { title?: string; error: unknown }) {
  const messages =
    error instanceof ApiError && error.errors.length
      ? error.errors
      : [error instanceof Error ? error.message : String(error)]
  return (
    <Alert variant="destructive" className="pr-12">
      <AlertCircle />
      <CopyButton text={messages.join("\n")} />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <ul className="list-disc pl-4">
          {messages.map((m, i) => (
            <li key={i}>{m}</li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  )
}

export function ValidationErrors({ errors }: { errors: string[] }) {
  if (!errors.length) return null
  return <ErrorAlert title="Validation errors" error={new ApiError(422, errors[0], errors)} />
}

/** Copies the error text, so it can be pasted into a ticket or a chat. */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])
  const label = copied ? "Copied" : "Copy error message"
  return (
    <button
      type="button"
      onClick={() => void copyText(text).then(setCopied)}
      aria-label={label}
      title={label}
      className="hover:bg-destructive/10 focus-visible:ring-ring absolute top-2.5 right-2.5 grid size-7 place-items-center rounded-md outline-none focus-visible:ring-2"
    >
      {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
    </button>
  )
}

/** The Clipboard API, falling back to a hidden textarea where it is blocked or missing (plain http). */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const area = document.createElement("textarea")
    area.value = text
    area.setAttribute("readonly", "")
    area.style.position = "fixed"
    area.style.opacity = "0"
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand("copy")
    area.remove()
    return ok
  }
}

import { Check, X } from "lucide-react"

import { cn } from "@/lib/utils"

/** The password rules (also checked by the server): 8+ characters, a capital letter, a number. */
export const PASSWORD_RULES: { label: string; ok: (p: string) => boolean }[] = [
  { label: "At least 8 characters", ok: (p) => p.length >= 8 },
  { label: "A capital letter", ok: (p) => /[A-Z]/.test(p) },
  { label: "A number", ok: (p) => /\d/.test(p) },
]

export const passwordOk = (p: string) => PASSWORD_RULES.every((r) => r.ok(p))

/** A live checklist of the rules under a password field. */
export function PasswordRules({ password, className }: { password: string; className?: string }) {
  return (
    <ul className={cn("grid gap-0.5 text-xs", className)} aria-label="Password rules">
      {PASSWORD_RULES.map((r) => {
        const ok = r.ok(password)
        return (
          <li
            key={r.label}
            className={cn("flex items-center gap-1.5", ok ? "text-status-succeeded" : "text-muted-foreground")}
          >
            {ok ? <Check className="size-3.5" /> : <X className="size-3.5" />}
            {r.label}
          </li>
        )
      })}
    </ul>
  )
}

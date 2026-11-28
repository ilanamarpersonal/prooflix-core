import { useEffect, useRef, useState } from "react"
import { ChevronDown, KeyRound, Loader2, LogOut, UserRound, X } from "lucide-react"

import { ErrorMessage } from "../components/error-message"
import { Badge } from "../components/ui/badge"
import { Button } from "../components/ui/button"
import { Input } from "../components/ui/input"
import { Label } from "../components/ui/label"
import { useChangePassword, useLogout, type AuthUser } from "./api"
import { PasswordRules, passwordOk } from "./password-rules"

/** The signed-in user in the top bar of every product: change password, sign out. */
export function UserMenu({ user }: { user: AuthUser }) {
  const [open, setOpen] = useState(false)
  const [changing, setChanging] = useState(false)
  const logout = useLogout()
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false)
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false)
    document.addEventListener("mousedown", close)
    document.addEventListener("keydown", esc)
    return () => {
      document.removeEventListener("mousedown", close)
      document.removeEventListener("keydown", esc)
    }
  }, [open])

  return (
    <div ref={ref} className="relative">
      <Button variant="ghost" size="sm" onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="menu">
        <UserRound />
        <span className="max-w-32 truncate">{user.username}</span>
        <ChevronDown className="size-3.5" />
      </Button>
      {open && (
        <div
          role="menu"
          className="bg-popover text-popover-foreground absolute right-0 z-30 mt-1 w-56 rounded-md border p-1 shadow-md"
        >
          <div className="flex items-center gap-2 px-2 py-1.5 text-sm">
            <span className="truncate font-medium">{user.username}</span>
            <Badge variant="outline" className="ml-auto">
              {user.role}
            </Badge>
          </div>
          <div className="bg-border my-1 h-px" />
          <button
            role="menuitem"
            className="hover:bg-accent flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm"
            onClick={() => {
              setOpen(false)
              setChanging(true)
            }}
          >
            <KeyRound className="size-4" /> Change password
          </button>
          <button
            role="menuitem"
            className="hover:bg-accent flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm"
            onClick={() => logout.mutate(undefined)}
          >
            <LogOut className="size-4" /> Sign out
          </button>
        </div>
      )}
      {changing && <ChangePasswordDialog onClose={() => setChanging(false)} />}
    </div>
  )
}

function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState("")
  const [next, setNext] = useState("")
  const [confirm, setConfirm] = useState("")
  const change = useChangePassword()
  const mismatch = confirm !== "" && confirm !== next
  const ready = current !== "" && passwordOk(next) && confirm === next

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" onMouseDown={onClose}>
      <form
        role="dialog"
        aria-label="Change password"
        className="bg-background grid w-full max-w-sm gap-4 rounded-lg border p-6 shadow-lg"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          if (ready) change.mutate({ current, next }, { onSuccess: onClose })
        }}
      >
        <div className="flex items-center">
          <h2 className="flex-1 text-base font-semibold">Change password</h2>
          <Button type="button" variant="ghost" size="icon" aria-label="Close" onClick={onClose}>
            <X />
          </Button>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="cp-current">Current password</Label>
          <Input
            id="cp-current"
            type="password"
            autoFocus
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="cp-new">New password</Label>
          <Input
            id="cp-new"
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
          <PasswordRules password={next} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="cp-confirm">Repeat the new password</Label>
          <Input
            id="cp-confirm"
            type="password"
            autoComplete="new-password"
            value={confirm}
            aria-invalid={mismatch || undefined}
            onChange={(e) => setConfirm(e.target.value)}
          />
          {mismatch && <p className="text-destructive text-xs">The passwords don't match.</p>}
        </div>
        {change.error && <ErrorMessage title="Not changed" error={change.error} />}
        <p className="text-muted-foreground text-xs">Your other signed-in browsers will be signed out.</p>
        <Button type="submit" disabled={!ready || change.isPending}>
          {change.isPending && <Loader2 className="animate-spin" />} Change password
        </Button>
      </form>
    </div>
  )
}

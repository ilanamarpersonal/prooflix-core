import { useState } from "react"
import { Loader2, LogIn, ShieldCheck } from "lucide-react"

import prooflixLogo from "@/assets/prooflix-logo.svg"
import prooflixLogoDark from "@/assets/prooflix-logo-dark.svg"
import { PasswordRules, passwordOk } from "@/components/auth/password-rules"
import { ErrorAlert } from "@/components/error-alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useLogin, useSetupAdmin } from "@/lib/api"

/**
 * The sign-in page. With no users yet (``setup``), it creates the first admin
 * instead: there is no built-in account or default password.
 */
export function LoginPage({ setup }: { setup: boolean }) {
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const login = useLogin()
  const create = useSetupAdmin()
  const action = setup ? create : login
  const mismatch = setup && confirm !== "" && confirm !== password
  const ready = username.trim() !== "" && password !== "" && (!setup || (passwordOk(password) && confirm === password))

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (ready) action.mutate({ username: username.trim(), password })
  }

  return (
    <div className="bg-muted/30 flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-sm gap-4 py-6">
        <CardHeader className="grid justify-items-center gap-3 px-6 text-center">
          <img src={prooflixLogo} alt="Prooflix" width={140} height={32} className="h-8 w-auto dark:hidden" />
          <img src={prooflixLogoDark} alt="Prooflix" width={140} height={32} className="hidden h-8 w-auto dark:block" />
          <CardTitle className="text-lg">{setup ? "Create the first admin" : "Sign in"}</CardTitle>
          {setup && (
            <p className="text-muted-foreground text-sm">
              No users exist yet. This account will be an admin: it sees every tab and manages users in the Users tab.
            </p>
          )}
        </CardHeader>
        <CardContent className="px-6">
          <form onSubmit={submit} className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="username">User name</Label>
              <Input
                id="username"
                autoFocus
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete={setup ? "new-password" : "current-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              {setup && <PasswordRules password={password} />}
            </div>
            {setup && (
              <div className="grid gap-1.5">
                <Label htmlFor="confirm">Repeat the password</Label>
                <Input
                  id="confirm"
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  aria-invalid={mismatch || undefined}
                  onChange={(e) => setConfirm(e.target.value)}
                />
                {mismatch && <p className="text-destructive text-xs">The passwords don't match.</p>}
              </div>
            )}
            {action.error && <ErrorAlert title={setup ? "Not created" : "Not signed in"} error={action.error} />}
            <Button type="submit" disabled={!ready || action.isPending}>
              {action.isPending ? <Loader2 className="animate-spin" /> : setup ? <ShieldCheck /> : <LogIn />}
              {setup ? "Create admin and sign in" : "Sign in"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}

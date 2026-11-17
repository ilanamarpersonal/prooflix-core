import { useState } from "react"
import { Ban, CheckCircle2, KeyRound, Loader2, Pencil, Plus, ShieldCheck, Trash2, UserRound, X } from "lucide-react"

import { PasswordRules, passwordOk } from "@/components/auth/password-rules"
import { ErrorAlert } from "@/components/error-alert"
import { PageHeader } from "@/components/page-header"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { api, useAuthStatus, useUserMutation, useUsers } from "@/lib/api"
import { SECTIONS } from "@/lib/tabs"
import type { AppUser } from "@/lib/types"
import { cn, formatDateTime } from "@/lib/utils"

const NEW = "\u0000new"
// the tabs a user can be given, in menu order (Users is for admins only)
const GIVABLE = SECTIONS.filter((s) => s.id !== "users")

/** Admins add users, set their role and the tabs they see, reset passwords, disable or remove them. */
export function UsersPage() {
  const users = useUsers()
  const auth = useAuthStatus()
  const me = auth.data?.user
  const [editing, setEditing] = useState<string | null>(null)

  if (auth.data && !auth.data.enabled)
    return (
      <div>
        <PageHeader title="Users" description="Users and sign-in are off on this server." />
        <p className="text-muted-foreground text-sm">
          Start the server without <code className="font-mono">PROOFLIX_AUTH=0</code> to require signing in.
        </p>
      </div>
    )

  return (
    <div>
      <PageHeader
        title="Users"
        description="Who can sign in, and which tabs each user sees. Admins see every tab and manage users here; a user sees only the tabs chosen for them. Passwords need at least 8 characters, a capital letter and a number."
        actions={
          <Button onClick={() => setEditing(NEW)} disabled={editing !== null}>
            <Plus /> Add user
          </Button>
        }
      />
      <div className="grid gap-4">
        {editing !== null && (
          <UserForm
            key={editing}
            user={editing === NEW ? null : (users.data?.find((u) => u.username === editing) ?? null)}
            me={me?.username ?? ""}
            onDone={() => setEditing(null)}
          />
        )}
        <Card className="gap-0 overflow-hidden py-0">
          <CardHeader className="border-b px-4 py-3">
            <CardTitle className="text-base">Users</CardTitle>
          </CardHeader>
          {users.error && (
            <div className="p-4">
              <ErrorAlert error={users.error} />
            </div>
          )}
          {users.isLoading ? (
            <Skeleton className="m-4 h-24" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Tabs</TableHead>
                  <TableHead>Last sign-in</TableHead>
                  <TableHead className="w-0" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {(users.data ?? []).map((u) => (
                  <UserRow
                    key={u.username}
                    user={u}
                    isMe={u.username === me?.username}
                    editing={editing === u.username}
                    onEdit={() => setEditing(u.username)}
                  />
                ))}
              </TableBody>
            </Table>
          )}
        </Card>
      </div>
    </div>
  )
}

function UserRow({
  user,
  isMe,
  editing,
  onEdit,
}: {
  user: AppUser
  isMe: boolean
  editing: boolean
  onEdit: () => void
}) {
  const remove = useUserMutation((name: string) => api.deleteUser(name))
  const toggle = useUserMutation((disabled: boolean) => api.updateUser(user.username, { disabled }))
  const error = remove.error ?? toggle.error
  return (
    <TableRow className={cn(editing && "bg-accent/40", user.disabled && "text-muted-foreground")}>
      <TableCell>
        <span className="flex items-center gap-2 font-medium">
          <UserRound className="size-4" /> {user.username}
          {isMe && <Badge variant="secondary">you</Badge>}
          {user.disabled && <Badge variant="outline">disabled</Badge>}
        </span>
        <span className="text-muted-foreground text-xs">added {formatDateTime(user.created_at)}</span>
      </TableCell>
      <TableCell>
        {user.role === "admin" ? (
          <Badge className="gap-1">
            <ShieldCheck className="size-3" /> admin
          </Badge>
        ) : (
          <Badge variant="outline">user</Badge>
        )}
      </TableCell>
      <TableCell className="max-w-96 whitespace-normal">
        {user.role === "admin" ? (
          <span className="text-muted-foreground text-xs">every tab, and Users</span>
        ) : user.tabs.length === 0 ? (
          <span className="text-destructive text-xs">no tabs: sees nothing yet</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {GIVABLE.filter((s) => user.tabs.includes(s.id)).map(({ id, label, icon: Icon }) => (
              <Badge key={id} variant="secondary" className="gap-1 font-normal">
                <Icon className="size-3" /> {label}
              </Badge>
            ))}
          </div>
        )}
      </TableCell>
      <TableCell className="text-sm">{user.last_login ? formatDateTime(user.last_login) : "never"}</TableCell>
      <TableCell>
        <div className="flex justify-end gap-1.5">
          <Button size="sm" variant="outline" onClick={onEdit} aria-label={`Edit ${user.username}`}>
            <Pencil />
          </Button>
          {!isMe && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => toggle.mutate(!user.disabled)}
              disabled={toggle.isPending}
              aria-label={user.disabled ? `Enable ${user.username}` : `Disable ${user.username}`}
              title={user.disabled ? "Enable: can sign in again" : "Disable: signs them out and blocks signing in"}
            >
              {user.disabled ? <CheckCircle2 /> : <Ban />}
            </Button>
          )}
          {!isMe && (
            <Button
              size="sm"
              variant="outline"
              aria-label={`Delete ${user.username}`}
              disabled={remove.isPending}
              onClick={() => window.confirm(`Delete the user ${user.username}?`) && remove.mutate(user.username)}
            >
              <Trash2 />
            </Button>
          )}
        </div>
        {error && <p className="text-destructive mt-1 max-w-64 text-right text-xs">{error.message}</p>}
      </TableCell>
    </TableRow>
  )
}

function UserForm({ user, me, onDone }: { user: AppUser | null; me: string; onDone: () => void }) {
  const [username, setUsername] = useState(user?.username ?? "")
  const [role, setRole] = useState<"admin" | "user">(user?.role ?? "user")
  const [tabs, setTabs] = useState<Set<string>>(new Set(user?.tabs ?? ["pipelines"]))
  const [password, setPassword] = useState("")
  const [resetting, setResetting] = useState(!user)
  const save = useUserMutation(async () => {
    const chosen = GIVABLE.map((s) => s.id).filter((t) => tabs.has(t))
    if (!user) return api.createUser({ username: username.trim(), password, role, tabs: chosen })
    return api.updateUser(user.username, { role, tabs: chosen, password: resetting && password ? password : null })
  })
  const isMe = user?.username === me
  const needsPassword = !user || (resetting && password !== "")
  const ready =
    (user || username.trim() !== "") && (!needsPassword || passwordOk(password)) && (!user ? password !== "" : true)

  const toggleTab = (id: string) =>
    setTabs((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="flex flex-row items-center gap-3 border-b px-4 py-3">
        <CardTitle className="flex-1 text-base">{user ? `Edit ${user.username}` : "Add user"}</CardTitle>
        <Button variant="ghost" size="sm" onClick={onDone}>
          <X /> Close
        </Button>
      </CardHeader>
      <CardContent className="grid gap-5 px-4 py-4 text-sm">
        <div className="flex flex-wrap items-start gap-6">
          <Field label="User name">
            <Input
              className="w-56"
              value={username}
              disabled={!!user}
              autoComplete="off"
              placeholder="e.g. dana"
              onChange={(e) => setUsername(e.target.value.toLowerCase())}
            />
            {!user && <span className="text-muted-foreground text-xs">3–32 lowercase letters, digits, . _ -</span>}
          </Field>
          <Field label="Role">
            <div role="radiogroup" className="flex gap-1.5">
              {(["user", "admin"] as const).map((r) => (
                <button
                  key={r}
                  type="button"
                  role="radio"
                  aria-checked={role === r}
                  disabled={isMe && r === "user"}
                  onClick={() => setRole(r)}
                  className={cn(
                    "rounded-md border px-3 py-1.5 text-sm disabled:opacity-50",
                    role === r
                      ? "border-primary bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-accent",
                  )}
                >
                  {r === "admin" ? "Admin" : "User"}
                </button>
              ))}
            </div>
            <span className="text-muted-foreground text-xs">
              {role === "admin" ? "Sees every tab and manages users" : "Sees only the tabs below"}
            </span>
          </Field>
          <Field label="Password">
            {user && !resetting ? (
              <Button variant="outline" size="sm" onClick={() => setResetting(true)}>
                <KeyRound /> Set a new password
              </Button>
            ) : (
              <>
                <Input
                  type="password"
                  className="w-56"
                  autoComplete="new-password"
                  value={password}
                  placeholder={user ? "New password" : ""}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <PasswordRules password={password} />
              </>
            )}
          </Field>
        </div>

        <div className="grid gap-2">
          <span className="font-medium">Tabs this user sees</span>
          {role === "admin" ? (
            <p className="text-muted-foreground text-xs">Admins see every tab, and the Users tab.</p>
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                {GIVABLE.map(({ id, label, icon: Icon }) => {
                  const on = tabs.has(id)
                  return (
                    <label
                      key={id}
                      className={cn(
                        "flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5",
                        on ? "border-primary bg-primary/10" : "text-muted-foreground",
                      )}
                    >
                      <input
                        type="checkbox"
                        className="accent-primary size-4"
                        checked={on}
                        onChange={() => toggleTab(id)}
                      />
                      <Icon className="size-4" /> {label}
                    </label>
                  )
                })}
              </div>
              <div className="flex gap-3 text-xs">
                <button className="underline" onClick={() => setTabs(new Set(GIVABLE.map((s) => s.id)))}>
                  all
                </button>
                <button className="underline" onClick={() => setTabs(new Set())}>
                  none
                </button>
                {tabs.size === 0 && <span className="text-destructive">With no tabs the user sees nothing.</span>}
              </div>
            </>
          )}
        </div>

        {save.error && <ErrorAlert title="Not saved" error={save.error} />}
        <div className="flex items-center gap-2">
          <Button onClick={() => save.mutate(undefined, { onSuccess: onDone })} disabled={!ready || save.isPending}>
            {save.isPending && <Loader2 className="animate-spin" />} {user ? "Save" : "Add user"}
          </Button>
          <Button variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          {user && resetting && password !== "" && (
            <span className="text-muted-foreground text-xs">
              Saving signs {isMe ? "your other browsers" : user.username} out.
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid content-start gap-1">
      <span className="text-muted-foreground text-xs">{label}</span>
      {children}
    </div>
  )
}

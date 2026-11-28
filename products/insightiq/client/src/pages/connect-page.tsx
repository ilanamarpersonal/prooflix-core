import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Check, Copy, KeyRound, Plug, PowerOff, ShieldCheck, Trash2 } from "lucide-react"

import { ErrorAlert } from "@prooflix/ui/app/error-alert"
import { PageHeader } from "@prooflix/ui/app/page-header"
import { Button } from "@prooflix/ui/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@prooflix/ui/components/ui/card"
import { Input } from "@prooflix/ui/components/ui/input"
import { Skeleton } from "@prooflix/ui/components/ui/skeleton"
import { productHref } from "@prooflix/ui/lib/products"
import { api, useMcpStatus, useMcpTokens } from "@/lib/api"
import { formatDateTime } from "@/lib/utils"
import { ObjectsNav } from "@/pages/sets-page"

function CopyBlock({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="grid gap-1">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground flex-1 text-xs font-medium">{label}</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={() => {
            void navigator.clipboard?.writeText(text).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            })
          }}
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />} {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className="bg-muted overflow-x-auto rounded-md p-2.5 font-mono text-xs leading-relaxed">{text}</pre>
    </div>
  )
}

/** How to add Prooflix to an AI app: Claude Code's command and the JSON other apps take. */
function Setup({ url, token }: { url: string; token: string | null }) {
  const bearer = token ? `Bearer ${token}` : null
  const claude =
    `claude mcp add --transport http prooflix ${url}` + (bearer ? ` --header "Authorization: ${bearer}"` : "")
  const config = JSON.stringify(
    { mcpServers: { prooflix: { type: "http", url, ...(bearer ? { headers: { Authorization: bearer } } : {}) } } },
    null,
    2,
  )
  return (
    <div className="grid gap-3">
      <CopyBlock label="Claude Code (in a terminal)" text={claude} />
      <CopyBlock label="Other apps that take an HTTP MCP server (JSON configuration)" text={config} />
    </div>
  )
}

/**
 * Connect an AI app (Claude Code, Claude Desktop, an agent) to the Object Model over MCP: the server's
 * address, personal tokens (shown once) and the setup to paste. The app then reads objects as the user,
 * only types opened to AI Assist, never sensitive values, and can only propose actions.
 */
export function ConnectPage() {
  const status = useMcpStatus()
  const [everyone, setEveryone] = useState(false)
  const tokens = useMcpTokens(everyone)
  const qc = useQueryClient()
  const [name, setName] = useState("Claude Code")
  const [days, setDays] = useState(90)
  const [created, setCreated] = useState<{ token: string; name: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<unknown>(null)
  const s = status.data

  const create = async () => {
    setBusy("create")
    setError(null)
    try {
      const t = await api.createMcpToken(name, days)
      setCreated({ token: t.token, name: t.name })
    } catch (e) {
      setError(e)
    } finally {
      setBusy(null)
      void qc.invalidateQueries({ queryKey: ["mcp", "tokens"] })
    }
  }
  const revoke = async (id: string) => {
    setBusy(id)
    setError(null)
    try {
      await api.revokeMcpToken(id)
    } catch (e) {
      setError(e)
    } finally {
      setBusy(null)
      void qc.invalidateQueries({ queryKey: ["mcp", "tokens"] })
    }
  }

  return (
    <div>
      <PageHeader
        title="Connect an AI app"
        description="Use the Object Model from Claude Code, Claude Desktop or your own agents over MCP. The app reads objects as you, only types an admin opened to AI Assist, never sensitive values, and can only propose actions (you apply them in Proposals)."
        actions={<ObjectsNav active="connect" />}
      />
      {status.error && <ErrorAlert title="The MCP server's status can't be read" error={status.error} />}
      {!!error && <ErrorAlert title="That didn't work" error={error} />}
      {status.isPending || !s ? (
        <Skeleton className="h-40" />
      ) : !s.enabled ? (
        <Card className="max-w-3xl">
          <CardContent className="grid justify-items-start gap-3 py-6 text-sm">
            <p className="flex items-center gap-2 font-medium">
              <PowerOff className="size-4" /> The MCP server is off
            </p>
            <p className="text-muted-foreground">
              {s.admin
                ? "Turn it on with PROOFLIX_MCP (on) in Settings & Management → System, then restart the server."
                : "Ask an admin to turn it on (PROOFLIX_MCP in Settings & Management → System)."}
            </p>
            {s.admin && (
              <Button asChild size="sm">
                <a href={productHref("settings", "/system")}>Open System settings</a>
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="grid max-w-3xl gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm">
                <Plug className="size-4" /> The server
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2 text-sm">
              <p>
                Address: <code className="bg-muted rounded px-1.5 py-0.5 text-xs">{s.url}</code>
              </p>
              <p className="text-muted-foreground flex items-start gap-2 text-xs">
                <ShieldCheck className="mt-0.5 size-3.5 shrink-0" /> Every call is in the audit log, at most 120 a
                minute per token. claude.ai's connectors need a public address and OAuth, which Prooflix doesn't offer
                yet.
              </p>
            </CardContent>
          </Card>

          {!s.users ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Set up your app</CardTitle>
                <p className="text-muted-foreground text-xs">Users are off on this server: no token is needed.</p>
              </CardHeader>
              <CardContent>
                <Setup url={s.url} token={null} />
              </CardContent>
            </Card>
          ) : (
            <>
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <KeyRound className="size-4" /> New personal token
                  </CardTitle>
                  <p className="text-muted-foreground text-xs">
                    One per app, so you can revoke it alone. The app acts as you; keep the token like a password.
                  </p>
                </CardHeader>
                <CardContent className="grid gap-4">
                  <form
                    className="flex flex-wrap items-end gap-2"
                    onSubmit={(e) => {
                      e.preventDefault()
                      void create()
                    }}
                  >
                    <label className="grid flex-1 gap-1 text-xs font-medium">
                      Name
                      <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Claude Code" />
                    </label>
                    <label className="grid gap-1 text-xs font-medium">
                      Expires after
                      <select
                        className="border-input bg-background h-9 rounded-md border px-2 text-sm"
                        value={days}
                        onChange={(e) => setDays(Number(e.target.value))}
                      >
                        {s.days.map((d) => (
                          <option key={d} value={d}>
                            {d} days
                          </option>
                        ))}
                      </select>
                    </label>
                    <Button type="submit" loading={busy === "create"} disabled={!name.trim()}>
                      <KeyRound /> Create token
                    </Button>
                  </form>
                  {created && (
                    <div className="grid gap-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
                      <p className="text-sm font-medium">“{created.name}”: copy it now, it isn't shown again.</p>
                      <CopyBlock label="Token" text={created.token} />
                      <Setup url={s.url} token={created.token} />
                      <Button size="sm" variant="ghost" className="justify-self-start" onClick={() => setCreated(null)}>
                        Done, hide it
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <div className="flex items-center gap-2">
                    <CardTitle className="flex-1 text-sm">{everyone ? "Everyone's tokens" : "Your tokens"}</CardTitle>
                    {s.admin && (
                      <label className="text-muted-foreground flex items-center gap-1.5 text-xs">
                        <input type="checkbox" checked={everyone} onChange={(e) => setEveryone(e.target.checked)} />
                        Everyone's (admin)
                      </label>
                    )}
                  </div>
                </CardHeader>
                <CardContent>
                  {tokens.error && <ErrorAlert title="The tokens can't be read" error={tokens.error} />}
                  {tokens.data && !tokens.data.length ? (
                    <p className="text-muted-foreground text-sm">No tokens yet.</p>
                  ) : (
                    <table className="w-full text-sm">
                      <thead className="text-muted-foreground text-left text-xs">
                        <tr>
                          <th className="py-1 font-medium">Name</th>
                          {everyone && <th className="py-1 font-medium">User</th>}
                          <th className="py-1 font-medium">Token</th>
                          <th className="py-1 font-medium">Last used</th>
                          <th className="py-1 font-medium">Expires</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {(tokens.data ?? []).map((t) => (
                          <tr key={t.id} className="border-t">
                            <td className="py-2">{t.name}</td>
                            {everyone && <td className="py-2">{t.username}</td>}
                            <td className="py-2 font-mono text-xs">pfx_…{t.hint}</td>
                            <td className="text-muted-foreground py-2 text-xs">
                              {t.last_used ? formatDateTime(t.last_used) : "never"}
                            </td>
                            <td className="text-muted-foreground py-2 text-xs">{formatDateTime(t.expires)}</td>
                            <td className="py-2 text-right">
                              <Button
                                size="sm"
                                variant="ghost"
                                loading={busy === t.id}
                                onClick={() => revoke(t.id)}
                                aria-label={`Revoke ${t.name}`}
                              >
                                <Trash2 /> Revoke
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </CardContent>
              </Card>
            </>
          )}
        </div>
      )}
    </div>
  )
}

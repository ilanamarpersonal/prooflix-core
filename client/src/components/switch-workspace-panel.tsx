import { useState } from "react"
import { Check, FolderOpen, Loader2, X } from "lucide-react"

import { ErrorAlert } from "@/components/error-alert"
import { FolderPicker } from "@/components/folder-picker"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { useActivateWorkspace, useForgetWorkspace, useWorkspaces } from "@/lib/api"
import { cn } from "@/lib/utils"

/** Choose the active workspace: the one pipelines, runs and schedules come from. */
export function SwitchWorkspacePanel({ onClose, onSwitched }: { onClose: () => void; onSwitched: () => void }) {
  const workspaces = useWorkspaces()
  const activator = useActivateWorkspace()
  const forgetter = useForgetWorkspace()
  const [other, setOther] = useState("")
  const [showOther, setShowOther] = useState(false)

  const activate = (path: string) => activator.mutate(path, { onSuccess: onSwitched })
  const busy = activator.isPending

  return (
    <Card className="mb-4 py-4">
      <CardContent className="grid grid-cols-[minmax(0,1fr)] gap-4 px-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h2 className="font-medium">Switch workspace</h2>
            <p className="text-muted-foreground text-sm">
              The active workspace is where pipelines, runs and schedules come from. Switching waits until no runs are
              going.
            </p>
          </div>
          <Button variant="ghost" size="icon" className="size-8 shrink-0" onClick={onClose} aria-label="Close switch workspace">
            <X />
          </Button>
        </div>

        {workspaces.error && <ErrorAlert error={workspaces.error} />}
        <ul className="divide-y rounded-md border">
          {workspaces.data?.workspaces.map((w) => (
            <li key={w.path} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className={cn("flex items-center gap-2 text-sm", w.active && "font-semibold")}>
                  {w.active ? <Check className="text-primary size-4" /> : <span className="size-4" />}
                  <span className="truncate">{w.name}</span>
                  {w.active && <Badge>Active</Badge>}
                  {w.default && <Badge variant="outline">Default</Badge>}
                  {!w.exists && <Badge variant="destructive">Missing</Badge>}
                </div>
                <code className="text-muted-foreground block truncate pl-6 font-mono text-xs" title={w.path}>
                  {w.path}
                </code>
              </div>
              {!w.active && (
                <div className="ml-auto flex gap-2 pl-6">
                  {!w.default && !w.in_root && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => forgetter.mutate(w.path)}
                      disabled={forgetter.isPending}
                      title="Remove from this list; the folder is kept"
                    >
                      Remove from list
                    </Button>
                  )}
                  <Button size="sm" onClick={() => activate(w.path)} disabled={busy || !w.exists}>
                    <span className="contents">{busy && activator.variables === w.path ? <Loader2 className="animate-spin" /> : <Check />}</span> Make
                    active
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>

        {activator.error && <ErrorAlert title="Could not switch" error={activator.error} />}
        {forgetter.error && <ErrorAlert title="Could not remove from the list" error={forgetter.error} />}

        {showOther ? (
          <div className="grid gap-2">
            <p className="text-sm font-medium">Open another folder as a workspace</p>
            <FolderPicker value={other} onChange={setOther} />
            <div className="flex gap-2">
              <Button onClick={() => activate(other)} disabled={busy || !other}>
                <span className="contents">{busy && activator.variables === other ? <Loader2 className="animate-spin" /> : <Check />}</span> Make this
                folder active
              </Button>
              <Button variant="ghost" onClick={() => setShowOther(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div>
            <Button variant="outline" onClick={() => setShowOther(true)}>
              <FolderOpen /> Open another folder…
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

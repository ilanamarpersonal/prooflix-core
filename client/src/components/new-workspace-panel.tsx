import { useState } from "react"
import { CheckCircle2, FolderPlus, Loader2, X } from "lucide-react"

import { ErrorAlert } from "@/components/error-alert"
import { FolderPicker } from "@/components/folder-picker"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useCreateWorkspace } from "@/lib/api"
import type { WorkspaceEntry } from "@/lib/types"

/** Create a workspace: a new folder, with pipelines/ and src/, in a folder the user chooses. */
export function NewWorkspacePanel({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("")
  const [parent, setParent] = useState("")
  const [created, setCreated] = useState<WorkspaceEntry | null>(null)
  const creator = useCreateWorkspace()

  const trimmed = name.trim()
  const sep = parent.includes("\\") ? "\\" : "/"
  const target = parent && trimmed ? `${parent.replace(/[\\/]+$/, "")}${sep}${trimmed}` : null

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!target) return
    creator.mutate(
      { parent, name: trimmed },
      {
        onSuccess: (w) => {
          setCreated(w)
          setName("")
        },
      },
    )
  }

  return (
    <Card className="mb-4 py-4">
      <CardContent className="px-4">
        <form className="grid grid-cols-[minmax(0,1fr)] gap-4" onSubmit={submit}>
          <div className="flex items-start justify-between gap-2">
            <div>
              <h2 className="font-medium">New workspace</h2>
              <p className="text-muted-foreground text-sm">
                Creates a folder with <code className="font-mono">pipelines/</code> and{" "}
                <code className="font-mono">src/</code> inside the location you choose.
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 shrink-0"
              onClick={onClose}
              aria-label="Close new workspace"
            >
              <X />
            </Button>
          </div>

          <div className="grid gap-4 md:grid-cols-[16rem_minmax(0,1fr)]">
            <div className="grid content-start gap-1.5">
              <Label htmlFor="workspace-name">Name</Label>
              <Input
                id="workspace-name"
                value={name}
                onChange={(e) => {
                  setName(e.target.value)
                  creator.reset()
                }}
                placeholder="my-workspace"
                autoFocus
                spellCheck={false}
              />
            </div>
            <div className="grid min-w-0 gap-1.5">
              <Label htmlFor="workspace-parent">Location</Label>
              <FolderPicker
                id="workspace-parent"
                value={parent}
                onChange={(p) => {
                  setParent(p)
                  creator.reset()
                }}
              />
            </div>
          </div>

          {target && (
            <p className="text-muted-foreground text-sm">
              Will create <code className="text-foreground font-mono break-all">{target}</code>
            </p>
          )}
          {creator.error && <ErrorAlert title="Could not create the workspace" error={creator.error} />}
          <div>
            <Button type="submit" disabled={!target || creator.isPending}>
              {creator.isPending ? <Loader2 className="animate-spin" /> : <FolderPlus />} Create workspace
            </Button>
          </div>

          {created && (
            <Alert>
              <CheckCircle2 className="text-status-succeeded" />
              <AlertTitle>
                Created <code className="font-mono">{created.name}</code>
              </AlertTitle>
              <AlertDescription>
                <span>
                  <code className="font-mono break-all">{created.path}</code> with{" "}
                  <code className="font-mono">pipelines/</code> and <code className="font-mono">src/</code>. It is not
                  active yet: use <strong>Switch workspace</strong> to make it active.
                </span>
              </AlertDescription>
            </Alert>
          )}
        </form>
      </CardContent>
    </Card>
  )
}

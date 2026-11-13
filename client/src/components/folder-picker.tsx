import { useEffect, useState } from "react"
import { ArrowUp, Folder, Loader2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useDirs } from "@/lib/api"

/**
 * Choose a folder on the server. A browser can't give the server a path of its
 * own, so this browses the server's folders: type a path, go up, or click a
 * sub-folder to go into it. An empty value starts at the folder holding the
 * active workspace.
 */
export function FolderPicker({
  id,
  value,
  onChange,
}: {
  id?: string
  value: string
  onChange: (path: string) => void
}) {
  const [draft, setDraft] = useState(value)
  const dirs = useDirs(value || undefined)

  useEffect(() => setDraft(value), [value])
  // start where the server suggests
  useEffect(() => {
    if (!value && dirs.data) onChange(dirs.data.path)
  }, [value, dirs.data, onChange])

  const commit = () => {
    const path = draft.trim()
    if (path && path !== value) onChange(path)
  }
  const listing = dirs.error ? null : dirs.data

  return (
    <div className="grid gap-2">
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label="Up one folder"
          title="Up one folder"
          disabled={!listing?.parent}
          onClick={() => listing?.parent && onChange(listing.parent)}
        >
          <ArrowUp />
        </Button>
        <Input
          id={id}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              commit()
            }
          }}
          placeholder="/path/to/folder"
          spellCheck={false}
          className="font-mono text-sm"
        />
      </div>
      {dirs.error ? (
        <p className="text-destructive text-xs">{dirs.error.message}</p>
      ) : (
        <ul className="max-h-44 overflow-auto rounded-md border p-1" aria-label="Sub-folders">
          {!listing ? (
            <li className="text-muted-foreground flex items-center gap-2 px-2 py-1 text-xs">
              <Loader2 className="size-3.5 animate-spin" /> Loading folders…
            </li>
          ) : listing.dirs.length === 0 ? (
            <li className="text-muted-foreground px-2 py-1 text-xs italic">No sub-folders</li>
          ) : (
            listing.dirs.map((d) => (
              <li key={d.path}>
                <button
                  type="button"
                  onClick={() => onChange(d.path)}
                  className="hover:bg-accent focus-visible:ring-ring flex w-full items-center gap-1.5 rounded-sm px-2 py-1 text-left text-sm outline-none focus-visible:ring-2"
                >
                  <Folder className="text-primary size-4 shrink-0" />
                  <span className="truncate">{d.name}</span>
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  )
}

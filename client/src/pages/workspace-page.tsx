import { useEffect, useMemo, useState } from "react"
import { Link, useNavigate, useSearchParams } from "react-router"
import {
  ChevronRight,
  Database,
  ExternalLink,
  FileText,
  Folder,
  FolderOpen,
  FolderInput,
  RefreshCw,
  Trash2,
} from "lucide-react"

import { ErrorAlert } from "@/components/error-alert"
import { ImportCodePanel } from "@/components/import-code-panel"
import { PageHeader } from "@/components/page-header"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { useRemoveWorkspaceItem, useWorkspaceFile, useWorkspaceTree } from "@/lib/api"
import { sqlTableFor } from "@/lib/sql-names"
import type { RemoveResult, WorkspaceNode } from "@/lib/types"
import { cn } from "@/lib/utils"

export function WorkspacePage() {
  const [params, setParams] = useSearchParams()
  const selected = params.get("path")
  const tree = useWorkspaceTree()
  const [importing, setImporting] = useState(false)
  const [removed, setRemoved] = useState<RemoveResult | null>(null)
  const remover = useRemoveWorkspaceItem()
  const selectedNode = useMemo(
    () => (selected && tree.data ? findNode(tree.data, selected) : null),
    [selected, tree.data],
  )

  const remove = (node: WorkspaceNode) => {
    const what =
      node.type === "dir"
        ? `the folder "${node.path}" and everything in it (${countFiles(node)} file${countFiles(node) === 1 ? "" : "s"})`
        : `the file "${node.path}"`
    if (!confirm(`Remove ${what} from the workspace?\n\nIt is moved to workspace/.prooflix/trash, so it can be recovered there.`))
      return
    remover.mutate(node.path, {
      onSuccess: (r) => {
        setRemoved(r)
        const parent = node.path.split("/").slice(0, -1).join("/")
        setParams(parent ? { path: parent } : {})
      },
    })
  }

  return (
    <>
      <PageHeader
        title="Workspace"
        description={
          tree.data ? (
            <>
              Files in <code className="font-mono">{tree.data.name}/</code>
            </>
          ) : undefined
        }
        actions={
          <>
            <Button variant="outline" onClick={() => tree.refetch()} disabled={tree.isFetching}>
              <RefreshCw className={cn(tree.isFetching && "animate-spin")} /> Refresh
            </Button>
            <Button onClick={() => setImporting(true)} disabled={importing}>
              <FolderInput /> Import code
            </Button>
          </>
        }
      />
      {importing && (
        <ImportCodePanel
          onClose={() => setImporting(false)}
          onImported={(r) => {
            // Show what was imported: a pipeline if there is one, else the first file.
            const first =
              r.written.find((p) => /(^|\/)pipelines\/[^/]+\.ya?ml$/.test(p)) ?? r.written[0]
            if (first) setParams({ path: first })
          }}
        />
      )}
      {tree.error && <ErrorAlert error={tree.error} />}
      {remover.error && <ErrorAlert title="Could not remove" error={remover.error} />}
      {removed && (
        <Alert className="mb-4">
          <Trash2 />
          <AlertTitle>
            Removed <code className="font-mono">{removed.path}</code>
            {removed.type === "dir" && ` (${removed.files} file${removed.files === 1 ? "" : "s"})`}
          </AlertTitle>
          <AlertDescription className="flex flex-wrap items-center gap-x-2">
            A copy is in <code className="font-mono">workspace/{removed.trash}</code>.
            <button type="button" className="underline" onClick={() => setRemoved(null)}>
              Dismiss
            </button>
          </AlertDescription>
        </Alert>
      )}
      <div className="grid gap-4 md:grid-cols-[16rem_minmax(0,1fr)]">
        <Card className="max-h-[70vh] overflow-auto py-2">
          {tree.isLoading ? (
            <Skeleton className="mx-2 h-64" />
          ) : (
            tree.data?.children?.map((n) => (
              <TreeNode
                key={n.path}
                node={n}
                depth={0}
                selected={selected}
                onSelect={(path) => setParams({ path })}
              />
            ))
          )}
        </Card>
        {selectedNode?.type === "dir" ? (
          <FolderViewer node={selectedNode} onRemove={remove} removing={remover.isPending} />
        ) : (
          <FileViewer
            path={selected}
            onRemove={selectedNode ? () => remove(selectedNode) : undefined}
            removing={remover.isPending}
          />
        )}
      </div>
    </>
  )
}

function TreeNode({
  node,
  depth,
  selected,
  onSelect,
}: {
  node: WorkspaceNode
  depth: number
  selected: string | null
  onSelect: (path: string) => void
}) {
  const containsSelected = !!selected && selected.startsWith(`${node.path}/`)
  const [open, setOpen] = useState(depth === 0 || containsSelected)
  // Open the folders leading to a file selected from elsewhere (e.g. after an import).
  useEffect(() => {
    if (containsSelected) setOpen(true)
  }, [containsSelected])
  const pad = { paddingLeft: `${depth * 14 + 8}px` }

  if (node.type === "file") {
    return (
      <button
        type="button"
        onClick={() => onSelect(node.path)}
        style={pad}
        className={cn(
          "hover:bg-accent flex w-full items-center gap-1.5 py-1 pr-2 text-left text-sm",
          selected === node.path && "bg-accent font-medium",
        )}
      >
        <span className="size-3.5 shrink-0" />
        <FileText className="text-muted-foreground size-4 shrink-0" />
        <span className="truncate">{node.name}</span>
      </button>
    )
  }
  const Icon = open ? FolderOpen : Folder
  return (
    <div>
      <div
        style={pad}
        className={cn(
          "hover:bg-accent flex w-full items-center gap-1.5 pr-2 text-sm",
          selected === node.path && "bg-accent font-medium",
        )}
      >
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-label={open ? `Collapse ${node.name}` : `Expand ${node.name}`}
          className="grid size-3.5 shrink-0 place-items-center py-1"
        >
          <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        </button>
        <button
          type="button"
          onClick={() => {
            if (selected === node.path) setOpen(!open)
            else {
              onSelect(node.path)
              setOpen(true)
            }
          }}
          className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left"
        >
          <Icon className="text-primary size-4 shrink-0" />
          <span className="truncate">{node.name}</span>
        </button>
      </div>
      {open &&
        node.children?.map((c) => (
          <TreeNode key={c.path} node={c} depth={depth + 1} selected={selected} onSelect={onSelect} />
        ))}
    </div>
  )
}

function findNode(node: WorkspaceNode, path: string): WorkspaceNode | null {
  if (node.path === path) return node
  for (const child of node.children ?? []) {
    if (path === child.path || path.startsWith(`${child.path}/`)) {
      const found = findNode(child, path)
      if (found) return found
    }
  }
  return null
}

function countFiles(node: WorkspaceNode): number {
  return node.type === "file" ? 1 : (node.children ?? []).reduce((n, c) => n + countFiles(c), 0)
}

function FolderViewer({
  node,
  onRemove,
  removing,
}: {
  node: WorkspaceNode
  onRemove: (node: WorkspaceNode) => void
  removing: boolean
}) {
  const files = countFiles(node)
  const isProject = node.children?.some((c) => c.type === "dir" && c.name === "pipelines")
  return (
    <Card className="min-w-0 gap-0 overflow-hidden py-0">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
        <FolderOpen className="text-primary size-4" />
        <code className="min-w-0 flex-1 truncate font-mono text-sm">{node.path}/</code>
        <Button variant="outline" size="sm" onClick={() => onRemove(node)} disabled={removing}>
          <Trash2 /> Remove folder
        </Button>
      </div>
      <div className="text-muted-foreground grid gap-1 p-4 text-sm">
        <p>
          {files} file{files === 1 ? "" : "s"} in {node.children?.length ?? 0} item
          {node.children?.length === 1 ? "" : "s"}.
        </p>
        {isProject && <p>This is a project: its pipelines are listed in the Pipelines tab.</p>}
        <p>Select a file in the tree to view it.</p>
      </div>
    </Card>
  )
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function FileViewer({
  path,
  onRemove,
  removing,
}: {
  path: string | null
  onRemove?: () => void
  removing?: boolean
}) {
  const file = useWorkspaceFile(path)
  const navigate = useNavigate()
  const lines = useMemo(() => file.data?.content?.split("\n") ?? [], [file.data?.content])

  if (!path) {
    return (
      <Card className="text-muted-foreground grid min-h-64 place-items-center text-sm">
        Select a file or folder.
      </Card>
    )
  }

  const pipelineId = /^pipelines\/([^/]+)\.ya?ml$/.exec(path)?.[1]
  const table = sqlTableFor(path)

  return (
    <Card className="min-w-0 gap-0 overflow-hidden py-0">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
        <code className="min-w-0 flex-1 truncate font-mono text-sm">{path}</code>
        {file.data && <span className="text-muted-foreground text-xs">{formatSize(file.data.size)}</span>}
        {pipelineId && (
          <Button variant="outline" size="sm" asChild>
            <Link to={`/pipelines/${pipelineId}`}>
              <ExternalLink /> Open in Pipelines
            </Link>
          </Button>
        )}
        {table && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate("/sql", { state: { sql: `SELECT *\nFROM ${table}\nLIMIT 100;` } })}
          >
            <Database /> Query in SQL Editor
          </Button>
        )}
        {onRemove && (
          <Button variant="outline" size="sm" onClick={onRemove} disabled={removing}>
            <Trash2 /> Remove
          </Button>
        )}
      </div>
      {file.error ? (
        <div className="p-4">
          <ErrorAlert title="Could not open file" error={file.error} />
        </div>
      ) : file.isLoading ? (
        <Skeleton className="m-4 h-64" />
      ) : file.data?.binary ? (
        <div className="text-muted-foreground p-6 text-sm">This is a binary file and can't be shown.</div>
      ) : (
        <div className="max-h-[70vh] overflow-auto">
          <table className="font-mono text-[13px] leading-relaxed">
            <tbody>
              {lines.map((line, i) => (
                <tr key={i}>
                  <td className="text-muted-foreground/70 sticky left-0 bg-card px-3 text-right align-top select-none">
                    {i + 1}
                  </td>
                  <td className="pr-4 whitespace-pre">{line || " "}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {file.data?.truncated && (
            <div className="text-muted-foreground border-t px-4 py-2 text-xs">
              Showing the first 1 MB of this file.
            </div>
          )}
        </div>
      )}
    </Card>
  )
}

import { useMemo, useState } from "react"
import { Link, useNavigate, useSearchParams } from "react-router"
import {
  ChevronRight,
  Database,
  ExternalLink,
  FileText,
  Folder,
  FolderOpen,
  RefreshCw,
} from "lucide-react"

import { ErrorAlert } from "@/components/error-alert"
import { PageHeader } from "@/components/page-header"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { useWorkspaceFile, useWorkspaceTree } from "@/lib/api"
import { sqlTableFor } from "@/lib/sql-names"
import type { WorkspaceNode } from "@/lib/types"
import { cn } from "@/lib/utils"

export function WorkspacePage() {
  const [params, setParams] = useSearchParams()
  const selected = params.get("path")
  const tree = useWorkspaceTree()

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
          <Button variant="outline" size="sm" onClick={() => tree.refetch()} disabled={tree.isFetching}>
            <RefreshCw className={cn(tree.isFetching && "animate-spin")} /> Refresh
          </Button>
        }
      />
      {tree.error && <ErrorAlert error={tree.error} />}
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
        <FileViewer path={selected} />
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
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        style={pad}
        className="hover:bg-accent flex w-full items-center gap-1.5 py-1 pr-2 text-left text-sm"
      >
        <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
        <Icon className="text-primary size-4 shrink-0" />
        <span className="truncate">{node.name}</span>
      </button>
      {open &&
        node.children?.map((c) => (
          <TreeNode key={c.path} node={c} depth={depth + 1} selected={selected} onSelect={onSelect} />
        ))}
    </div>
  )
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function FileViewer({ path }: { path: string | null }) {
  const file = useWorkspaceFile(path)
  const navigate = useNavigate()
  const lines = useMemo(() => file.data?.content?.split("\n") ?? [], [file.data?.content])

  if (!path) {
    return (
      <Card className="text-muted-foreground grid min-h-64 place-items-center text-sm">
        Select a file to view it.
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

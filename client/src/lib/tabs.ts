import { useCallback, useEffect, useState } from "react"
import { useLocation, useNavigate } from "react-router"
import {
  ArrowDownToLine,
  Database,
  DatabaseZap,
  FolderTree,
  UsersRound,
  Library,
  SlidersHorizontal,
  Workflow,
  type LucideIcon,
} from "lucide-react"

export type SectionId = "pipelines" | "ingestion" | "sql" | "workspace" | "catalog" | "clickhouse" | "system" | "users"

export interface Section {
  id: SectionId
  label: string
  icon: LucideIcon
  /** where the tab starts */
  home: string
  /** URL prefixes that belong to this tab */
  prefixes: string[]
}

/** The left menu and the tabs, in order. The first one is selected by default. */
export const SECTIONS: Section[] = [
  { id: "pipelines", label: "Pipelines", icon: Workflow, home: "/pipelines", prefixes: ["/pipelines", "/runs"] },
  { id: "ingestion", label: "Ingestion", icon: ArrowDownToLine, home: "/ingestion", prefixes: ["/ingestion"] },
  { id: "sql", label: "SQL Editor", icon: Database, home: "/sql", prefixes: ["/sql"] },
  { id: "catalog", label: "Catalog", icon: Library, home: "/catalog", prefixes: ["/catalog"] },
  { id: "workspace", label: "Workspace", icon: FolderTree, home: "/workspace", prefixes: ["/workspace"] },
  { id: "clickhouse", label: "ClickHouse", icon: DatabaseZap, home: "/clickhouse", prefixes: ["/clickhouse"] },
  { id: "system", label: "System", icon: SlidersHorizontal, home: "/system", prefixes: ["/system"] },
  { id: "users", label: "Users", icon: UsersRound, home: "/users", prefixes: ["/users"] },
]

/** The sections a user sees: their tabs when sign-in is on, else every tab but Users. */
export function visibleSections(allowed: string[] | null): Section[] {
  return allowed ? SECTIONS.filter((s) => allowed.includes(s.id)) : SECTIONS.filter((s) => s.id !== "users")
}

export const DEFAULT_SECTION: SectionId = SECTIONS[0].id

export const sectionById = (id: SectionId) => SECTIONS.find((s) => s.id === id)!

export function sectionFor(pathname: string): Section | undefined {
  return SECTIONS.find((s) => s.prefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`)))
}

/** The page each tab was last showing, so switching back restores it. */
type TabPaths = Partial<Record<SectionId, string>>

const STORAGE_KEY = "prooflix-tab-paths"

function loadPaths(): TabPaths {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === "object") return parsed as TabPaths
    }
  } catch {
    /* storage unavailable or corrupt */
  }
  return {}
}

export interface Tabs {
  /** the selected tab; undefined only while redirecting from "/" */
  active?: SectionId
  pathOf: (id: SectionId) => string
  select: (id: SectionId) => void
}

/**
 * All tabs are always shown; the URL decides which one is selected, and each
 * tab remembers the page it was on.
 */
export function useTabs(): Tabs {
  const location = useLocation()
  const navigate = useNavigate()
  const [paths, setPaths] = useState<TabPaths>(loadPaths)
  const active = sectionFor(location.pathname)?.id

  useEffect(() => {
    if (!active) return
    setPaths((prev) => ({ ...prev, [active]: location.pathname + location.search }))
  }, [active, location.pathname, location.search])

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(paths))
    } catch {
      /* storage unavailable */
    }
  }, [paths])

  const pathOf = useCallback((id: SectionId) => paths[id] ?? sectionById(id).home, [paths])

  const select = useCallback(
    (id: SectionId) => {
      // Pipelines always opens its start page (pipelines and all runs); other
      // tabs reopen the page they were on, or their start page when already open.
      navigate(id === active || id === "pipelines" ? sectionById(id).home : pathOf(id))
    },
    [navigate, pathOf, active],
  )

  return { active, pathOf, select }
}

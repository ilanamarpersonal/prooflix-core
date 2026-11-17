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

/** Menu groups, in order: building pipelines, working with data, running the server. */
export const GROUPS = [
  { id: "build", label: "Build" },
  { id: "data", label: "Data" },
  { id: "admin", label: "Admin" },
] as const
export type GroupId = (typeof GROUPS)[number]["id"]

export interface Section {
  id: SectionId
  label: string
  icon: LucideIcon
  group: GroupId
  /** where the tab starts */
  home: string
  /** URL prefixes that belong to this tab */
  prefixes: string[]
}

/** The menu, grouped and in order. The first one a user has is their start page. */
export const SECTIONS: Section[] = [
  {
    id: "pipelines",
    label: "Pipelines",
    icon: Workflow,
    group: "build",
    home: "/pipelines",
    prefixes: ["/pipelines", "/runs"],
  },
  {
    id: "ingestion",
    label: "Ingestion",
    icon: ArrowDownToLine,
    group: "build",
    home: "/ingestion",
    prefixes: ["/ingestion"],
  },
  {
    id: "workspace",
    label: "Workspace",
    icon: FolderTree,
    group: "build",
    home: "/workspace",
    prefixes: ["/workspace"],
  },
  { id: "sql", label: "SQL Editor", icon: Database, group: "data", home: "/sql", prefixes: ["/sql"] },
  { id: "catalog", label: "Catalog", icon: Library, group: "data", home: "/catalog", prefixes: ["/catalog"] },
  {
    id: "clickhouse",
    label: "ClickHouse",
    icon: DatabaseZap,
    group: "data",
    home: "/clickhouse",
    prefixes: ["/clickhouse"],
  },
  { id: "system", label: "System", icon: SlidersHorizontal, group: "admin", home: "/system", prefixes: ["/system"] },
  { id: "users", label: "Users", icon: UsersRound, group: "admin", home: "/users", prefixes: ["/users"] },
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

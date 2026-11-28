import { createContext, useCallback, useContext, useEffect, useState } from "react"
import { useLocation, useNavigate } from "react-router"

import { useAuthStatus } from "../auth/api"
import { productHref, type Product } from "../lib/products"
import { SCREENS } from "./screens"

/** A tab of a product: its menu entry, start page and the URLs that belong to it. */
export interface Section {
  id: string
  label: string
  icon: (props: { className?: string }) => React.ReactNode
  group: string
  /** the colour of its menu tile; none for an icon that is a tile already (AI Assist) */
  color?: string
  /** where the tab starts */
  home: string
  /** URL prefixes that belong to this tab */
  prefixes: string[]
}

interface SectionsValue {
  productId: Product["id"]
  /** the tabs of this product the user sees */
  sections: Section[]
}

const SectionsContext = createContext<SectionsValue>({ productId: "portal", sections: [] })

/** Gives the shared screens (page header, AI Assist, search) the product's tabs. */
export function SectionsProvider({ productId, sections, children }: SectionsValue & { children: React.ReactNode }) {
  return <SectionsContext.Provider value={{ productId, sections }}>{children}</SectionsContext.Provider>
}

export const useSections = () => useContext(SectionsContext)

export function sectionIn<S extends Section>(sections: S[], pathname: string): S | undefined {
  return sections.find((s) => s.prefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`)))
}

/** The tab the current page belongs to. */
export function useCurrentSection(): Section | undefined {
  const { sections } = useSections()
  return sectionIn(sections, useLocation().pathname)
}

/** The tabs a user sees: their tabs when sign-in is on, else every tab but Users. */
export function visibleSections<S extends Section>(sections: S[], allowed: string[] | null): S[] {
  return allowed ? sections.filter((s) => allowed.includes(s.id)) : sections.filter((s) => s.id !== "users")
}

/**
 * A screen of any product by its tab id, when this user has it: its name and how to open it (a
 * route in this product, or the other product's page). Null otherwise.
 */
export function useScreens(): (id: string) => { label: string; open: () => void } | null {
  const { productId, sections } = useSections()
  const navigate = useNavigate()
  const auth = useAuthStatus().data
  return useCallback(
    (id: string) => {
      const own = sections.find((s) => s.id === id)
      if (own) return { label: own.label, open: () => navigate(own.home) }
      const visible = !auth?.enabled || !!auth.user?.visible_tabs.includes(id)
      const other = SCREENS.find((s) => s.id === id)
      if (!other || !visible || other.product === productId) return null
      return { label: other.label, open: () => window.location.assign(productHref(other.product, other.home)) }
    },
    [sections, navigate, auth, productId],
  )
}

/**
 * The URL decides which tab is selected, and each tab remembers the page it was on (in the
 * browser, per product). Tabs in ``alwaysHome`` always open their start page.
 */
export function useTabs<S extends Section>(sections: S[], storageKey: string, alwaysHome: string[] = []) {
  const location = useLocation()
  const navigate = useNavigate()
  const [paths, setPaths] = useState<Record<string, string>>(() => loadPaths(storageKey))
  const active = sectionIn(sections, location.pathname)?.id as S["id"] | undefined

  useEffect(() => {
    if (!active) return
    setPaths((prev) => ({ ...prev, [active]: location.pathname + location.search }))
  }, [active, location.pathname, location.search])

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(paths))
    } catch {
      /* storage unavailable */
    }
  }, [paths, storageKey])

  const home = useCallback((id: S["id"]) => sections.find((s) => s.id === id)?.home ?? "/", [sections])
  const pathOf = useCallback((id: S["id"]) => paths[id] ?? home(id), [paths, home])
  const select = useCallback(
    (id: S["id"]) => navigate(id === active || alwaysHome.includes(id) ? home(id) : pathOf(id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [navigate, pathOf, home, active, alwaysHome.join()],
  )
  return { active, pathOf, select }
}

function loadPaths(key: string): Record<string, string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "{}")
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

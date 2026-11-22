import { useEffect, useState } from "react"
import { Navigate, Outlet } from "react-router"
import { useQueryClient } from "@tanstack/react-query"
import { ChevronDown, Loader2, Moon, PanelLeftClose, PanelLeftOpen, Search, Sun } from "lucide-react"

import prooflixLogo from "@/assets/prooflix-logo.svg"
import prooflixLogoDark from "@/assets/prooflix-logo-dark.svg"
import { LoginPage } from "@/components/auth/login-page"
import { AiAssistDockPanel, AiAssistDockProvider, AiAssistToggle } from "@/components/ai-assist-dock"
import { CommandPalette } from "@/components/command-palette"
import { UserMenu } from "@/components/auth/user-menu"
import { ErrorAlert } from "@/components/error-alert"
import { Button } from "@/components/ui/button"
import { UNAUTHORIZED_EVENT, useAuthStatus } from "@/lib/api"
import { GROUPS, visibleSections, useTabs, type Section } from "@/lib/tabs"
import type { AppUser } from "@/lib/types"
import { IconTile } from "@/components/icon-tile"
import { cn } from "@/lib/utils"

/** Signs the user in first when sign-in is on, then shows the app with their tabs. */
export function AppShell() {
  const qc = useQueryClient()
  const auth = useAuthStatus()

  // any API call answering 401: the session ended, so check again (shows the login page)
  useEffect(() => {
    const onUnauthorized = () => void qc.invalidateQueries({ queryKey: ["auth"] })
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
  }, [qc])

  if (auth.isLoading)
    return (
      <div className="flex min-h-svh items-center justify-center">
        <Loader2 className="text-muted-foreground size-6 animate-spin" />
      </div>
    )
  if (auth.error || !auth.data)
    return (
      <div className="mx-auto max-w-lg p-6">
        <ErrorAlert title="Prooflix server is not reachable" error={auth.error ?? new Error("no answer")} />
      </div>
    )
  const { enabled, setup_needed, user } = auth.data
  if (enabled && !user) return <LoginPage setup={setup_needed} />
  return <Shell sections={visibleSections(enabled && user ? user.visible_tabs : null)} user={enabled ? user : null} />
}

const COLLAPSED_KEY = "prooflix-sidebar-collapsed"
const GROUPS_KEY = "prooflix-menu-closed-groups"

function loadClosedGroups(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(GROUPS_KEY) ?? "[]")
    return new Set(Array.isArray(raw) ? raw.filter((x) => typeof x === "string") : [])
  } catch {
    return new Set()
  }
}

function loadCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1"
  } catch {
    return false
  }
}

function Shell({ sections, user }: { sections: Section[]; user: AppUser | null }) {
  const tabs = useTabs()
  const [collapsed, setCollapsed] = useState(loadCollapsed)
  const [paletteOpen, setPaletteOpen] = useState(false)

  const toggleCollapsed = () =>
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSED_KEY, c ? "0" : "1")
      } catch {
        /* storage unavailable */
      }
      return !c
    })

  // Ctrl+K / Cmd+K opens the command palette from anywhere
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        setPaletteOpen((o) => !o)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  return (
    <AiAssistDockProvider>
      <div className="flex min-h-svh flex-col">
        {/* full-width top bar: logo, search, user */}
        <header className="bg-background sticky top-0 z-40 flex h-14 shrink-0 items-center gap-2 border-b px-4">
          <div className="mr-2 flex shrink-0 items-center">
            {/* the wordmark's navy letters, swapped for light ones in dark mode */}
            <img src={prooflixLogo} alt="Prooflix" width={105} height={24} className="h-6 w-auto dark:hidden" />
            <img
              src={prooflixLogoDark}
              alt="Prooflix"
              width={105}
              height={24}
              className="hidden h-6 w-auto dark:block"
            />
          </div>
          {/* on small screens the menu sits in the top bar, as icons */}
          <nav className="flex items-center gap-0.5 overflow-x-auto md:hidden" aria-label="Sections">
            {sections.map(({ id, label, icon, color }) => (
              <button
                key={id}
                type="button"
                onClick={() => tabs.select(id)}
                aria-label={label}
                title={label}
                aria-current={tabs.active === id ? "page" : undefined}
                className={cn("rounded-md p-1.5", tabs.active === id && "bg-accent")}
              >
                <IconTile icon={icon} color={color} />
              </button>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <AiAssistToggle />
            <SearchButton onClick={() => setPaletteOpen(true)} />
            {user && <UserMenu user={user} />}
            <div className="md:hidden">
              <ThemeToggle compact />
            </div>
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          <aside
            className={cn(
              "bg-sidebar text-sidebar-foreground border-sidebar-border sticky top-14 hidden h-[calc(100svh-3.5rem)] shrink-0 flex-col border-r pt-3 transition-[width] md:flex",
              collapsed ? "w-14" : "w-56",
            )}
          >
            <SideNav sections={sections} active={tabs.active} collapsed={collapsed} onSelect={tabs.select} />
            <div className={cn("mt-auto grid gap-1 p-2", collapsed && "justify-items-center")}>
              <ThemeToggle compact={collapsed} />
              <Button
                variant="ghost"
                size={collapsed ? "icon" : "sm"}
                onClick={toggleCollapsed}
                className={collapsed ? "" : "w-full justify-start"}
                aria-label={collapsed ? "Expand the menu" : "Collapse the menu"}
                title={collapsed ? "Expand the menu" : "Collapse the menu"}
              >
                {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
                {!collapsed && "Collapse"}
              </Button>
            </div>
          </aside>

          <main className="w-full min-w-0 flex-1 p-4 md:p-6">
            {sections.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                No tabs have been given to your account yet. Ask an admin to choose the tabs you can see.
              </p>
            ) : tabs.active && sections.some((s) => s.id === tabs.active) ? (
              <Outlet />
            ) : (
              // the start page is the first section the user has (Pipelines when they have it)
              <Navigate to={sections[0].home} replace />
            )}
          </main>
          <AiAssistDockPanel />
        </div>
        {paletteOpen && <CommandPalette sections={sections} user={user} onClose={() => setPaletteOpen(false)} />}
      </div>
    </AiAssistDockProvider>
  )
}

/** The one menu: sections grouped (Build, Data, Admin); icons only when collapsed. */
function SideNav({
  sections,
  active,
  collapsed,
  onSelect,
}: {
  sections: Section[]
  active?: string
  collapsed: boolean
  onSelect: (id: Section["id"]) => void
}) {
  // groups the user closed (all open by default), remembered in the browser
  const [closed, setClosed] = useState<Set<string>>(loadClosedGroups)
  const toggleGroup = (id: string) =>
    setClosed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      try {
        localStorage.setItem(GROUPS_KEY, JSON.stringify([...next]))
      } catch {
        /* storage unavailable */
      }
      return next
    })
  return (
    <nav className="flex min-h-0 flex-col gap-3 overflow-y-auto px-2" aria-label="Sections">
      {GROUPS.map((g) => {
        const items = sections.filter((s) => s.group === g.id)
        if (!items.length) return null
        return (
          <div key={g.id} className="grid gap-0.5">
            {collapsed ? (
              <div className="bg-sidebar-border mx-2 my-1 h-px" aria-hidden />
            ) : (
              <button
                type="button"
                onClick={() => toggleGroup(g.id)}
                aria-expanded={!closed.has(g.id)}
                className="text-muted-foreground hover:text-foreground flex items-center gap-1 rounded-md px-3 pb-1 text-left text-xs font-medium"
              >
                <ChevronDown className={cn("size-3 transition-transform", closed.has(g.id) && "-rotate-90")} />
                {g.label}
                {closed.has(g.id) && <span className="ml-auto font-normal">{items.length}</span>}
              </button>
            )}
            {/* the icon rail always shows every item; the full menu hides a closed group's items,
                except the page you are on */}
            {items
              .filter((s) => collapsed || !closed.has(g.id) || s.id === active)
              .map(({ id, label, icon, color }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => onSelect(id)}
                  title={collapsed ? label : undefined}
                  aria-label={collapsed ? label : undefined}
                  aria-current={active === id ? "page" : undefined}
                  className={cn(
                    "hover:bg-sidebar-accent flex items-center gap-2.5 rounded-md py-1.5 text-left text-sm",
                    collapsed ? "justify-center px-0" : "px-3",
                    active === id && "bg-sidebar-accent font-medium",
                  )}
                >
                  <IconTile icon={icon} color={color} />
                  {!collapsed && label}
                </button>
              ))}
          </div>
        )
      })}
    </nav>
  )
}

function SearchButton({ onClick }: { onClick: () => void }) {
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-muted-foreground hover:bg-accent hover:text-foreground flex h-8 items-center gap-2 rounded-md border px-2.5 text-sm sm:w-64"
      aria-label="Search and run commands"
    >
      <Search className="size-4" />
      <span className="hidden sm:inline">Search or run a command</span>
      <kbd className="bg-muted ml-auto hidden rounded px-1.5 font-mono text-xs sm:inline">{mac ? "⌘K" : "Ctrl K"}</kbd>
    </button>
  )
}

function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"))
  const toggle = () => {
    const next = !dark
    setDark(next)
    document.documentElement.classList.toggle("dark", next)
    try {
      localStorage.setItem("prooflix-theme", next ? "dark" : "light")
    } catch {
      /* storage unavailable */
    }
  }
  const Icon = dark ? Sun : Moon
  return (
    <Button
      variant="ghost"
      size={compact ? "icon" : "sm"}
      onClick={toggle}
      className={compact ? "" : "w-full justify-start"}
      aria-label="Toggle theme"
    >
      <Icon />
      {!compact && (dark ? "Light mode" : "Dark mode")}
    </Button>
  )
}

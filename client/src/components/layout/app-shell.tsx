import { useState } from "react"
import { Navigate, NavLink, Outlet } from "react-router"
import { ChevronRight, Moon, Sun } from "lucide-react"

import prooflixMark from "@/assets/prooflix-mark.svg"
import { Button } from "@/components/ui/button"
import { usePipelines } from "@/lib/api"
import { DEFAULT_SECTION, SECTIONS, useTabs, type Tabs } from "@/lib/tabs"
import { cn } from "@/lib/utils"

export function AppShell() {
  const tabs = useTabs()

  return (
    <div className="flex min-h-svh flex-col">
      {/* full-width top bar with the logo */}
      <header className="bg-background sticky top-0 z-20 flex h-14 shrink-0 items-center gap-1 border-b px-4">
        <div className="mr-3 flex items-center gap-2 font-semibold tracking-tight">
          <img src={prooflixMark} alt="" className="size-7" />
          Prooflix
        </div>
        {/* on small screens the menu sits in the top bar */}
        <nav className="flex items-center gap-1 md:hidden">
          {SECTIONS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => tabs.select(id)}
              aria-label={label}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2 py-1 text-sm",
                tabs.active === id && "bg-accent font-medium",
              )}
            >
              <Icon className="size-4" />
              <span className="hidden sm:inline">{label}</span>
            </button>
          ))}
        </nav>
        <div className="ml-auto md:hidden">
          <ThemeToggle compact />
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="bg-sidebar text-sidebar-foreground border-sidebar-border sticky top-14 hidden h-[calc(100svh-3.5rem)] w-56 shrink-0 flex-col border-r pt-3 md:flex">
          <nav className="flex min-h-0 flex-col gap-1 overflow-y-auto px-2">
            {SECTIONS.map(({ id, label, icon: Icon }) =>
              id === "pipelines" ? (
                <PipelinesMenu key={id} tabs={tabs} label={label} icon={Icon} />
              ) : (
                <button
                  key={id}
                  type="button"
                  onClick={() => tabs.select(id)}
                  className={cn(
                    "hover:bg-sidebar-accent flex items-center gap-2 rounded-md px-3 py-2 text-left text-sm",
                    tabs.active === id && "bg-sidebar-accent font-medium",
                  )}
                >
                  <Icon className="size-4" />
                  {label}
                </button>
              ),
            )}
          </nav>
          <div className="mt-auto p-2">
            <ThemeToggle />
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <TabBar tabs={tabs} />
          <main className="w-full min-w-0 flex-1 p-4 md:p-6">
            {tabs.active ? <Outlet /> : <Navigate to={tabs.pathOf(DEFAULT_SECTION)} replace />}
          </main>
        </div>
      </div>
    </div>
  )
}

const PIPELINES_OPEN_KEY = "prooflix-menu-pipelines-open"

/**
 * The Pipelines menu item, with a button that shows the list of pipelines
 * under it. Clicking a pipeline opens it in the Pipelines tab.
 */
function PipelinesMenu({
  tabs,
  label,
  icon: Icon,
}: {
  tabs: Tabs
  label: string
  icon: React.ComponentType<{ className?: string }>
}) {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(PIPELINES_OPEN_KEY) !== "false"
    } catch {
      return true
    }
  })
  const pipelines = usePipelines()
  const toggle = () => {
    setOpen(!open)
    try {
      localStorage.setItem(PIPELINES_OPEN_KEY, String(!open))
    } catch {
      /* storage unavailable */
    }
  }
  const count = pipelines.data?.length

  return (
    <div>
      <div
        className={cn(
          "hover:bg-sidebar-accent flex items-center rounded-md text-sm",
          tabs.active === "pipelines" && "bg-sidebar-accent font-medium",
        )}
      >
        <button
          type="button"
          onClick={() => tabs.select("pipelines")}
          className="flex min-w-0 flex-1 items-center gap-2 py-2 pl-3 text-left"
        >
          <Icon className="size-4" />
          {label}
        </button>
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-label={open ? "Hide the list of pipelines" : "Show the list of pipelines"}
          title={open ? "Hide the list of pipelines" : "Show the list of pipelines"}
          className="text-muted-foreground hover:text-foreground mr-1 flex items-center gap-1 rounded px-1.5 py-1 text-xs"
        >
          {count !== undefined && <span className="tabular-nums">{count}</span>}
          <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        </button>
      </div>
      {open && (
        <div className="mt-0.5 ml-5 flex flex-col border-l pl-2">
          {pipelines.isLoading ? (
            <span className="text-muted-foreground px-2 py-1 text-xs">Loading…</span>
          ) : !count ? (
            <span className="text-muted-foreground px-2 py-1 text-xs italic">No pipelines yet</span>
          ) : (
            pipelines.data!.map((p) => (
              <NavLink
                key={p.id}
                to={`/pipelines/${p.id}`}
                title={p.description ?? p.name}
                className={({ isActive }) =>
                  cn(
                    "hover:bg-sidebar-accent flex items-center gap-2 truncate rounded-md px-2 py-1 text-xs",
                    isActive ? "bg-sidebar-accent text-foreground font-medium" : "text-muted-foreground",
                  )
                }
              >
                <span
                  className={cn("size-1.5 shrink-0 rounded-full", p.valid ? "bg-status-succeeded" : "bg-status-failed")}
                  aria-label={p.valid ? "valid" : "has errors"}
                />
                <span className="truncate">{p.name}</span>
              </NavLink>
            ))
          )}
        </div>
      )}
    </div>
  )
}

/** All tabs, always shown above the content; the selected one is highlighted. */
function TabBar({ tabs }: { tabs: Tabs }) {
  return (
    <div
      role="tablist"
      aria-label="Sections"
      className="bg-muted/40 sticky top-14 z-10 flex h-10 shrink-0 items-end gap-px overflow-x-auto border-b px-2"
    >
      {SECTIONS.map(({ id, label, icon: Icon }) => {
        const active = tabs.active === id
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => tabs.select(id)}
            className={cn(
              "-mb-px flex h-9 shrink-0 items-center gap-2 rounded-t-md border border-b-0 px-4 text-sm",
              active
                ? "bg-background border-border text-foreground font-medium"
                : "text-muted-foreground hover:text-foreground hover:bg-background/60 border-transparent",
            )}
          >
            <Icon className="size-4" />
            {label}
          </button>
        )
      })}
    </div>
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

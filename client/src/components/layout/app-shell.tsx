import { useState } from "react"
import { Navigate, Outlet } from "react-router"
import { Moon, Sun } from "lucide-react"

import prooflixMark from "@/assets/prooflix-mark.svg"
import { Button } from "@/components/ui/button"
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
          <nav className="flex flex-col gap-1 px-2">
            {SECTIONS.map(({ id, label, icon: Icon }) => (
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
            ))}
          </nav>
          <div className="mt-auto p-2">
            <ThemeToggle />
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <TabBar tabs={tabs} />
          <main className="mx-auto w-full max-w-7xl min-w-0 flex-1 p-4 md:p-8">
            {tabs.active ? <Outlet /> : <Navigate to={tabs.pathOf(DEFAULT_SECTION)} replace />}
          </main>
        </div>
      </div>
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
